import { createHash } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { DATA_DIR } from './config.ts'
import { all, get, type Channel, type Song, type Style, type Video, type VideoStatus, type Visual } from './db.ts'
import { capacity, hasFailedVideo, type Capacity } from './jobs.ts'
import { ACCEPTED_EXT } from './library.ts'

// ── html`` com escape automático ────────────────────────────────────

export class Html {
  readonly value: string
  constructor(value: string) {
    this.value = value
  }
}

type Value = Html | string | number | null | undefined | false | Value[]

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function render(value: Value): string {
  if (value instanceof Html) return value.value
  if (Array.isArray(value)) return value.map(render).join('')
  if (value === null || value === undefined || value === false) return ''
  return String(value).replace(/[&<>"']/g, c => ESCAPES[c]!)
}

export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = strings[0]!
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1]
  })
  return new Html(out)
}

// ── Formatação ──────────────────────────────────────────────────────

/** 3725 → "1:02:05"; também é o formato de timestamp da descrição do YouTube. */
function clock(seconds: number): string {
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60))
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

function bytes(n: number): string {
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`
  if (n < 2 ** 20) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${Math.round(n / 2 ** 20)} MB`
}

/** SQLite guarda UTC "YYYY-MM-DD HH:MM:SS"; mostra no fuso do servidor (TZ). */
function when(sqlite: string | null): string {
  if (!sqlite) return '—'
  return new Date(`${sqlite.replace(' ', 'T')}Z`).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

/** Data sem fuso guardada como "YYYY-MM-DD" (agenda/publicação) → "05/10/2026". */
function day(date: string | null): string {
  if (!date) return '—'
  const [y, m, d] = date.split('-')
  return `${d}/${m}/${y}`
}

/** Dia no fuso do servidor, no formato do <input type="date"> ("YYYY-MM-DD"). */
function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const styleName = (style: string) => style || 'sem estilo'
const count = (n: number) => (n === Infinity ? '∞' : String(n))
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`

// ── Layout ──────────────────────────────────────────────────────────

/** Muda quando qualquer coisa relevante muda; o JS recarrega a página quando ela muda. */
export function stateSignature(): string {
  const { sig } = get<{ sig: string }>(
    `SELECT (SELECT COUNT(*) FROM channels) || '|' ||
            (SELECT COUNT(*) || '-' || COALESCE(MAX(id), 0) FROM songs WHERE deleted_at IS NULL) || '|' ||
            (SELECT COALESCE(group_concat(id || status, ','), '') FROM visuals WHERE deleted_at IS NULL) || '|' ||
            (SELECT COALESCE(group_concat(id || ':' || status || ':' || file_deleted || ':' || visual_id || ':' ||
                      COALESCE(thumbnail_visual_id, '') || ':' || COALESCE(approved_at, '') || ':' ||
                      COALESCE(downloaded_at, '') || ':' || COALESCE(planned_date, '') || ':' ||
                      COALESCE(published_date, '') || ':' || COALESCE(youtube_url, ''), ','), '') FROM videos) || '|' ||
            -- Ordem/troca de faixas dos rascunhos (status não muda nessas edições).
            (SELECT COALESCE(SUM(position * song_id), 0) FROM video_songs) AS sig`,
  )!
  return createHash('sha1').update(sig).digest('hex').slice(0, 16)
}

export interface Flash {
  msg?: string
  err?: string
}

export function page(title: string, body: Html, flash: Flash = {}): string {
  const { bavail, bsize } = statfsSync(DATA_DIR)
  return `<!doctype html>${html`<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Fábrica de Mixes</title>
  <link rel="stylesheet" href="/static/style.css">
  <script src="/static/app.js" defer></script>
</head>
<body data-sig="${stateSignature()}">
  <header class="top">
    <a href="/" class="brand" aria-label="Fábrica de Mixes, início"><span class="brand-mark" aria-hidden="true">▶</span> Fábrica <span class="brand-light">de Mixes</span></a>
    <span class="worker" aria-live="polite">${workerStatus()}</span>
    <span class="disk" title="Espaço disponível no disco de dados">${bytes(bavail * bsize)} livres</span>
  </header>
  <main>
    ${flash.msg ? html`<p class="toast ok">${flash.msg}</p>` : ''}
    ${flash.err ? html`<p class="toast err">${flash.err}</p>` : ''}
    ${body}
  </main>
</body>
</html>`.value}`
}

function workerStatus(): Html {
  const rendering = get<Video & { channel_name: string }>(
    `SELECT v.*, c.name AS channel_name FROM videos v JOIN channels c ON c.id = v.channel_id WHERE v.status = 'rendering'`,
  )
  const { queued } = get<{ queued: number }>(
    "SELECT COUNT(*) AS queued FROM videos WHERE status = 'queued' AND approved_at IS NOT NULL",
  )!
  const { preparing } = get<{ preparing: number }>(
    "SELECT COUNT(*) AS preparing FROM visuals WHERE status IN ('pending', 'processing') AND deleted_at IS NULL",
  )!
  const parts: Value[] = []
  if (rendering) {
    parts.push(html`Renderizando <a href="/videos/${rendering.id}">${rendering.channel_name} #${rendering.number}</a> ${progress(rendering)}`)
  }
  if (preparing) parts.push(`preparando ${plural(preparing, 'visual', 'visuais')}`)
  if (queued) parts.push(`${queued} na fila`)
  if (!parts.length) return html`<span class="muted">Ocioso</span>`
  return html`${parts.map((p, i) => html`${i ? ' · ' : ''}${p}`)}`
}

function progress(video: Video): Html {
  const pct = Math.round(video.progress * 100)
  return html`<span class="bar" data-progress="${video.id}"><span style="width:${pct}%"></span></span>
    <span class="muted" data-progress-text="${video.id}">${pct}%</span>`
}

// ── Etapas do vídeo ─────────────────────────────────────────────────

/** Colunas do quadro: rascunho = na fila sem aprovação; agendado = pronto com data planejada. */
type Stage = 'draft' | 'production' | 'ready' | 'scheduled' | 'published' | 'error'
type StageFields = Pick<Video, 'status' | 'approved_at' | 'planned_date'>

function stageOf(video: StageFields): Stage {
  switch (video.status) {
    case 'queued':
      return video.approved_at ? 'production' : 'draft'
    case 'rendering':
      return 'production'
    case 'done':
      return video.planned_date ? 'scheduled' : 'ready'
    case 'published':
      return 'published'
    case 'failed':
      return 'error'
  }
}

const BOARD: Stage[] = ['draft', 'production', 'ready', 'scheduled', 'published', 'error']

const STAGES: Record<Stage, { title: string; plural: string; badge: string; hint: string; empty: string }> = {
  draft: { title: 'Rascunho', plural: 'Rascunhos', badge: 'rascunho', hint: 'Revise e aprove para renderizar.', empty: 'Nenhum rascunho esperando revisão.' },
  production: { title: 'Produção', plural: 'Em produção', badge: 'na fila', hint: 'Aprovados, na fila ou renderizando.', empty: 'Fila de render vazia.' },
  ready: { title: 'Pronto', plural: 'Prontos', badge: 'pronto', hint: 'Baixe e escolha a data de publicação.', empty: 'Nenhum vídeo pronto sem data.' },
  scheduled: { title: 'Agendado', plural: 'Agendados', badge: 'agendado', hint: 'Com data planejada no YouTube.', empty: 'Nenhuma publicação agendada.' },
  published: { title: 'Publicado', plural: 'Publicados', badge: 'publicado', hint: 'Já está no YouTube.', empty: 'Nada publicado ainda.' },
  error: { title: 'Erro', plural: 'Com erro', badge: 'erro', hint: 'Tente de novo ou descarte.', empty: 'Nenhum erro.' },
}

function stageCounts(channelId: number): Record<Stage, number> {
  const counts: Record<Stage, number> = { draft: 0, production: 0, ready: 0, scheduled: 0, published: 0, error: 0 }
  for (const video of all<StageFields>('SELECT status, approved_at, planned_date FROM videos WHERE channel_id = ?', channelId)) {
    counts[stageOf(video)]++
  }
  return counts
}

function statusBadge(video: Video): Html {
  if (video.status === 'rendering') return html`<span class="badge rendering">renderizando</span> ${progress(video)}`
  const stage = stageOf(video)
  return html`<span class="badge ${stage}">${STAGES[stage].badge}</span>`
}

/** "05/10/2026"; vídeos publicados antes da data manual mostram o horário em que foram marcados. */
function publishedOn(video: Video): string {
  return video.published_date ? day(video.published_date) : when(video.published_at)
}

function postButton(action: string, label: string, opts: { confirm?: string; cls?: string; disabled?: boolean } = {}): Html {
  return html`<form method="post" action="${action}" class="inline" ${opts.confirm ? html`data-confirm="${opts.confirm}"` : ''}>
    <button class="${opts.cls ?? ''}" ${opts.disabled ? 'disabled' : ''}>${label}</button></form>`
}

