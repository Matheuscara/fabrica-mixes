import { createHash } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { DATA_DIR } from './config.ts'
import { all, get, type Channel, type Song, type Video, type VideoStatus, type Visual } from './db.ts'
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
    <a href="/" class="brand">Fábrica de Mixes</a>
    <span class="worker">${workerStatus()}</span>
    <span class="muted disk">${bytes(bavail * bsize)} livres</span>
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
    const total = cap.styles.reduce((sum, p) => sum + p.total, 0)
    const videos = get<{ ready: number; queue: number }>(
      `SELECT COALESCE(SUM(status = 'done'), 0) AS ready, COALESCE(SUM(status IN ('queued', 'rendering')), 0) AS queue
         FROM videos WHERE channel_id = ?`,
      ch.id,
    )!
    return html`<a class="card channel" href="/channels/${ch.id}">
      <h2>${ch.name}</h2>
      ${ch.description ? html`<p class="muted">${ch.description}</p>` : ''}
      <dl class="stats">
        <div><dt>Músicas novas</dt><dd>${fresh} / ${total}</dd></div>
        <div><dt>Visuais novos</dt><dd>${cap.visuals.fresh} / ${cap.visuals.ready}</dd></div>
        <div><dt>Prontos</dt><dd>${videos.ready}</dd></div>
        <div><dt>Na fila</dt><dd>${videos.queue}</dd></div>
      </dl>
      <p class="muted">${autoBadge(ch)} · material pra ${plural(cap.videos, 'vídeo', 'vídeos')}</p>
    </a>`
  })
  return html`
    <h1>Canais</h1>
    <div class="grid">${cards}</div>
    ${channels.length ? '' : html`<p class="muted">Nenhum canal ainda.</p>`}
    <section class="card">
      <h2>Novo canal</h2>
      <form method="post" action="/channels" class="stack">
        <label>Nome <input name="name" required maxlength="100" placeholder="ex: Lofi Gatinhos"></label>
        <label>Tema / descrição <input name="description" maxlength="300" placeholder="ex: lofi jazz com gatos, 1 vídeo por dia"></label>
        <button>Criar canal</button>
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

export function channelPage(ch: Channel): Html {
  const cap = capacity(ch)
  const videos = all<VideoRow>(
    `SELECT v.*, vis.title AS visual_title, (SELECT COUNT(*) FROM video_songs vs WHERE vs.video_id = v.id) AS songs
       FROM videos v JOIN visuals vis ON vis.id = v.visual_id
      WHERE v.channel_id = ? ORDER BY v.id DESC LIMIT 100`,
    ch.id,
  )
  const songs = all<SongRow>(
    `SELECT s.*, (SELECT COUNT(*) FROM video_songs vs WHERE vs.song_id = s.id) AS uses
       FROM songs s WHERE channel_id = ? AND deleted_at IS NULL ORDER BY style, created_at, id`,
    ch.id,
  )
  const visuals = all<VisualRow>(
    `SELECT v.*, (SELECT COUNT(*) FROM videos x WHERE x.visual_id = v.id) AS uses
       FROM visuals v WHERE channel_id = ? AND deleted_at IS NULL ORDER BY id DESC`,
    ch.id,
  )
  return html`
    <h1>${ch.name} ${autoBadge(ch)}</h1>
    ${ch.description ? html`<p class="muted">${ch.description}</p>` : ''}
    <nav class="tabs">
      <a href="#gerar">Gerar</a><a href="#videos">Vídeos (${videos.length})</a><a href="#enviar">Enviar</a>
      <a href="#visuais">Visuais (${visuals.length})</a><a href="#musicas">Músicas (${songs.length})</a><a href="#config">Configurações</a>
    </nav>
    ${generateSection(ch, cap, songs)}
    ${videosSection(videos)}
    ${uploadSection(ch, cap.styles.map(p => p.style))}
    ${visualsSection(visuals)}
    ${songsSection(songs)}
    ${settingsSection(ch)}`
}

function generateSection(ch: Channel, cap: Capacity, songs: SongRow[]): Html {
  const n = ch.songs_per_video
  const avg = songs.length ? songs.reduce((sum, s) => sum + s.duration, 0) / songs.length : 0
  const rule = ch.reuse_songs ? 'reaproveitando músicas (menos usadas primeiro)' : 'sem repetir música'
  const visualRule = ch.reuse_visuals ? 'reaproveitando visuais' : 'sem repetir visual'
  return html`<section class="card" id="gerar">
    <h2>Gerar vídeo</h2>
    <p>Cada vídeo: <b>${n} músicas do mesmo estilo</b>${avg ? html` (~${Math.round((avg * n) / 60)} min)` : ''} + 1 visual,
      ${rule}, ${visualRule}.</p>
    <table class="compact">
      <thead><tr><th>Estilo</th><th>Novas</th><th>Total</th><th>Dá pra fazer</th></tr></thead>
      <tbody>${cap.styles.map(p => html`<tr><td>${styleName(p.style)}</td><td>${p.fresh}</td><td>${p.total}</td><td>${plural(p.videos, 'vídeo', 'vídeos')}</td></tr>`)}</tbody>
    </table>
    <p>Visuais: <b>${cap.visuals.fresh}</b> novos de ${cap.visuals.ready} prontos${cap.visuals.preparing ? html` · ${cap.visuals.preparing} preparando` : ''}${cap.visuals.failed ? html` · <span class="err">${cap.visuals.failed} com erro</span>` : ''}.
      Material atual: <b>${plural(cap.videos, 'vídeo', 'vídeos')}</b>.</p>
    <form method="post" action="/channels/${ch.id}/generate" class="row">
      <select name="style">
        <option value="auto">Automático (reveza estilos)</option>
        ${cap.styles.map(p => html`<option value="s:${p.style}">${styleName(p.style)} (${count(p.videos)})</option>`)}
      </select>
      <label class="row">Quantidade <input type="number" name="count" value="1" min="1" max="50"></label>
      <button ${cap.videos ? '' : 'disabled'}>Gerar</button>
    </form>
    <p class="muted">${autoLine(ch, cap.videos)}</p>
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

