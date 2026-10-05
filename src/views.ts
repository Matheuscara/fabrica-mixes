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
  return `${Math.round(n / 2 ** 20)} MB`
}

/** SQLite guarda UTC "YYYY-MM-DD HH:MM:SS"; mostra no fuso do servidor (TZ). */
function when(sqlite: string | null): string {
  if (!sqlite) return '—'
  return new Date(`${sqlite.replace(' ', 'T')}Z`).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
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
            (SELECT COALESCE(group_concat(id || status || file_deleted, ','), '') FROM videos) AS sig`,
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
  const { queued } = get<{ queued: number }>("SELECT COUNT(*) AS queued FROM videos WHERE status = 'queued'")!
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

const STATUS_LABEL: Record<VideoStatus, string> = {
  queued: 'na fila',
  rendering: 'renderizando',
  done: 'pronto',
  published: 'publicado',
  failed: 'erro',
}

function statusBadge(video: Video): Html {
  return html`<span class="badge ${video.status}">${STATUS_LABEL[video.status]}</span>
    ${video.status === 'rendering' ? progress(video) : ''}`
}

function postButton(action: string, label: string, opts: { confirm?: string; cls?: string } = {}): Html {
  return html`<form method="post" action="${action}" class="inline" ${opts.confirm ? html`data-confirm="${opts.confirm}"` : ''}>
    <button class="${opts.cls ?? ''}">${label}</button></form>`
}

// ── Página inicial ──────────────────────────────────────────────────

export function dashboardPage(): Html {
  const channels = all<Channel>('SELECT * FROM channels ORDER BY name')
  const cards = channels.map(ch => {
    const cap = capacity(ch)
    const fresh = cap.styles.reduce((sum, p) => sum + p.fresh, 0)
    const videos = get<{ ready: number; queue: number }>(
      `SELECT COALESCE(SUM(status = 'done'), 0) AS ready, COALESCE(SUM(status IN ('queued', 'rendering')), 0) AS queue
         FROM videos WHERE channel_id = ?`,
      ch.id,
    )!
    return html`<a class="card channel" href="/channels/${ch.id}">
      <div class="channel-top"><span class="eyebrow">CANAL ${String(ch.id).padStart(2, '0')}</span>${autoBadge(ch)}</div>
      <h2>${ch.name}</h2>
      <p class="page-subtitle">${ch.description || 'Seu espaço para músicas, visuais e mixes.'}</p>
      <dl class="stats">
        <div><dt>Vídeos prontos</dt><dd>${videos.ready}</dd></div>
        <div><dt>Em produção</dt><dd>${videos.queue}</dd></div>
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

interface VideoSummary {
  queued: number
  rendering: number
  done: number
  published: number
  failed: number
}

function overviewCharts(ch: Channel, stats: VideoSummary, cap: Capacity): Html {
  const stages = [
    { status: 'done', name: 'Prontos', value: stats.done },
    { status: 'published', name: 'Publicados', value: stats.published },
    { status: 'rendering', name: 'Renderizando', value: stats.rendering },
    { status: 'queued', name: 'Na fila', value: stats.queued },
    { status: 'failed', name: 'Com erro', value: stats.failed },
  ]
  const totalVideos = stages.reduce((sum, stage) => sum + stage.value, 0)
  let offset = 0
  const segments = stages.filter(stage => stage.value > 0).map(stage => {
    const share = (stage.value / totalVideos) * 100
    const circle = html`<circle class="chart-segment ${stage.status}" cx="21" cy="21" r="15.9" pathLength="100"
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
        <ul class="chart-legend">${stages.map(stage => html`<li><span class="legend-dot ${stage.status}" aria-hidden="true"></span>
          <span>${stage.name}</span><strong>${stage.value}</strong></li>`)}</ul>
      </div>
      <p class="section-note">Acompanhe o que está pronto, publicado ou ainda na fila.</p>
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
      const stats = get<VideoSummary>(
        `SELECT COALESCE(SUM(status = 'queued'), 0) AS queued,
                COALESCE(SUM(status = 'rendering'), 0) AS rendering,
                COALESCE(SUM(status = 'done'), 0) AS done,
                COALESCE(SUM(status = 'published'), 0) AS published,
                COALESCE(SUM(status = 'failed'), 0) AS failed
          FROM videos WHERE channel_id = ?`, ch.id,
      )!
      const freshSongs = cap!.styles.reduce((sum, p) => sum + p.fresh, 0)
      const bestPool = Math.max(0, ...cap!.styles.map(p => ch.reuse_songs ? p.total : p.fresh))
      const missingSongs = Math.max(0, ch.songs_per_video - bestPool)
      const missingVisual = ch.reuse_visuals ? !cap!.visuals.ready : !cap!.visuals.fresh
      const recent = videoRows(ch.id, 3)
      body = html`
        <div class="overview-grid" aria-label="Resumo do canal">
          <div class="metric is-ok"><span class="metric-label">Prontos para baixar</span><strong class="metric-value">${stats.done}</strong><span class="metric-foot">Vídeos finalizados</span></div>
          <div class="metric"><span class="metric-label">Em produção</span><strong class="metric-value">${stats.queued + stats.rendering}</strong><span class="metric-foot">Na fila ou renderizando</span></div>
          <div class="metric ${missingSongs ? 'is-warn' : ''}"><span class="metric-label">Músicas novas</span><strong class="metric-value">${freshSongs}</strong><span class="metric-foot">${ch.songs_per_video} do mesmo estilo por vídeo</span></div>
          <div class="metric ${missingVisual ? 'is-warn' : ''}"><span class="metric-label">Visuais novos</span><strong class="metric-value">${cap!.visuals.fresh}</strong><span class="metric-foot">Imagens ou loops disponíveis</span></div>
        </div>
        ${cap!.videos === 0 ? html`<aside class="surface-highlight" aria-label="Próximo passo">
          <div><span class="section-kicker">PRÓXIMO PASSO</span><h2>Mais material para o próximo mix</h2>
            <p>${missingSongs ? html`Faltam pelo menos <b>${missingSongs} ${missingSongs === 1 ? 'música' : 'músicas'}</b> de um mesmo estilo.` : ''}
              ${missingVisual ? 'Envie também um visual novo.' : ''} Os vídeos prontos continuam disponíveis para baixar.</p></div>
          <a class="button primary" href="${base}/upload">Enviar material <span aria-hidden="true">↗</span></a>
        </aside>` : html`<aside class="surface-highlight ready">
          <div><span class="section-kicker">PRONTO PARA PRODUZIR</span><h2>Material para ${plural(cap!.videos, 'novo mix', 'novos mixes')}.</h2>
            <p>Escolha um estilo ou deixe o sorteio revezar automaticamente.</p></div>
          <a class="button primary" href="${base}/produce">Gerar vídeo <span aria-hidden="true">↗</span></a>
        </aside>`}
        ${overviewCharts(ch, stats, cap!)}
        ${videosSection(recent, base, 'Últimos vídeos')}
        <a class="button" href="${base}/videos">Ver todos os vídeos →</a>`
      break
    }
    case 'videos':
      title = 'Vídeos'
      subtitle = `Histórico e andamento dos mixes de ${ch.name}.`
      body = videosSection(videoRows(ch.id), base)
      break
    case 'produce': {
      title = 'Produzir'
      subtitle = 'Escolha um estilo e coloque novos mixes na fila.'
      const songs = all<Song>('SELECT * FROM songs WHERE channel_id = ? AND deleted_at IS NULL', ch.id)
      body = generateSection(ch, cap!, songs)
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

function generateSection(ch: Channel, cap: Capacity, songs: Song[]): Html {
  const n = ch.songs_per_video
  const avg = songs.length ? songs.reduce((sum, s) => sum + s.duration, 0) / songs.length : 0
  return html`<section class="card" id="gerar">
    <div class="section-head"><div><span class="section-kicker">PRODUÇÃO</span><h2>Preparar o próximo mix</h2></div>
      <span class="badge ${cap.videos ? 'done' : 'queued'}">${cap.videos ? `${count(cap.videos)} possíveis` : 'Aguardando material'}</span></div>
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
      <button class="primary" ${cap.videos ? '' : 'disabled'}>Gerar vídeo <span aria-hidden="true">↗</span></button>
    </form>
    <p class="section-note">${autoLine(ch, cap.videos)}</p>
  </section>`
}

function autoLine(ch: Channel, possible: number): string {
  if (!ch.auto_enabled) return `Automático desligado. Ligue em Configurações pra manter ${ch.auto_buffer} vídeos prontos o tempo todo.`
  if (hasFailedVideo(ch.id)) return 'Automático pausado: tem vídeo com erro. Tente de novo ou descarte ele.'
  const { pending } = get<{ pending: number }>(
    `SELECT COUNT(*) AS pending FROM videos WHERE channel_id = ? AND status IN ('queued', 'rendering', 'done')`,
    ch.id,
  )!
  if (pending < ch.auto_buffer && !possible) return `Automático esperando material novo (${pending}/${ch.auto_buffer} vídeos prontos ou na fila).`
  return `Automático ligado: mantém ${ch.auto_buffer} vídeos não publicados (agora ${pending}). Publicou ou descartou, ele gera outro.`
}

function videosSection(videos: VideoRow[], base: string, heading = 'Seus vídeos'): Html {
  const rows = videos.map(v => html`<tr>
    <td class="video-cover"><a href="/videos/${v.id}" aria-label="Abrir vídeo ${v.number}"><img class="thumb" src="/visuals/${v.visual_id}/thumb" alt="" loading="lazy"></a></td>
    <td class="video-main"><a href="/videos/${v.id}"><b>Mix #${v.number}</b></a><small title="${v.visual_title}">${v.visual_title}</small></td>
    <td data-label="Estilo">${styleName(v.style)}</td>
    <td data-label="Status">${statusBadge(v)}</td>
    <td data-label="Duração">${clock(v.duration)}</td>
    <td data-label="Faixas">${v.songs} músicas</td>
    <td class="muted" data-label="Criado">${when(v.created_at)}</td>
    <td class="nowrap video-actions">
      ${v.file && !v.file_deleted ? html`<a class="button primary" href="/videos/${v.id}/download">Baixar</a>` : ''}
      <a href="/videos/${v.id}">Ver detalhes <span aria-hidden="true">↗</span></a>
    </td>
  </tr>`)
  return html`<section class="card" id="videos">
    <div class="section-head"><div><span class="section-kicker">ACOMPANHAMENTO</span><h2>${heading}</h2></div>
      <span class="section-note">${videos.length} ${videos.length === 1 ? 'vídeo' : 'vídeos'} ${heading === 'Últimos vídeos' ? 'mais recentes' : 'no histórico'}</span></div>
    ${videos.length
      ? html`<div class="scroll"><table class="video-table"><thead><tr><th></th><th>Vídeo</th><th>Estilo</th><th>Status</th><th>Duração</th><th>Faixas</th><th>Criado</th><th>Ações</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
      : html`<div class="empty-state"><h3>Nenhum vídeo ainda</h3><p>Envie músicas e visuais. Quando gerar o primeiro mix, ele vai aparecer aqui.</p><a class="button" href="${base}/upload">Enviar arquivos</a></div>`}
  </section>`
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
            ${style.prompt ? html`<a class="button suno-action" href="https://suno.com/create" target="_blank"
              rel="noopener noreferrer" data-suno-prompt="prompt-${style.id}">Copiar e abrir Suno ↗</a>` : ''}
          </div>
        </form>
        <p class="section-note">Receita deste estilo para gerar novas faixas no seu PC. Alterações aqui não mudam músicas já geradas.</p>
      </div>
      ${list.length ? html`<div class="scroll"><table class="compact">
        <thead><tr><th>Música</th><th>Duração</th><th>Usos</th><th>Enviada</th><th></th></tr></thead>
        <tbody>${list.map(s => html`<tr>
          <td>${s.title}</td><td>${clock(s.duration)}</td>
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
    <div class="suno-flow">
      <span class="section-kicker">GERAR COM SUNO PRO</span>
      <p>Abra um estilo e clique em <b>Copiar e abrir Suno</b>. Cole o texto em <b>Style</b>, marque
        <b>Instrumental</b> e gere suas variações. Depois de escolher as melhores, faça o download pelo
        menu oficial do Suno e <a href="${base}/upload">envie as músicas aqui</a>.</p>
      <p class="section-note">No Pro, a <a href="https://help.suno.com/en/articles/13614785" target="_blank" rel="noopener noreferrer">FAQ da Suno</a>
        informa 20 músicas distintas para download por mês. Gerar variações não aumenta esse limite de exportação.</p>
    </div>
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
    <p class="section-note">Essas opções valem para os próximos vídeos; os que já estão prontos não mudam.</p>
    <form method="post" action="/channels/${ch.id}/settings" class="stack">
      <label>Nome <input name="name" value="${ch.name}" required maxlength="100"></label>
      <label>Tema / descrição <input name="description" value="${ch.description}" maxlength="300"></label>
      <label>Músicas por vídeo <input type="number" name="songs_per_video" value="${ch.songs_per_video}" min="1" max="500"></label>
      <label class="check"><input type="checkbox" name="reuse_songs" ${ch.reuse_songs ? 'checked' : ''}>
        Reaproveitar músicas já usadas (escolhe as menos usadas primeiro)</label>
      <label class="check"><input type="checkbox" name="reuse_visuals" ${ch.reuse_visuals ? 'checked' : ''}>
        Reaproveitar visuais já usados</label>
      <label class="check"><input type="checkbox" name="auto_enabled" ${ch.auto_enabled ? 'checked' : ''}>
        Gerar automaticamente quando houver material</label>
      <label>Manter até quantos vídeos não publicados <input type="number" name="auto_buffer" value="${ch.auto_buffer}" min="1" max="50"></label>
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

export function videoPage(video: Video): Html {
  const ch = get<Channel>('SELECT * FROM channels WHERE id = ?', video.channel_id)!
  const visual = get<Visual>('SELECT * FROM visuals WHERE id = ?', video.visual_id)!
  const songs = all<Song & { start: number }>(
    `SELECT s.*, vs.start FROM video_songs vs JOIN songs s ON s.id = vs.song_id WHERE vs.video_id = ? ORDER BY vs.position`,
    video.id,
  )
  const tracklist = songs.map(s => `${clock(s.start)} ${s.title}`).join('\n')
  const hasFile = !!video.file && !video.file_deleted
  const actions: Value[] = []
  if (hasFile) actions.push(html`<a class="button primary" href="/videos/${video.id}/download">Baixar ${video.size ? bytes(video.size) : ''}</a>`)
  if (video.status === 'done') {
    actions.push(postButton(`/videos/${video.id}/publish`, 'Marcar como publicado'))
    actions.push(postButton(`/videos/${video.id}/discard`, 'Descartar', { confirm: 'Descartar este vídeo? As músicas e o visual voltam a ficar disponíveis.', cls: 'danger' }))
  }
  if (video.status === 'published') {
    if (hasFile) actions.push(postButton(`/videos/${video.id}/unpublish`, 'Desmarcar publicado'))
    if (hasFile) actions.push(postButton(`/videos/${video.id}/delete-file`, 'Apagar arquivo', { confirm: 'Apagar o arquivo pra liberar espaço? O histórico continua.', cls: 'danger' }))
  }
  if (video.status === 'queued' || video.status === 'rendering') {
    actions.push(postButton(`/videos/${video.id}/discard`, 'Cancelar', { confirm: 'Cancelar este vídeo? As músicas e o visual voltam a ficar disponíveis.', cls: 'danger' }))
  }
  if (video.status === 'failed') {
    actions.push(postButton(`/videos/${video.id}/retry`, 'Tentar de novo', { cls: 'primary' }))
    actions.push(postButton(`/videos/${video.id}/discard`, 'Descartar', { confirm: 'Descartar este vídeo?', cls: 'danger' }))
  }
  return channelShell(ch, 'videos', html`
    <div class="page-head">
      <a class="back-link" href="/channels/${ch.id}/videos">← Voltar aos vídeos</a>
      <span class="eyebrow">VÍDEO / ${styleName(video.style)}</span>
      <div class="page-title-row"><h1>Mix #${video.number}<span class="heading-dot">.</span></h1>${statusBadge(video)}</div>
      <p class="page-subtitle">${clock(video.duration)} · ${songs.length} músicas · visual #${visual.id}</p>
    </div>
    ${video.error ? html`<pre class="error-box">${video.error}</pre>` : ''}
    <div class="video-layout">
      <div class="card player-card">
        ${hasFile
          ? html`<video controls preload="metadata" src="/videos/${video.id}/file" poster="/visuals/${visual.id}/thumb"></video>`
          : html`<img class="poster" src="/visuals/${visual.id}/thumb" alt="">`}
        <div class="button-row video-controls">${actions}</div>
      </div>
      <aside class="card video-facts">
        <span class="section-kicker">FICHA DO MIX</span>
        <h2>Detalhes</h2>
        <dl class="facts">
          <dt>Estilo</dt><dd>${styleName(video.style)}</dd>
          <dt>Duração</dt><dd>${clock(video.duration)}</dd>
          <dt>Visual</dt><dd><span class="muted">#${visual.id}</span> ${visual.title} <span class="muted">(${visual.kind === 'image' ? 'imagem' : 'vídeo'}${visual.deleted_at ? ', excluído' : ''})</span></dd>
          <dt>Criado</dt><dd>${when(video.created_at)}</dd>
          <dt>Finalizado</dt><dd>${when(video.finished_at)}</dd>
          <dt>Publicado</dt><dd>${when(video.published_at)}</dd>
          ${video.file_deleted ? html`<dt>Arquivo</dt><dd class="muted">apagado; histórico preservado</dd>` : ''}
        </dl>
      </aside>
    </div>
    <section class="card">
      <div class="section-head"><div><span class="section-kicker">SEQUÊNCIA</span><h2>Músicas do mix</h2></div>
        <span class="section-note">${songs.length} faixas</span></div>
      <div class="scroll"><table class="compact">
        <thead><tr><th>#</th><th>Início</th><th>Música</th><th>Duração</th></tr></thead>
        <tbody>${songs.map((s, i) => html`<tr>
          <td>${i + 1}</td><td>${clock(s.start)}</td>
          <td>${s.title}${s.deleted_at ? html` <span class="muted">(excluída)</span>` : ''}</td><td>${clock(s.duration)}</td>
        </tr>`)}</tbody>
      </table></div>
      <div class="tracklist-head"><div><h3>Tracklist para copiar</h3>
        <p class="section-note">Vídeo importado manualmente? Confira a ordem e os horários antes de usar esta lista.</p></div>
        <button type="button" data-copy="tracklist">Copiar lista</button></div>
      <textarea id="tracklist" readonly rows="4" aria-label="Tracklist do vídeo">${tracklist}</textarea>
    </section>`)
}