// ── Página inicial ──────────────────────────────────────────────────

export function dashboardPage(): Html {
  const channels = all<Channel>('SELECT * FROM channels ORDER BY name')
  const cards = channels.map(ch => {
    const cap = capacity(ch)
    const fresh = cap.styles.reduce((sum, p) => sum + p.fresh, 0)
    const stages = stageCounts(ch.id)
    return html`<a class="card channel" href="/channels/${ch.id}">
      <div class="channel-top"><span class="eyebrow">CANAL ${String(ch.id).padStart(2, '0')}</span>${autoBadge(ch)}</div>
      <h2>${ch.name}</h2>
      <p class="page-subtitle">${ch.description || 'Seu espaço para músicas, visuais e mixes.'}</p>
      <dl class="stats">
        <div><dt>Para revisar</dt><dd>${stages.draft}</dd></div>
        <div><dt>Em produção</dt><dd>${stages.production}</dd></div>
        <div><dt>Prontos</dt><dd>${stages.ready}</dd></div>
        <div><dt>Agendados</dt><dd>${stages.scheduled}</dd></div>
        <div><dt>Músicas novas</dt><dd>${fresh}</dd></div>
        <div><dt>Visuais novos</dt><dd>${cap.visuals.fresh}</dd></div>
      </dl>
      <div class="channel-foot">
        <span>${cap.videos ? html`Material para ${plural(cap.videos, 'novo vídeo', 'novos vídeos')}` : 'Envie músicas para continuar produzindo'}</span>
        <span aria-hidden="true">↗</span>
      </div>
    </a>`
  })
  return html`
    <div class="page-head">
      <span class="eyebrow">SEU ESTÚDIO</span>
      <h1>Seus canais<span class="heading-dot">.</span></h1>
      <p class="page-subtitle">Da sua biblioteca ao próximo vídeo. Acompanhe cada canal em um só lugar.</p>
    </div>
    <div class="grid">${cards}</div>
    ${channels.length ? '' : html`<div class="empty-state"><h2>Seu primeiro canal começa aqui.</h2><p>Crie um canal e envie as músicas e visuais que combinam com ele.</p></div>`}
    <section class="card create-channel">
      <div class="section-head"><div><span class="section-kicker">COMEÇAR</span><h2>Novo canal</h2></div></div>
      <p class="section-note">Separe estilos, imagens e vídeos por canal. Você pode mudar as configurações depois.</p>
      <form method="post" action="/channels" class="stack">
        <label>Nome do canal <input name="name" required maxlength="100" placeholder="Ex.: Lofi Gatinhos"></label>
        <label>Tema / descrição <input name="description" maxlength="300" placeholder="Que tipo de mix você produz?"></label>
        <button class="primary">Criar canal <span aria-hidden="true">↗</span></button>
      </form>
    </section>`
}

function autoBadge(ch: Channel): Html {
  if (!ch.auto_enabled) return html`<span class="badge">auto desligado</span>`
  if (hasFailedVideo(ch.id)) return html`<span class="badge failed">auto pausado</span>`
  return html`<span class="badge done">auto ligado</span>`
}

// ── Página do canal ─────────────────────────────────────────────────

type VideoRow = Video & { visual_title: string; songs: number }
type SongRow = Song & { uses: number }
type VisualRow = Visual & { uses: number }

function overviewCharts(ch: Channel, stats: Record<Stage, number>, cap: Capacity): Html {
  const totalVideos = BOARD.reduce((sum, key) => sum + stats[key], 0)
  let offset = 0
  const segments = BOARD.filter(key => stats[key] > 0).map(key => {
    const share = (stats[key] / totalVideos) * 100
    const circle = html`<circle class="chart-segment ${key}" cx="21" cy="21" r="15.9" pathLength="100"
      stroke-dasharray="${share.toFixed(2)} ${(100 - share).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"/>`
    offset += share
    return circle
  })
  const maxSongs = Math.max(1, ...cap.styles.map(style => style.total))
  return html`<div class="chart-grid">
    <section class="card chart-card" aria-labelledby="stages-title">
      <div class="section-head"><div><span class="section-kicker">PRODUÇÃO</span><h2 id="stages-title">Vídeos por etapa</h2></div></div>
      <div class="chart-body">
        <div class="donut-wrap">
          <svg class="donut-chart" viewBox="0 0 42 42" role="img" aria-label="${totalVideos} vídeos no canal, distribuídos por etapa">
            <circle class="chart-base" cx="21" cy="21" r="15.9" pathLength="100"/>
            <g transform="rotate(-90 21 21)">${segments}</g>
          </svg>
          <div class="donut-center" aria-hidden="true"><strong>${totalVideos}</strong><span>vídeos</span></div>
        </div>
        <ul class="chart-legend">${BOARD.map(key => html`<li><span class="legend-dot ${key}" aria-hidden="true"></span>
          <span>${STAGES[key].plural}</span><strong>${stats[key]}</strong></li>`)}</ul>
      </div>
      <p class="section-note">Do rascunho à publicação: o que espera revisão, renderiza, está pronto ou agendado.</p>
    </section>
    <section class="card chart-card" aria-labelledby="styles-title">
      <div class="section-head"><div><span class="section-kicker">BIBLIOTECA</span><h2 id="styles-title">Músicas por estilo</h2></div></div>
      ${cap.styles.length ? html`<div class="style-chart" role="list" aria-label="Músicas novas e já usadas por estilo">
        ${cap.styles.map(style => html`<div class="style-chart-row" role="listitem">
          <div class="style-chart-label"><strong>${styleName(style.style)}</strong>
            <span>${style.fresh} novas · ${style.total - style.fresh} usadas</span></div>
          <div class="style-chart-track" role="img" aria-label="${styleName(style.style)}: ${style.fresh} novas, ${style.total - style.fresh} usadas">
            <div class="style-chart-fill" style="width:${((style.total / maxSongs) * 100).toFixed(2)}%">
              <span class="style-chart-used" style="width:${(((style.total - style.fresh) / style.total) * 100).toFixed(2)}%"></span>
              <span class="style-chart-new" style="width:${((style.fresh / style.total) * 100).toFixed(2)}%"></span>
            </div>
          </div>
        </div>`)}
      </div>` : html`<div class="empty-state"><p>Nenhuma música enviada ainda.</p><a class="button" href="/channels/${ch.id}/upload">Enviar músicas</a></div>`}
      <p class="section-note">Cada vídeo precisa de ${ch.songs_per_video} faixas do mesmo estilo${ch.reuse_songs ? '; reaproveitamento está ligado.' : '.'}</p>
    </section>
  </div>`
}

export type ChannelSection = 'overview' | 'videos' | 'produce' | 'upload' | 'songs' | 'visuals' | 'settings'

function videoRows(channelId: number, limit?: number): VideoRow[] {
  const sql = `SELECT v.*, vis.title AS visual_title,
        (SELECT COUNT(*) FROM video_songs vs WHERE vs.video_id = v.id) AS songs
      FROM videos v JOIN visuals vis ON vis.id = v.visual_id
      WHERE v.channel_id = ? ORDER BY v.id DESC ${limit ? 'LIMIT ?' : ''}`
  return limit ? all<VideoRow>(sql, channelId, limit) : all<VideoRow>(sql, channelId)
}