function videosSection(videos: VideoRow[]): Html {
  const rows = videos.map(v => html`<tr>
    <td><a href="/videos/${v.id}"><img class="thumb" src="/visuals/${v.visual_id}/thumb" alt="" loading="lazy"></a></td>
    <td><a href="/videos/${v.id}"><b>#${v.number}</b></a></td>
    <td>${styleName(v.style)}</td>
    <td>${statusBadge(v)}</td>
    <td>${clock(v.duration)}</td>
    <td>${v.songs} músicas</td>
    <td class="muted">${when(v.created_at)}</td>
    <td class="nowrap">
      ${v.file && !v.file_deleted ? html`<a class="button" href="/videos/${v.id}/download">Baixar</a>` : ''}
      <a href="/videos/${v.id}">Detalhes</a>
    </td>
  </tr>`)
  return html`<section class="card" id="videos">
    <h2>Vídeos</h2>
    ${videos.length
      ? html`<div class="scroll"><table><thead><tr><th></th><th>#</th><th>Estilo</th><th>Status</th><th>Duração</th><th></th><th>Criado</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
      : html`<p class="muted">Nenhum vídeo ainda.</p>`}
  </section>`
}

function uploadSection(ch: Channel, styles: string[]): Html {
  return html`<section class="card" id="enviar">
    <h2>Enviar arquivos</h2>
    <form class="upload" data-upload="/channels/${ch.id}/upload" data-accept="${ACCEPTED_EXT}" onsubmit="return false">
      <label>Estilo das músicas soltas
        <input name="style" list="styles" maxlength="80" placeholder="ex: lofi-jazz-lounge">
      </label>
      <datalist id="styles">${styles.filter(Boolean).map(s => html`<option value="${s}">`)}</datalist>
      <div class="dropzone">
        <p>Arraste músicas, imagens, vídeos ou <b>pastas</b> aqui</p>
        <p class="muted">Música dentro de pasta usa o nome da pasta como estilo (ex: <code>lofi-jazz-lounge/</code>).
          Imagem/vídeo vira visual do canal. Arquivo repetido é ignorado.</p>
        <label class="button">Escolher arquivos<input type="file" multiple hidden accept="${ACCEPTED_EXT}"></label>
        <label class="button">Escolher pasta<input type="file" webkitdirectory hidden></label>
      </div>
      <p class="upload-summary"></p>
      <ul class="upload-log"></ul>
    </form>
  </section>`
}

function visualsSection(visuals: VisualRow[]): Html {
  const cards = visuals.map(v => html`<figure class="visual">
    ${v.status === 'ready'
      ? html`<a href="/visuals/${v.id}/loop" target="_blank"><img src="/visuals/${v.id}/thumb" alt="" loading="lazy"></a>`
      : html`<div class="placeholder ${v.status}">${v.status === 'failed' ? 'erro' : 'preparando…'}</div>`}
    <figcaption>
      <span title="${v.title}"><span class="muted">#${v.id}</span> ${v.title}</span>
      <span class="muted">${v.kind === 'image' ? 'imagem' : 'vídeo'} · ${v.uses ? plural(v.uses, 'uso', 'usos') : 'novo'}</span>
      ${v.error ? html`<details><summary class="err">ver erro</summary><pre>${v.error}</pre></details>` : ''}
      <span class="actions">
        ${v.status === 'failed' ? postButton(`/visuals/${v.id}/retry`, 'Tentar de novo') : ''}
        ${postButton(`/visuals/${v.id}/delete`, 'Excluir', { confirm: `Excluir o visual "${v.title}"?`, cls: 'danger small' })}
      </span>
    </figcaption>
  </figure>`)
  return html`<section class="card" id="visuais">
    <h2>Visuais</h2>
    ${visuals.length ? html`<div class="visuals">${cards}</div>` : html`<p class="muted">Nenhum visual ainda. Envie imagens ou vídeos curtos em loop.</p>`}
  </section>`
}

function songsSection(songs: SongRow[]): Html {
  const byStyle = Map.groupBy(songs, s => s.style)
  const groups = [...byStyle].map(([style, list]) => {
    const fresh = list.filter(s => !s.uses).length
    return html`<details data-key="style:${style}">
      <summary><b>${styleName(style)}</b> <span class="muted">${fresh} novas de ${list.length}</span></summary>
      <div class="scroll"><table class="compact">
        <thead><tr><th>Música</th><th>Duração</th><th>Usos</th><th>Enviada</th><th></th></tr></thead>
        <tbody>${list.map(s => html`<tr>
          <td>${s.title}</td><td>${clock(s.duration)}</td>
          <td>${s.uses ? s.uses : html`<span class="badge done">nova</span>`}</td>
          <td class="muted">${when(s.created_at)}</td>
          <td>${postButton(`/songs/${s.id}/delete`, 'Excluir', { confirm: `Excluir "${s.title}"?`, cls: 'danger small' })}</td>
        </tr>`)}</tbody>
      </table></div>
    </details>`
  })
  return html`<section class="card" id="musicas">
    <h2>Músicas</h2>
    ${songs.length ? groups : html`<p class="muted">Nenhuma música ainda.</p>`}
  </section>`
}

function settingsSection(ch: Channel): Html {
  return html`<section class="card" id="config">
    <h2>Configurações</h2>
    <form method="post" action="/channels/${ch.id}/settings" class="stack">
      <label>Nome <input name="name" value="${ch.name}" required maxlength="100"></label>
      <label>Tema / descrição <input name="description" value="${ch.description}" maxlength="300"></label>
      <label>Músicas por vídeo <input type="number" name="songs_per_video" value="${ch.songs_per_video}" min="1" max="500"></label>
      <label class="check"><input type="checkbox" name="reuse_songs" ${ch.reuse_songs ? 'checked' : ''}>
        Reaproveitar músicas já usadas quando acabarem as novas (sempre as menos usadas primeiro)</label>
      <label class="check"><input type="checkbox" name="reuse_visuals" ${ch.reuse_visuals ? 'checked' : ''}>
        Reaproveitar visuais já usados quando acabarem os novos</label>
      <label class="check"><input type="checkbox" name="auto_enabled" ${ch.auto_enabled ? 'checked' : ''}>
        Gerar automaticamente</label>
      <label>Quantos vídeos prontos manter (não publicados) <input type="number" name="auto_buffer" value="${ch.auto_buffer}" min="1" max="50"></label>
      <button>Salvar</button>
    </form>
    <details class="danger-zone">
      <summary>Excluir canal</summary>
      <form method="post" action="/channels/${ch.id}/delete" class="stack">
        <p>Apaga o canal com todas as músicas, visuais e vídeos dele. Digite o nome do canal pra confirmar.</p>
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
  return html`
    <p><a href="/channels/${ch.id}#videos">← ${ch.name}</a></p>
    <h1>Vídeo #${video.number} ${statusBadge(video)}</h1>
    ${video.error ? html`<pre class="error-box">${video.error}</pre>` : ''}
    <div class="video-layout">
      <div>
        ${hasFile
          ? html`<video controls preload="metadata" src="/videos/${video.id}/file" poster="/visuals/${visual.id}/thumb"></video>`
          : html`<img class="poster" src="/visuals/${visual.id}/thumb" alt="">`}
        <p class="actions">${actions}</p>
      </div>
      <dl class="facts">
        <dt>Estilo</dt><dd>${styleName(video.style)}</dd>
        <dt>Duração</dt><dd>${clock(video.duration)}</dd>
        <dt>Visual</dt><dd><span class="muted">#${visual.id}</span> ${visual.title} <span class="muted">(${visual.kind === 'image' ? 'imagem' : 'vídeo'}${visual.deleted_at ? ', excluído' : ''})</span></dd>
        <dt>Criado</dt><dd>${when(video.created_at)}</dd>
        <dt>Renderizado</dt><dd>${when(video.finished_at)}</dd>
        <dt>Publicado</dt><dd>${when(video.published_at)}</dd>
        ${video.file_deleted ? html`<dt>Arquivo</dt><dd class="muted">apagado</dd>` : ''}
      </dl>
    </div>
    <section class="card">
      <h2>Músicas (${songs.length})</h2>
      <table class="compact">
        <thead><tr><th>#</th><th>Início</th><th>Música</th><th>Duração</th></tr></thead>
        <tbody>${songs.map((s, i) => html`<tr>
          <td>${i + 1}</td><td>${clock(s.start)}</td>
          <td>${s.title}${s.deleted_at ? html` <span class="muted">(excluída)</span>` : ''}</td><td>${clock(s.duration)}</td>
        </tr>`)}</tbody>
      </table>
      <p><button type="button" data-copy="tracklist">Copiar tracklist</button></p>
      <textarea id="tracklist" readonly rows="4">${tracklist}</textarea>
    </section>`
}