function channelShell(ch: Channel, section: ChannelSection, content: Html): Html {
  const base = `/channels/${ch.id}`
  const counts = get<{ videos: number; songs: number; visuals: number }>(
    `SELECT (SELECT COUNT(*) FROM videos WHERE channel_id = ?) AS videos,
            (SELECT COUNT(*) FROM songs WHERE channel_id = ? AND deleted_at IS NULL) AS songs,
            (SELECT COUNT(*) FROM visuals WHERE channel_id = ? AND deleted_at IS NULL) AS visuals`,
    ch.id, ch.id, ch.id,
  )!
  const groups: { title: string; links: { key: ChannelSection; text: string; icon: string; path: string; count?: number }[] }[] = [
    { title: 'PAINEL', links: [{ key: 'overview', text: 'Visão geral', icon: '◫', path: base }] },
    { title: 'PRODUÇÃO', links: [
      { key: 'videos', text: 'Vídeos', icon: '▣', path: `${base}/videos`, count: counts.videos },
      { key: 'produce', text: 'Produzir', icon: '✦', path: `${base}/produce` },
    ] },
    { title: 'BIBLIOTECA', links: [
      { key: 'upload', text: 'Enviar arquivos', icon: '↥', path: `${base}/upload` },
      { key: 'songs', text: 'Músicas', icon: '♫', path: `${base}/songs`, count: counts.songs },
      { key: 'visuals', text: 'Visuais', icon: '▧', path: `${base}/visuals`, count: counts.visuals },
    ] },
    { title: 'CANAL', links: [{ key: 'settings', text: 'Ajustes', icon: '⚙', path: `${base}/settings` }] },
  ]
  return html`<div class="workspace">
    <button type="button" class="sidebar-toggle" aria-controls="channel-nav" aria-expanded="false" aria-label="Abrir menu do canal">☰ <span>Menu do canal</span></button>
    <button type="button" class="sidebar-backdrop" aria-label="Fechar menu" tabindex="-1"></button>
    <aside class="sidebar" id="channel-nav" aria-label="Navegação do canal">
      <div class="sidebar-head"><button type="button" class="sidebar-close" aria-label="Fechar menu do canal">×</button>
        <span class="eyebrow">CANAL ${String(ch.id).padStart(2, '0')}</span>
        <strong title="${ch.name}">${ch.name}</strong>${autoBadge(ch)}</div>
      <nav class="sidebar-nav" aria-label="Áreas do canal">
        ${groups.map(group => html`<div class="sidebar-group"><span class="sidebar-label">${group.title}</span>
          ${group.links.map(link => html`<a class="sidebar-link" href="${link.path}" ${section === link.key ? html`aria-current="page"` : ''}>
            <span class="sidebar-icon" aria-hidden="true">${link.icon}</span><span>${link.text}</span>
            ${link.count !== undefined ? html`<span class="sidebar-count">${link.count}</span>` : ''}
          </a>`)}
        </div>`)}
      </nav>
      <div class="sidebar-footer"><a href="/">← Todos os canais</a><span>Fábrica de Mixes</span></div>
    </aside>
    <div class="workspace-content">${content}</div>
  </div>`
}

export function channelPage(ch: Channel, section: ChannelSection = 'overview'): Html {
  const cap = section === 'overview' || section === 'produce' ? capacity(ch) : null
  const base = `/channels/${ch.id}`
  let title: string
  let subtitle: string
  let body: Html
  switch (section) {
    case 'overview': {
      title = ch.name
      subtitle = ch.description || 'Biblioteca, produção e vídeos do canal.'
      const stages = stageCounts(ch.id)
      const freshSongs = cap!.styles.reduce((sum, p) => sum + p.fresh, 0)
      const bestPool = Math.max(0, ...cap!.styles.map(p => ch.reuse_songs ? p.total : p.fresh))
      const missingSongs = Math.max(0, ch.songs_per_video - bestPool)
      const missingVisual = ch.reuse_visuals ? !cap!.visuals.ready : !cap!.visuals.fresh
      const board = `${base}/videos`
      let nextStep: Html
      if (stages.draft) {
        nextStep = html`<aside class="surface-highlight warn" aria-label="Próximo passo">
          <div><span class="section-kicker">REVISÃO PENDENTE</span><h2>${plural(stages.draft, 'rascunho espera', 'rascunhos esperam')} sua aprovação.</h2>
            <p>Nada é renderizado antes de você ouvir as faixas, ajustar e aprovar.</p></div>
          <a class="button primary" href="${board}#col-draft">Revisar rascunhos <span aria-hidden="true">↗</span></a>
        </aside>`
      } else if (cap!.videos === 0) {
        nextStep = html`<aside class="surface-highlight" aria-label="Próximo passo">
          <div><span class="section-kicker">PRÓXIMO PASSO</span><h2>Mais material para o próximo mix</h2>
            <p>${missingSongs ? html`Faltam pelo menos <b>${missingSongs} ${missingSongs === 1 ? 'música' : 'músicas'}</b> de um mesmo estilo.` : ''}
              ${missingVisual ? 'Envie também um visual novo.' : ''} Os vídeos prontos continuam disponíveis para baixar.</p></div>
          <a class="button primary" href="${base}/upload">Enviar material <span aria-hidden="true">↗</span></a>
        </aside>`
      } else {
        nextStep = html`<aside class="surface-highlight ready" aria-label="Próximo passo">
          <div><span class="section-kicker">PRONTO PARA PRODUZIR</span><h2>Material para ${plural(cap!.videos, 'novo mix', 'novos mixes')}.</h2>
            <p>Crie um rascunho, revise as faixas e aprove para renderizar.</p></div>
          <a class="button primary" href="${base}/produce">Criar rascunho <span aria-hidden="true">↗</span></a>
        </aside>`
      }
      body = html`
        <div class="overview-grid" aria-label="Resumo do canal">
          <a class="metric ${stages.draft ? 'is-warn' : ''}" href="${board}#col-draft"><span class="metric-label">Para revisar</span><strong class="metric-value">${stages.draft}</strong><span class="metric-foot">Rascunhos esperando aprovação</span></a>
          <a class="metric ${stages.production ? 'is-accent' : ''}" href="${board}#col-production"><span class="metric-label">Em produção</span><strong class="metric-value">${stages.production}</strong><span class="metric-foot">Aprovados na fila ou renderizando</span></a>
          <a class="metric ${stages.ready ? 'is-ok' : ''}" href="${board}#col-ready"><span class="metric-label">Prontos</span><strong class="metric-value">${stages.ready}</strong><span class="metric-foot">Renderizados, ainda sem data</span></a>
          <a class="metric ${stages.scheduled ? 'is-plan' : ''}" href="${board}#col-scheduled"><span class="metric-label">Agendados</span><strong class="metric-value">${stages.scheduled}</strong><span class="metric-foot">Com data para publicar</span></a>
          <div class="metric ${missingSongs ? 'is-warn' : ''}"><span class="metric-label">Músicas novas</span><strong class="metric-value">${freshSongs}</strong><span class="metric-foot">${ch.songs_per_video} do mesmo estilo por vídeo</span></div>
          <div class="metric ${missingVisual ? 'is-warn' : ''}"><span class="metric-label">Visuais novos</span><strong class="metric-value">${cap!.visuals.fresh}</strong><span class="metric-foot">Imagens ou loops disponíveis</span></div>
        </div>
        ${nextStep}
        ${overviewCharts(ch, stages, cap!)}
        ${recentVideos(videoRows(ch.id, 3), base)}
        <a class="button" href="${board}">Abrir quadro de vídeos →</a>`
      break
    }
    case 'videos':
      title = 'Vídeos'
      subtitle = `Do rascunho à publicação: cada coluna é uma etapa dos mixes de ${ch.name}.`
      body = boardSection(videoRows(ch.id), base)
      break
    case 'produce': {
      title = 'Produzir'
      subtitle = 'Crie rascunhos, revise e só então mande renderizar.'
      const songs = all<Song>('SELECT * FROM songs WHERE channel_id = ? AND deleted_at IS NULL', ch.id)
      body = generateSection(ch, cap!, songs, stageCounts(ch.id).draft)
      break
    }
    case 'upload':
      title = 'Enviar arquivos'
      subtitle = 'Coloque músicas, imagens e loops na biblioteca deste canal.'
      body = uploadSection(ch, all<Style>('SELECT * FROM styles WHERE channel_id = ? ORDER BY name', ch.id).map(s => s.name))
      break
    case 'songs':
      title = 'Músicas'
      subtitle = 'Faixas organizadas por estilo e histórico de uso.'
      body = songsSection(
        all<SongRow>(
          `SELECT s.*, (SELECT COUNT(*) FROM video_songs vs WHERE vs.song_id = s.id) AS uses
             FROM songs s WHERE channel_id = ? AND deleted_at IS NULL ORDER BY style, created_at, id`, ch.id,
        ),
        all<Style>('SELECT * FROM styles WHERE channel_id = ? ORDER BY name', ch.id),
        base,
      )
      break
    case 'visuals':
      title = 'Visuais'
      subtitle = 'Imagens e vídeos em loop disponíveis para os mixes.'
      body = visualsSection(all<VisualRow>(
        `SELECT v.*, (SELECT COUNT(*) FROM videos x WHERE x.visual_id = v.id) AS uses
           FROM visuals v WHERE channel_id = ? AND deleted_at IS NULL ORDER BY id DESC`, ch.id,
      ), base)
      break
    case 'settings':
      title = 'Ajustes'
      subtitle = 'Regras de geração e informações do canal.'
      body = settingsSection(ch)
      break
  }
  return channelShell(ch, section, html`
    <div class="page-head">
      <span class="eyebrow">CANAL ${String(ch.id).padStart(2, '0')} / ${section === 'overview' ? 'VISÃO GERAL' : title.toUpperCase()}</span>
      <div class="page-title-row"><h1>${title}<span class="heading-dot">.</span></h1>${section === 'overview' ? autoBadge(ch) : ''}</div>
      <p class="page-subtitle">${subtitle}</p>
    </div>
    ${body}`)
}

function generateSection(ch: Channel, cap: Capacity, songs: Song[], drafts: number): Html {
  const n = ch.songs_per_video
  const avg = songs.length ? songs.reduce((sum, s) => sum + s.duration, 0) / songs.length : 0
  return html`<section class="card" id="gerar">
    <div class="section-head"><div><span class="section-kicker">PRODUÇÃO</span><h2>Criar o próximo rascunho</h2></div>
      <span class="badge ${cap.videos ? 'done' : 'queued'}">${cap.videos ? `${count(cap.videos)} possíveis` : 'Aguardando material'}</span></div>
    <ol class="flow-steps" aria-label="Como um mix chega ao YouTube">
      <li><b>Criar rascunho</b><span>Reserva ${n} músicas do mesmo estilo e um visual. Nada é renderizado ainda.</span></li>
      <li><b>Revisar</b><span>Ouça as faixas, mude a ordem, troque músicas, visual e miniatura.</span></li>
      <li><b>Aprovar</b><span>Só depois da aprovação o vídeo entra na fila de render.</span></li>
      <li><b>Publicar</b><span>Baixe, agende e marque como publicado com o link do YouTube.</span></li>
    </ol>
    ${drafts ? html`<p class="flow-note"><b>${plural(drafts, 'rascunho espera', 'rascunhos esperam')} revisão.</b>
      <a href="/channels/${ch.id}/videos#col-draft">Abrir no quadro →</a></p>` : ''}
    <p class="section-note">Cada mix combina <b>${n} músicas do mesmo estilo</b>${avg ? html` (~${Math.round((avg * n) / 60)} min)` : ''} com uma imagem ou um loop.
      ${ch.reuse_songs ? 'Músicas menos usadas primeiro.' : 'Sem repetir músicas.'}
      ${ch.reuse_visuals ? 'Visuais podem se repetir.' : 'Sem repetir visuais.'}</p>
    <div class="availability" role="list" aria-label="Músicas disponíveis por estilo">
      ${cap.styles.length ? cap.styles.map(p => html`<div class="availability-item" role="listitem">
        <div><strong>${styleName(p.style)}</strong><span>${p.fresh} novas · ${p.total} no total</span></div>
        <span class="availability-number">${plural(p.videos, 'mix', 'mixes')}</span>
      </div>`) : html`<p class="muted">Envie músicas para começar.</p>`}
    </div>
    <p class="section-note">Visuais: ${cap.visuals.fresh} novos, ${cap.visuals.ready} prontos
      ${cap.visuals.preparing ? html` · ${cap.visuals.preparing} em preparo` : ''}
      ${cap.visuals.failed ? html` · <span class="err">${cap.visuals.failed} com erro</span>` : ''}.</p>
    <form method="post" action="/channels/${ch.id}/generate" class="row generate-form">
      <label>Estilo
        <select name="style">
          <option value="auto">Alternar estilos disponíveis</option>
          ${cap.styles.map(p => html`<option value="s:${p.style}">${styleName(p.style)} (${count(p.videos)})</option>`)}
        </select>
      </label>
      <label>Quantidade <input type="number" name="count" value="1" min="1" max="50"></label>
      <button class="primary" ${cap.videos ? '' : 'disabled'}>Criar rascunho <span aria-hidden="true">↗</span></button>
    </form>
    <p class="section-note">${autoLine(ch, cap.videos)}</p>
  </section>`
}

function autoLine(ch: Channel, possible: number): string {
  if (!ch.auto_enabled) return `Automático desligado. Ligue em Ajustes para manter ${ch.auto_buffer} rascunhos ou vídeos não publicados prontos para revisar.`
  if (hasFailedVideo(ch.id)) return 'Automático pausado: tem vídeo com erro. Tente de novo ou descarte ele.'
  const { pending } = get<{ pending: number }>(
    `SELECT COUNT(*) AS pending FROM videos WHERE channel_id = ? AND status IN ('queued', 'rendering', 'done')`,
    ch.id,
  )!
  if (pending < ch.auto_buffer && !possible) return `Automático esperando material novo (${pending}/${ch.auto_buffer} rascunhos ou vídeos não publicados).`
  return `Automático ligado: mantém ${ch.auto_buffer} rascunhos ou vídeos não publicados (agora ${pending}). Ele só prepara rascunhos; nada renderiza sem a sua aprovação.`
}

function recentVideos(videos: VideoRow[], base: string): Html {
  const rows = videos.map(v => html`<tr>
    <td class="video-cover"><a href="/videos/${v.id}" aria-label="Abrir vídeo ${v.number}"><img class="thumb" src="/visuals/${v.thumbnail_visual_id ?? v.visual_id}/thumb" alt="" loading="lazy"></a></td>
    <td class="video-main"><a href="/videos/${v.id}"><b>Mix #${v.number}</b></a><small title="${v.visual_title}">${v.visual_title}</small></td>
    <td data-label="Estilo">${styleName(v.style)}</td>
    <td data-label="Etapa">${statusBadge(v)}</td>
    <td data-label="Duração">${clock(v.duration)}</td>
    <td data-label="Faixas">${v.songs} músicas</td>
    <td class="muted" data-label="Criado">${when(v.created_at)}</td>
    <td class="nowrap video-actions">
      ${v.file && !v.file_deleted ? html`<a class="button primary" href="/videos/${v.id}/download">Baixar</a>` : ''}
      <a href="/videos/${v.id}">Ver detalhes <span aria-hidden="true">↗</span></a>
    </td>
  </tr>`)
  return html`<section class="card" id="videos">
    <div class="section-head"><div><span class="section-kicker">ACOMPANHAMENTO</span><h2>Últimos vídeos</h2></div>
      <span class="section-note">${videos.length} ${videos.length === 1 ? 'vídeo' : 'vídeos'} mais recentes</span></div>
    ${videos.length
      ? html`<div class="scroll"><table class="video-table"><thead><tr><th></th><th>Vídeo</th><th>Estilo</th><th>Etapa</th><th>Duração</th><th>Faixas</th><th>Criado</th><th>Ações</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
      : html`<div class="empty-state"><h3>Nenhum vídeo ainda</h3><p>Envie músicas e visuais. Quando criar o primeiro rascunho, ele vai aparecer aqui.</p><a class="button" href="${base}/upload">Enviar arquivos</a></div>`}
  </section>`
}

// ── Quadro de vídeos (kanban) ───────────────────────────────────────

/** Publicados crescem sem parar: o resto fica recolhido para a coluna não virar uma lista infinita. */
const PUBLISHED_VISIBLE = 8

const byId = (a: VideoRow, b: VideoRow) => a.id - b.id

/** Ordem de cada coluna: produção segue a fila do worker (renderizando, depois id). */
const BOARD_ORDER: Record<Stage, (a: VideoRow, b: VideoRow) => number> = {
  draft: byId,
  production: (a, b) => Number(b.status === 'rendering') - Number(a.status === 'rendering') || byId(a, b),
  ready: byId,
  scheduled: (a, b) => (a.planned_date ?? '').localeCompare(b.planned_date ?? '') || byId(a, b),
  published: (a, b) =>
    (b.published_date ?? b.published_at ?? '').localeCompare(a.published_date ?? a.published_at ?? '') || byId(b, a),
  error: (a, b) => byId(b, a),
}

function boardSection(videos: VideoRow[], base: string): Html {
  if (!videos.length) {
    return html`<div class="empty-state"><h2>Nenhum vídeo ainda</h2>
      <p>Crie o primeiro rascunho em Produzir. Ele aparece aqui na coluna Rascunho para você revisar antes de renderizar.</p>
      <a class="button primary" href="${base}/produce">Criar rascunho</a></div>`
  }
  const byStage = Map.groupBy(videos, stageOf)
  return html`<section class="board-section" aria-labelledby="board-title">
    <div class="section-head"><div><span class="section-kicker">FLUXO DE PUBLICAÇÃO</span><h2 id="board-title">Quadro de produção</h2></div>
      <a class="button" href="${base}/produce">Criar rascunho <span aria-hidden="true">↗</span></a></div>
    <nav class="board-nav" aria-label="Ir para a etapa">
      ${BOARD.map(key => html`<a class="board-chip ${key}" href="#col-${key}"><span>${STAGES[key].title}</span><b>${byStage.get(key)?.length ?? 0}</b></a>`)}
    </nav>
    <div class="board" role="region" aria-label="Quadro de vídeos por etapa; use as setas ou role horizontalmente para ver as colunas" tabindex="0">
      ${BOARD.map(key => boardColumn(key, (byStage.get(key) ?? []).sort(BOARD_ORDER[key])))}
    </div>
  </section>`
}

function boardColumn(key: Stage, list: VideoRow[]): Html {
  const info = STAGES[key]
  const shown = key === 'published' ? list.slice(0, PUBLISHED_VISIBLE) : list
  const rest = list.slice(shown.length)
  return html`<section class="board-col ${key}" id="col-${key}" aria-labelledby="col-${key}-title">
    <header class="board-col-head">
      <h3 id="col-${key}-title">${info.title}</h3>
      <span class="board-count">${list.length}<span class="sr-only"> ${list.length === 1 ? 'vídeo' : 'vídeos'}</span></span>
    </header>
    <p class="board-hint">${info.hint}</p>
    ${list.length ? html`<ol class="board-list">${shown.map(v => boardCard(v, key))}</ol>` : html`<p class="board-empty">${info.empty}</p>`}
    ${rest.length ? html`<details class="board-more"><summary>Mais ${plural(rest.length, 'publicado', 'publicados')}</summary>
      <ol class="board-list">${rest.map(v => boardCard(v, key))}</ol></details>` : ''}
  </section>`
}

function boardCard(v: VideoRow, stage: Stage): Html {
  const downloaded = v.downloaded_at ? html`<span class="mark ok">✓ Baixado</span>` : html`<span class="mark">Não baixado</span>`
  let foot: Html
  switch (stage) {
    case 'draft':
      foot = html`<span>Criado ${when(v.created_at)}</span>`
      break
    case 'production':
      foot = statusBadge(v)
      break
    case 'ready':
      foot = html`<span>Pronto ${when(v.finished_at)}</span>${downloaded}`
      break
    case 'scheduled':
      foot = html`<span class="kanban-date">Para ${day(v.planned_date)}</span>${downloaded}`
      break
    case 'published':
      foot = html`<span>No ar ${publishedOn(v)}</span>${v.file_deleted ? html`<span class="mark">arquivo apagado</span>` : ''}`
      break
    case 'error':
      foot = html`<span class="kanban-error">${v.error || 'Falhou no render.'}</span>`
      break
  }
  return html`<li><a class="kanban-card" href="/videos/${v.id}">
    <img class="kanban-thumb" src="/visuals/${v.thumbnail_visual_id ?? v.visual_id}/thumb" alt="" loading="lazy">
    <span class="kanban-body">
      <b class="kanban-title">Mix #${v.number}</b>
      <span class="kanban-meta">${styleName(v.style)}</span>
      <span class="kanban-meta">${clock(v.duration)} · ${plural(v.songs, 'faixa', 'faixas')}</span>
      <span class="kanban-foot">${foot}</span>
    </span>
  </a></li>`
}

function uploadSection(ch: Channel, styles: string[]): Html {
  return html`<section class="card" id="enviar">
    <div class="section-head"><div><span class="section-kicker">BIBLIOTECA</span><h2>Enviar arquivos</h2></div></div>
    <p class="section-note">Adicione músicas, imagens e loops só deste canal. Arquivos repetidos são ignorados automaticamente.</p>
    <form class="upload" data-upload="/channels/${ch.id}/upload" data-accept="${ACCEPTED_EXT}" onsubmit="return false">
      <div class="upload-toolbar">
        <div class="style-picker">
          <label>Estilo para músicas soltas
            <select name="style">
              ${styles.some(Boolean) ? html`<option value="" selected>Escolha um estilo…</option>` : ''}
              ${styles.filter(Boolean).map(s => html`<option value="${s}">${s}</option>`)}
              <option value="__new__" ${styles.some(Boolean) ? '' : 'selected'}>＋ Criar novo estilo…</option>
            </select>
          </label>
          <label class="new-style-field" hidden>Nome do novo estilo
            <input name="new_style" maxlength="80" placeholder="Ex.: jazz-noturno" autocomplete="off">
          </label>
        </div>
        <p>Músicas dentro de uma pasta herdam o <strong>nome da pasta</strong> como estilo. Imagens e vídeos entram na galeria de visuais.</p>
      </div>
      <div class="dropzone">
        <span class="drop-icon" aria-hidden="true">＋</span>
        <strong>Arraste arquivos ou pastas para cá</strong>
        <p>Ou escolha no computador. MP3, WAV, FLAC, PNG, JPG e vídeos curtos em loop.</p>
        <div class="button-row">
          <label class="button primary" role="button" tabindex="0">Escolher arquivos<input type="file" multiple hidden accept="${ACCEPTED_EXT}"></label>
          <label class="button" role="button" tabindex="0">Escolher pasta<input type="file" webkitdirectory hidden></label>
        </div>
      </div>
      <p class="upload-summary" role="status" aria-live="polite"></p>
      <ul class="upload-log"></ul>
    </form>
  </section>`
}

function visualsSection(visuals: VisualRow[], base: string): Html {
  const cards = visuals.map(v => html`<figure class="visual">
    ${v.status === 'ready'
      ? html`<a href="/visuals/${v.id}/loop" target="_blank" aria-label="Abrir prévia de ${v.title}"><img src="/visuals/${v.id}/thumb" alt="" loading="lazy"></a>`
      : html`<div class="placeholder ${v.status}">${v.status === 'failed' ? 'Erro no preparo' : 'Preparando visual…'}</div>`}
    <figcaption>
      <span title="${v.title}"><span class="muted">#${v.id}</span> ${v.title}</span>
      <span class="muted">${v.kind === 'image' ? 'Imagem' : 'Vídeo em loop'} · ${v.uses ? plural(v.uses, 'uso', 'usos') : 'Ainda não usado'}</span>
      ${v.error ? html`<details><summary class="err">Ver erro</summary><pre>${v.error}</pre></details>` : ''}
      <span class="actions">
        ${v.status === 'failed' ? postButton(`/visuals/${v.id}/retry`, 'Tentar de novo') : ''}
        ${postButton(`/visuals/${v.id}/delete`, 'Excluir', { confirm: `Excluir o visual "${v.title}"?`, cls: 'danger small' })}
      </span>
    </figcaption>
  </figure>`)
  return html`<section class="card" id="visuais">
    <div class="section-head"><div><span class="section-kicker">BIBLIOTECA VISUAL</span><h2>Imagens e loops</h2></div>
      <span class="section-note">${visuals.length} no canal</span></div>
    <p class="section-note">O sistema alterna os visuais disponíveis para criar mixes diferentes. Clique na imagem para ver o loop.</p>
    ${visuals.length ? html`<div class="visuals">${cards}</div>` : html`<div class="empty-state"><h3>Uma imagem já basta para começar.</h3><p>Envie uma imagem ou um vídeo curto que combine com o canal.</p><a class="button" href="${base}/upload">Enviar visual</a></div>`}
  </section>`
}

function songsSection(songs: SongRow[], styles: Style[], base: string): Html {
  const byStyle = Map.groupBy(songs, s => s.style)
  const groups = styles.map(style => {
    const list = byStyle.get(style.name) ?? []
    const fresh = list.filter(s => !s.uses).length
    return html`<details id="style-${style.id}" data-key="style:${style.name}">
      <summary><strong>${style.name}</strong>
        <span class="muted">${fresh} novas · ${list.length} no total</span>
        <span class="badge ${style.prompt ? 'done' : 'queued'}">${style.prompt ? 'prompt salvo' : 'sem prompt'}</span></summary>
      <div class="style-prompt">
        <form method="post" action="${base}/styles/${style.id}/prompt" class="stack">
          <label for="prompt-${style.id}">Prompt de geração de música
            <textarea id="prompt-${style.id}" name="prompt" maxlength="12000" rows="5"
              placeholder="Descreva instrumentos, ritmo, clima e produção deste estilo…">${style.prompt}</textarea>
          </label>
          <div class="button-row">
            <button class="primary">Salvar prompt</button>
            <button type="button" data-copy="prompt-${style.id}" ${style.prompt ? '' : 'disabled'}>Copiar prompt</button>
          </div>
        </form>
        <p class="section-note">Receita deste estilo para gerar novas faixas no seu PC. Alterações aqui não mudam músicas já geradas.</p>
      </div>
      ${list.length ? html`<div class="scroll"><table class="compact">
        <thead><tr><th>Música</th><th>Duração</th><th>Usos</th><th>Enviada</th><th></th></tr></thead>
        <tbody>${list.map(s => html`<tr>
          <td>${s.title}<audio class="song-audio" controls preload="none" src="/songs/${s.id}/file" aria-label="Ouvir ${s.title}"></audio></td>
          <td>${clock(s.duration)}</td>
          <td>${s.uses ? s.uses : html`<span class="badge done">nova</span>`}</td>
          <td class="muted">${when(s.created_at)}</td>
          <td>${postButton(`/songs/${s.id}/delete`, 'Excluir', { confirm: `Excluir "${s.title}"?`, cls: 'danger small' })}</td>
        </tr>`)}</tbody>
      </table></div>` : html`<p class="style-empty">Nenhuma música enviada neste estilo. <a href="${base}/upload">Enviar músicas →</a></p>`}
    </details>`
  })
  return html`<section class="card" id="musicas">
    <div class="section-head"><div><span class="section-kicker">BIBLIOTECA DE ÁUDIO</span><h2>Estilos e prompts</h2></div>
      <span class="section-note">${styles.length} ${styles.length === 1 ? 'estilo' : 'estilos'} · ${songs.length} músicas</span></div>
    <p class="section-note">Guarde a receita de cada estilo aqui e copie o prompt quando for gerar músicas no seu PC. Use o player abaixo do título para ouvir cada faixa.</p>
    ${groups.length ? groups : html`<div class="empty-state"><h3>Nenhum estilo ainda.</h3><p>Crie um estilo e salve o primeiro prompt de geração.</p></div>`}
    <details class="style-creator" ${styles.length ? '' : 'open'}>
      <summary>Criar estilo com prompt</summary>
      <form method="post" action="${base}/styles" class="stack">
        <label>Nome do estilo <input name="name" required maxlength="80" placeholder="Ex.: jazz-noturno"></label>
        <label>Prompt de geração <textarea name="prompt" required maxlength="12000" rows="5"
          placeholder="Ex.: jazz instrumental noturno, 85 bpm, piano elétrico quente…"></textarea></label>
        <button class="primary">Salvar estilo</button>
      </form>
    </details>
  </section>`
}

function settingsSection(ch: Channel): Html {
  return html`<section class="card" id="config">
    <div class="section-head"><div><span class="section-kicker">PREFERÊNCIAS</span><h2>Ajustes do canal</h2></div></div>
    <p class="section-note">Essas opções valem para os próximos rascunhos; os vídeos já criados não mudam.</p>
    <form method="post" action="/channels/${ch.id}/settings" class="stack">
      <label>Nome <input name="name" value="${ch.name}" required maxlength="100"></label>
      <label>Tema / descrição <input name="description" value="${ch.description}" maxlength="300"></label>
      <label>Músicas por vídeo <input type="number" name="songs_per_video" value="${ch.songs_per_video}" min="1" max="500"></label>
      <label class="check"><input type="checkbox" name="reuse_songs" ${ch.reuse_songs ? 'checked' : ''}>
        Reaproveitar músicas já usadas (escolhe as menos usadas primeiro)</label>
      <label class="check"><input type="checkbox" name="reuse_visuals" ${ch.reuse_visuals ? 'checked' : ''}>
        Reaproveitar visuais já usados</label>
      <label class="check"><input type="checkbox" name="auto_enabled" ${ch.auto_enabled ? 'checked' : ''}>
        Criar rascunhos automaticamente quando houver material (nada renderiza sem a sua aprovação)</label>
      <label>Manter até quantos rascunhos ou vídeos não publicados <input type="number" name="auto_buffer" value="${ch.auto_buffer}" min="1" max="50"></label>
      <button class="primary">Salvar ajustes</button>
    </form>
    <details class="danger-zone">
      <summary>Excluir canal</summary>
      <form method="post" action="/channels/${ch.id}/delete" class="stack">
        <p>Apaga o canal e todos os arquivos dele. Digite o nome exato para confirmar.</p>
        <input name="confirm" autocomplete="off" placeholder="${ch.name}">
        <button class="danger">Excluir canal para sempre</button>
      </form>
    </details>
  </section>`
}

// ── Página do vídeo ─────────────────────────────────────────────────

type TrackRow = Song & { start: number; position: number; mix_duration: number }

const FLOW: Stage[] = ['draft', 'production', 'ready', 'scheduled', 'published']

function stepper(video: Video, stage: Stage): Html {
  const current = FLOW.indexOf(stage === 'error' ? 'production' : stage)
  return html`<ol class="stepper" aria-label="Etapas do vídeo">${FLOW.map((key, i) => {
    // Pronto → publicado sem data: a etapa Agendado ficou para trás sem acontecer.
    const skipped = i < current && key === 'scheduled' && !video.planned_date
    const state = i > current ? 'todo' : i < current ? (skipped ? 'skipped' : 'done') : stage === 'error' ? 'failed' : 'current'
    // Publicado é a última etapa: chegar nela já é concluir.
    const mark = state === 'done' || (state === 'current' && key === 'published') ? '✓'
      : state === 'skipped' ? '–' : state === 'failed' ? '!' : String(i + 1)
    const note = state === 'done' ? 'concluída' : state === 'skipped' ? 'pulada' : state === 'failed' ? 'falhou' : ''
    return html`<li class="${state}" ${i === current ? html`aria-current="step"` : ''}>
      <span class="step-dot" aria-hidden="true">${mark}</span>
      <span class="step-label">${STAGES[key].title}${note ? html`<span class="sr-only"> (${note})</span>` : ''}</span>
    </li>`
  })}</ol>`
}

export function videoPage(video: Video): Html {
  const ch = get<Channel>('SELECT * FROM channels WHERE id = ?', video.channel_id)!
  const stage = stageOf(video)
  const draft = stage === 'draft'
  const visual = get<Visual>('SELECT * FROM visuals WHERE id = ?', video.visual_id)!
  const thumb = video.thumbnail_visual_id ? get<Visual>('SELECT * FROM visuals WHERE id = ?', video.thumbnail_visual_id)! : visual
  const songs = all<TrackRow>(
    `SELECT s.*, vs.start, vs.position, s.duration - s.tail_trim_seconds AS mix_duration
       FROM video_songs vs JOIN songs s ON s.id = vs.song_id WHERE vs.video_id = ? ORDER BY vs.position`,
    video.id,
  )
  const hasFile = !!video.file && !video.file_deleted
  // Mesma regra de jobs.setThumbnailVisual: rascunho ou pronto (agendado incluso), nunca depois de publicado.
  const thumbEditable = draft || video.status === 'done'
  // O jobs só salva https do YouTube; conferir de novo impede link javascript: vindo de dado antigo.
  const youtubeUrl = video.youtube_url && /^https:\/\//i.test(video.youtube_url) ? video.youtube_url : null
  let media: Html
  if (draft && !visual.deleted_at) {
    media = html`<video class="loop-preview" controls muted loop playsinline preload="none"
      poster="/visuals/${visual.id}/thumb" src="/visuals/${visual.id}/loop" aria-label="Prévia do visual em loop"></video>`
  } else if (hasFile) {
    media = html`<video controls preload="metadata" src="/videos/${video.id}/file" poster="/visuals/${thumb.id}/thumb"></video>`
  } else {
    media = html`<img class="poster" src="/visuals/${thumb.id}/thumb" alt="">`
  }
  return channelShell(ch, 'videos', html`
    <div class="page-head">
      <a class="back-link" href="/channels/${ch.id}/videos#col-${stage}">← Voltar ao quadro</a>
      <span class="eyebrow">VÍDEO / ${styleName(video.style)}</span>
      <div class="page-title-row"><h1>Mix #${video.number}<span class="heading-dot">.</span></h1>${statusBadge(video)}</div>
      <p class="page-subtitle">${clock(video.duration)} · ${plural(songs.length, 'música', 'músicas')} · visual #${visual.id}</p>
    </div>
    ${stepper(video, stage)}
    ${stagePanel(video, stage, songs, visual, hasFile, youtubeUrl)}
    <div class="video-layout">
      <div class="card player-card">
        ${media}
        ${draft ? html`<p class="player-note">Prévia do visual em loop, sem som. Ouça as faixas na lista abaixo.</p>` : ''}
      </div>
      <aside class="card video-facts">
        <span class="section-kicker">FICHA DO MIX</span>
        <h2>Detalhes</h2>
        <dl class="facts">
          <dt>Estilo</dt><dd>${styleName(video.style)}</dd>
          <dt>Duração</dt><dd>${clock(video.duration)}</dd>
          <dt>Visual</dt><dd><span class="muted">#${visual.id}</span> ${visual.title} <span class="muted">(${visual.kind === 'image' ? 'imagem' : 'vídeo'}${visual.deleted_at ? ', excluído' : ''})</span></dd>
          <dt>Miniatura</dt><dd>${thumb.id === visual.id ? 'Igual ao visual' : html`<span class="muted">#${thumb.id}</span> ${thumb.title}`}
            · <a href="/videos/${video.id}/thumbnail">baixar</a></dd>
          <dt>Criado</dt><dd>${when(video.created_at)}</dd>
          <dt>Aprovado</dt><dd>${when(video.approved_at)}</dd>
          <dt>Finalizado</dt><dd>${when(video.finished_at)}</dd>
          <dt>Baixado</dt><dd>${when(video.downloaded_at)}</dd>
          <dt>Agendado</dt><dd>${day(video.planned_date)}</dd>
          <dt>Publicado</dt><dd>${video.status === 'published' ? publishedOn(video) : '—'}</dd>
          ${youtubeUrl ? html`<dt>YouTube</dt><dd><a href="${youtubeUrl}" target="_blank" rel="noopener noreferrer">${youtubeUrl}</a></dd>` : ''}
          ${video.file_deleted ? html`<dt>Arquivo</dt><dd class="muted">apagado; histórico preservado</dd>` : ''}
        </dl>
      </aside>
    </div>
    ${thumbEditable ? imageSection(video, ch, visual, thumb, draft) : ''}
    ${tracksSection(video, ch, songs, draft)}`)
}

/** Cartão com o próximo passo da etapa atual; os POSTs voltam para #etapa. */
function stagePanel(video: Video, stage: Stage, songs: TrackRow[], visual: Visual, hasFile: boolean, youtubeUrl: string | null): Html {
  const base = `/videos/${video.id}`
  switch (stage) {
    case 'draft': {
      const missing = songs.filter(s => s.deleted_at).length
      const problems = [
        missing ? `${missing === 1 ? '1 faixa foi excluída' : `${missing} faixas foram excluídas`} da biblioteca: troque antes de aprovar.` : '',
        visual.deleted_at ? 'O visual foi excluído da biblioteca: escolha outro antes de aprovar.' : '',
      ].filter(Boolean)
      return html`<section class="card stage-panel draft" id="etapa">
        <div class="section-head"><div><span class="section-kicker">RASCUNHO · NADA RENDERIZADO</span><h2>Revise e aprove para renderizar</h2></div></div>
        <p>Ouça as faixas, ajuste a ordem e escolha o visual e a miniatura logo abaixo. Ao aprovar, o vídeo entra na fila de render e as músicas e o visual ficam travados.</p>
        ${problems.length ? html`<ul class="draft-warnings">${problems.map(p => html`<li>${p}</li>`)}</ul>` : ''}
        <div class="button-row">
          ${postButton(`${base}/approve`, 'Aprovar e renderizar', { cls: 'primary', disabled: problems.length > 0 })}
          <a class="button" href="#faixas">Revisar faixas</a>
          ${postButton(`${base}/discard`, 'Descartar rascunho', { confirm: 'Descartar este rascunho? As músicas e o visual voltam a ficar disponíveis.', cls: 'danger' })}
        </div>
      </section>`
    }
    case 'production': {
      const rendering = video.status === 'rendering'
      const ahead = rendering ? 0 : get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM videos
          WHERE status = 'rendering' OR (status = 'queued' AND approved_at IS NOT NULL AND id < ?)`,
        video.id,
      )!.n
      return html`<section class="card stage-panel" id="etapa">
        <div class="section-head"><div><span class="section-kicker">PRODUÇÃO</span><h2>${rendering ? 'Renderizando agora' : 'Na fila de render'}</h2></div></div>
        <p>${rendering
          ? `Começou em ${when(video.started_at)}. Quando terminar, o vídeo vai para a coluna Pronto e esta página se atualiza sozinha.`
          : `Aprovado em ${when(video.approved_at)}. ${ahead ? `${plural(ahead, 'vídeo', 'vídeos')} na frente.` : 'É o próximo a renderizar.'}`}</p>
        <div class="button-row">
          ${postButton(`${base}/discard`, 'Cancelar', { confirm: 'Cancelar este vídeo? As músicas e o visual voltam a ficar disponíveis.', cls: 'danger' })}
        </div>
      </section>`
    }
    case 'ready':
    case 'scheduled': {
      const downloaded = !!video.downloaded_at
      return html`<section class="card stage-panel ${stage}" id="etapa">
        <div class="section-head"><div><span class="section-kicker">${stage === 'ready' ? 'PRONTO' : 'AGENDADO'}</span>
          <h2>${stage === 'ready' ? 'Baixe, agende e publique' : `Publicação planejada para ${day(video.planned_date)}`}</h2></div></div>
        <div class="step-grid">
          <div class="step-block">
            <h3><span class="step-index" aria-hidden="true">1</span> Baixar</h3>
            <p class="section-note">${downloaded
              ? `Marcado como baixado em ${when(video.downloaded_at)}.`
              : 'Baixe o MP4 e a miniatura para subir no YouTube; depois marque como baixado.'}</p>
            <div class="button-row">
              ${hasFile ? html`<a class="button primary" href="${base}/download">Baixar vídeo${video.size ? ` · ${bytes(video.size)}` : ''}</a>` : ''}
              <a class="button" href="${base}/thumbnail">Baixar miniatura</a>
              <form method="post" action="${base}/downloaded" class="inline">
                <input type="hidden" name="downloaded" value="${downloaded ? '0' : '1'}">
                <button>${downloaded ? 'Desmarcar baixado' : 'Marcar como baixado'}</button>
              </form>
            </div>
          </div>
          <div class="step-block">
            <h3><span class="step-index" aria-hidden="true">2</span> Agendar</h3>
            <p class="section-note">${video.planned_date
              ? 'Mude a data ou remova o agendamento para voltar à coluna Pronto.'
              : 'Escolha o dia planejado; o vídeo passa para a coluna Agendado.'}</p>
            <form method="post" action="${base}/schedule" class="step-form">
              <label>Data planejada <input type="date" name="planned_date" required value="${video.planned_date ?? ''}"></label>
              <button>${video.planned_date ? 'Mudar data' : 'Agendar'}</button>
            </form>
            ${video.planned_date ? html`<form method="post" action="${base}/schedule" class="inline">
              <input type="hidden" name="planned_date" value="">
              <button class="small">Remover agendamento</button>
            </form>` : ''}
          </div>
          <form method="post" action="${base}/publish" class="step-block step-form">
            <h3><span class="step-index" aria-hidden="true">3</span> Publicar</h3>
            <p class="section-note">Depois de subir no YouTube, cole o link e a data em que o vídeo foi ao ar.</p>
            <label>Link do YouTube <input type="url" name="youtube_url" required autocomplete="off" spellcheck="false"
              placeholder="https://youtu.be/…" value="${video.youtube_url ?? ''}"></label>
            <label>Data de publicação <input type="date" name="published_date" required value="${video.planned_date ?? localDay(new Date())}"></label>
            <button class="primary">Marcar como publicado</button>
          </form>
        </div>
        <div class="button-row stage-footer">
          ${postButton(`${base}/discard`, 'Descartar vídeo', { confirm: 'Descartar este vídeo? O arquivo é apagado e as músicas e o visual voltam a ficar disponíveis.', cls: 'danger small' })}
        </div>
      </section>`
    }
    case 'published': {
      // Publicados antes da data manual só têm published_at (UTC): sugere o dia local dele.
      const date = video.published_date ?? (video.published_at ? localDay(new Date(`${video.published_at.replace(' ', 'T')}Z`)) : '')
      return html`<section class="card stage-panel published" id="etapa">
        <div class="section-head"><div><span class="section-kicker">PUBLICADO</span><h2>No ar desde ${publishedOn(video)}</h2></div>
          ${youtubeUrl ? html`<a class="button" href="${youtubeUrl}" target="_blank" rel="noopener noreferrer">Abrir no YouTube <span aria-hidden="true">↗</span></a>` : ''}</div>
        <div class="step-grid">
          <form method="post" action="${base}/publish" class="step-block step-form">
            <h3>Dados da publicação</h3>
            <label>Link do YouTube <input type="url" name="youtube_url" required autocomplete="off" spellcheck="false"
              placeholder="https://youtu.be/…" value="${video.youtube_url ?? ''}"></label>
            <label>Data de publicação <input type="date" name="published_date" required value="${date}"></label>
            <button>Salvar alterações</button>
          </form>
          <div class="step-block">
            <h3>Arquivos</h3>
            <p class="section-note">${hasFile
              ? 'Conferiu no YouTube? Apague o arquivo para liberar espaço; o histórico continua.'
              : 'Arquivo apagado; histórico e miniatura continuam disponíveis.'}</p>
            <div class="button-row">
              <a class="button" href="${base}/thumbnail">Baixar miniatura</a>
              ${hasFile ? html`<a class="button" href="${base}/download">Baixar vídeo</a>` : ''}
              ${hasFile ? postButton(`${base}/unpublish`, 'Desmarcar publicado') : ''}
              ${hasFile ? postButton(`${base}/delete-file`, 'Apagar arquivo', { confirm: 'Apagar o arquivo pra liberar espaço? O histórico continua.', cls: 'danger' }) : ''}
            </div>
          </div>
        </div>
      </section>`
    }
    case 'error':
      return html`<section class="card stage-panel failed" id="etapa">
        <div class="section-head"><div><span class="section-kicker">ERRO</span><h2>O render falhou</h2></div></div>
        <p>Tentar de novo devolve o vídeo à fila. Descartar libera as músicas e o visual. Enquanto houver erro, o automático deste canal fica pausado.</p>
        ${video.error ? html`<pre class="error-box">${video.error}</pre>` : ''}
        <div class="button-row">
          ${postButton(`${base}/retry`, 'Tentar de novo', { cls: 'primary' })}
          ${postButton(`${base}/discard`, 'Descartar', { confirm: 'Descartar este vídeo?', cls: 'danger' })}
        </div>
      </section>`
  }
}

function imageSection(video: Video, ch: Channel, visual: Visual, thumb: Visual, draft: boolean): Html {
  const options = all<VisualRow>(
    `SELECT v.*, (SELECT COUNT(*) FROM videos x WHERE x.visual_id = v.id AND x.id <> ?) AS uses
       FROM visuals v WHERE channel_id = ? AND status = 'ready' AND deleted_at IS NULL ORDER BY id DESC`,
    video.id, video.channel_id,
  )
  // Mesma regra de jobs.setDraftVisual: sem reaproveitar, só visuais que nenhum outro vídeo usa.
  const backgrounds = options.filter(v => ch.reuse_visuals || !v.uses || v.id === visual.id)
  const hidden = options.length - backgrounds.length
  return html`<section class="card" id="visual">
    <div class="section-head"><div><span class="section-kicker">IMAGEM</span><h2>${draft ? 'Visual e miniatura' : 'Miniatura do YouTube'}</h2></div>
      <a class="button small" href="/videos/${video.id}/thumbnail">Baixar miniatura</a></div>
    <p class="section-note">${draft
      ? 'O visual é o fundo em loop do vídeo. A miniatura é a imagem que você envia ao YouTube; se não escolher outra, vale o próprio visual.'
      : 'O vídeo renderizado não muda: aqui você escolhe só a imagem que vai como miniatura no YouTube.'}</p>
    ${draft ? visualChoices(video, 'visual', 'Visual do vídeo', visual, backgrounds, 'Usar este visual', hidden
      ? `${hidden === 1 ? '1 visual já usado em outro vídeo fica' : `${hidden} visuais já usados em outros vídeos ficam`} de fora (reaproveitar visuais está desligado nos Ajustes).`
      : '') : ''}
    ${visualChoices(video, 'thumbnail', 'Miniatura', thumb, options, 'Usar como miniatura', '')}
  </section>`
}

function visualChoices(video: Video, kind: 'visual' | 'thumbnail', title: string, current: Visual, options: VisualRow[], button: string, note: string): Html {
  return html`<details class="picker" data-key="video:${video.id}:${kind}">
    <summary><strong>${title}</strong><span class="muted">#${current.id} ${current.title}${current.deleted_at ? ' (excluído)' : ''}</span></summary>
    ${options.length ? html`<form method="post" action="/videos/${video.id}/${kind}" class="picker-form">
      <fieldset>
        <legend class="sr-only">${title}</legend>
        <div class="visual-options">${options.map(v => html`<div class="visual-option">
          <label><input type="radio" name="visual_id" value="${v.id}" required ${v.id === current.id ? 'checked' : ''}>
            <img src="/visuals/${v.id}/thumb" alt="" loading="lazy">
            <span class="visual-option-title"><span class="muted">#${v.id}</span> ${v.title}</span>
            <span class="muted">${v.kind === 'image' ? 'Imagem' : 'Vídeo em loop'} · ${v.uses ? `em ${plural(v.uses, 'outro vídeo', 'outros vídeos')}` : 'nunca usado'}</span></label>
          ${kind === 'visual' ? html`<a href="/visuals/${v.id}/loop" target="_blank" rel="noopener">Ver loop <span aria-hidden="true">↗</span></a>` : ''}
        </div>`)}</div>
      </fieldset>
      ${note ? html`<p class="section-note">${note}</p>` : ''}
      <button class="primary">${button}</button>
    </form>` : html`<p class="style-empty">Nenhum visual pronto neste canal.</p>`}
  </details>`
}

function tracksSection(video: Video, ch: Channel, songs: TrackRow[], draft: boolean): Html {
  const tracklist = songs.map(s => `${clock(s.start)} ${s.title}`).join('\n')
  return html`<section class="card" id="faixas">
    <div class="section-head"><div><span class="section-kicker">SEQUÊNCIA</span><h2>${draft ? 'Revisar faixas' : 'Músicas do mix'}</h2></div>
      <span class="section-note">${plural(songs.length, 'faixa', 'faixas')} · ${clock(video.duration)}</span></div>
    ${draft ? trackEditor(video, ch, songs) : html`<div class="scroll"><table class="compact">
      <thead><tr><th>#</th><th>Início</th><th>Música</th><th>Duração no mix</th></tr></thead>
      <tbody>${songs.map((s, i) => html`<tr>
        <td>${i + 1}</td><td>${clock(s.start)}</td>
        <td>${s.title}${s.deleted_at ? html` <span class="muted">(excluída)</span>` : ''}</td><td>${clock(s.mix_duration)}</td>
      </tr>`)}</tbody>
    </table></div>`}
    <div class="tracklist-head"><div><h3>Tracklist para copiar</h3>
      <p class="section-note">${draft
        ? 'Os horários se ajustam sozinhos quando você muda a ordem ou troca uma faixa.'
        : 'Vídeo importado manualmente? Confira a ordem e os horários antes de usar esta lista.'}</p></div>
      <button type="button" data-copy="tracklist">Copiar lista</button></div>
    <textarea id="tracklist" readonly rows="4" aria-label="Tracklist do vídeo">${tracklist}</textarea>
  </section>`
}

function trackEditor(video: Video, ch: Channel, songs: TrackRow[]): Html {
  // Mesma regra de jobs.replaceDraftSong: mesmo estilo, ativa, fora deste mix e, sem reaproveitar, nunca usada.
  const replacements = all<SongRow>(
    `SELECT s.*, (SELECT COUNT(*) FROM video_songs vs WHERE vs.song_id = s.id AND vs.video_id <> ?) AS uses
       FROM songs s
      WHERE s.channel_id = ? AND s.style = ? AND s.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM video_songs mine WHERE mine.video_id = ? AND mine.song_id = s.id)
      ORDER BY uses, s.title, s.id`,
    video.id, video.channel_id, video.style, video.id,
  ).filter(s => ch.reuse_songs || !s.uses)
  const firstMissing = songs.find(s => s.deleted_at)?.position
  return html`<p class="section-note">Ouça antes de aprovar. As setas trocam a faixa de lugar com a vizinha; os horários de início se ajustam sozinhos.</p>
    <ol class="track-list">${songs.map((s, i) => html`<li class="track${s.deleted_at ? ' is-missing' : ''}">
      <span class="track-num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
      <div class="track-info">
        <strong>${s.title}</strong>
        <span class="muted">Início ${clock(s.start)} · ${clock(s.mix_duration)} no mix${s.tail_trim_seconds ? html` · original ${clock(s.duration)}` : ''}</span>
        ${s.deleted_at ? html`<span class="err">Excluída da biblioteca: troque esta faixa.</span>` : ''}
      </div>
      ${s.deleted_at ? '' : html`<audio class="track-audio" controls preload="none" src="/songs/${s.id}/file" aria-label="Ouvir ${s.title}"></audio>`}
      <form method="post" action="/videos/${video.id}/reorder" class="track-move">
        <input type="hidden" name="position" value="${s.position}">
        <button name="direction" value="-1" title="Subir" aria-label="Subir faixa ${i + 1}: ${s.title}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button name="direction" value="1" title="Descer" aria-label="Descer faixa ${i + 1}: ${s.title}" ${i === songs.length - 1 ? 'disabled' : ''}>↓</button>
      </form>
    </li>`)}</ol>
    ${replacements.length ? html`<form method="post" action="/videos/${video.id}/replace-song" class="replace-form">
      <div><h3>Trocar uma faixa</h3>
        <p class="section-note">${ch.reuse_songs
          ? `Músicas de ${styleName(video.style)} que ainda não estão neste mix, menos usadas primeiro.`
          : `Músicas de ${styleName(video.style)} que ainda não estão em nenhum vídeo.`}</p></div>
      <label>Faixa
        <select name="position">${songs.map((s, i) => html`<option value="${s.position}" ${s.position === firstMissing ? 'selected' : ''}>${String(i + 1).padStart(2, '0')} · ${s.title}</option>`)}</select>
      </label>
      <label>Nova música
        <select name="song_id">${replacements.map(s => html`<option value="${s.id}">${s.title} · ${clock(s.duration)} · ${s.uses ? plural(s.uses, 'uso', 'usos') : 'nova'}</option>`)}</select>
      </label>
      <button>Trocar faixa</button>
    </form>` : html`<p class="replace-empty">Nenhuma outra música de <b>${styleName(video.style)}</b> disponível para troca.
      <a href="/channels/${ch.id}/upload">Enviar músicas →</a></p>`}`
}
