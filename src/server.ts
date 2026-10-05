import express, { type NextFunction, type Request, type Response } from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'
import { APP_PASSWORD, DATA_DIR, PORT, PUBLIC_DIR } from './config.ts'
import { all, errorMessage, get, getChannel, run, UserError, type Song, type Video, type Visual } from './db.ts'
import {
  autoFill, createVideos, deleteVideoFile, discardVideo, retryVideo, setPublished, startWorker, stopWorker, wake,
} from './jobs.ts'
import { deleteChannel, deleteSong, deleteVisual, receiveUpload } from './library.ts'
import { channelPage, dashboardPage, html, page, stateSignature, videoPage, type ChannelSection, type Flash } from './views.ts'

class NotFound extends Error {
  status = 404
}

function found<T>(row: T | undefined): T {
  if (!row) throw new NotFound('Não encontrado.')
  return row
}

const channelOf = (req: Request) => found(getChannel(Number(req.params.id)))
const videoOf = (req: Request) => found(get<Video>('SELECT * FROM videos WHERE id = ?', Number(req.params.id)))
const visualOf = (req: Request) =>
  found(get<Visual>('SELECT * FROM visuals WHERE id = ? AND deleted_at IS NULL', Number(req.params.id)))

function int(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function flash(req: Request): Flash {
  const { msg, err } = req.query
  return { msg: typeof msg === 'string' ? msg : undefined, err: typeof err === 'string' ? err : undefined }
}

/** POST de formulário: redireciona pro destino com mensagem; UserError volta pra página anterior com o erro. */
function action(fn: (req: Request) => Promise<{ to: string; msg?: string }> | { to: string; msg?: string }) {
  return async (req: Request, res: Response) => {
    let to: string
    let flashKey = 'msg'
    let text: string | undefined
    try {
      ;({ to, msg: text } = await fn(req))
    } catch (err) {
      if (!(err instanceof UserError)) throw err
      to = req.get('referer') ?? '/'
      flashKey = 'err'
      text = err.message
    }
    const url = new URL(to, 'http://local')
    url.searchParams.delete('msg')
    url.searchParams.delete('err')
    if (text) url.searchParams.set(flashKey, text)
    res.redirect(303, url.pathname + url.search + url.hash)
  }
}

function requirePassword(req: Request, res: Response, next: NextFunction): void {
  if (!APP_PASSWORD) return next()
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ')
  if (scheme === 'Basic' && encoded) {
    const password = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':')
    const given = createHash('sha256').update(password).digest()
    if (timingSafeEqual(given, createHash('sha256').update(APP_PASSWORD).digest())) return next()
  }
  res.set('WWW-Authenticate', 'Basic realm="Fabrica de Mixes", charset="UTF-8"').status(401).send('Senha necessária.')
}

const app = express()
app.disable('x-powered-by')
app.use(requirePassword)
app.use('/static', express.static(PUBLIC_DIR))
app.use(express.urlencoded({ extended: false }))

// ── Canais ──────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send(page('Canais', dashboardPage(), flash(req)))
})

app.post('/channels', action(req => {
  const name = String(req.body.name ?? '').trim()
  if (!name) throw new UserError('Dê um nome pro canal.')
  const { id } = run('INSERT INTO channels (name, description) VALUES (?, ?)', name, String(req.body.description ?? '').trim())
  return { to: `/channels/${id}/upload`, msg: 'Canal criado. Agora envie músicas e visuais.' }
}))

app.get('/channels/:id', (req, res) => {
  const ch = channelOf(req)
  res.send(page(ch.name, channelPage(ch), flash(req)))
})
const SECTION_TITLES: Record<Exclude<ChannelSection, 'overview'>, string> = {
  videos: 'Vídeos',
  produce: 'Produzir',
  upload: 'Enviar arquivos',
  songs: 'Músicas',
  visuals: 'Visuais',
  settings: 'Ajustes',
}


app.get('/channels/:id/:section', (req, res) => {
  const ch = channelOf(req)
  const section = req.params.section as keyof typeof SECTION_TITLES
  if (!Object.hasOwn(SECTION_TITLES, section)) throw new NotFound('Página do canal não encontrada.')
  res.send(page(`${SECTION_TITLES[section]} · ${ch.name}`, channelPage(ch, section), flash(req)))
})

app.post('/channels/:id/settings', action(req => {
  const ch = channelOf(req)
  const b = req.body as Record<string, string | undefined>
  run(
    `UPDATE channels SET name = ?, description = ?, songs_per_video = ?, reuse_songs = ?, reuse_visuals = ?,
                         auto_enabled = ?, auto_buffer = ?
      WHERE id = ?`,
    b.name?.trim() || ch.name,
    (b.description ?? '').trim(),
    int(b.songs_per_video, 1, 500, ch.songs_per_video),
    b.reuse_songs ? 1 : 0,
    b.reuse_visuals ? 1 : 0,
    b.auto_enabled ? 1 : 0,
    int(b.auto_buffer, 1, 50, ch.auto_buffer),
    ch.id,
  )
  autoFill()
  return { to: `/channels/${ch.id}/settings`, msg: 'Configurações salvas.' }
}))

app.post('/channels/:id/delete', action(async req => {
  const ch = channelOf(req)
  if (String(req.body.confirm ?? '').trim() !== ch.name.trim()) throw new UserError('Digite o nome do canal certinho pra confirmar.')
  await deleteChannel(ch.id)
  return { to: '/', msg: `Canal "${ch.name}" excluído.` }
}))

app.post('/channels/:id/generate', action(req => {
  const ch = channelOf(req)
  const choice = String(req.body.style ?? 'auto')
  const style = choice.startsWith('s:') ? choice.slice(2) : null
  const { created, stop } = createVideos(ch, style, int(req.body.count, 1, 50, 1))
  return {
    to: `/channels/${ch.id}/videos`,
    msg: `${created} ${created === 1 ? 'vídeo' : 'vídeos'} na fila.${stop ? ` Parou antes: ${stop}` : ''}`,
  }
}))

app.post('/channels/:id/upload', async (req, res) => {
  const ch = channelOf(req)
  const results = await receiveUpload(req, ch.id)
  autoFill()
  res.json({ results })
})

// ── Músicas e visuais ───────────────────────────────────────────────

app.post('/songs/:id/delete', action(async req => {
  const song = found(get<Song>('SELECT * FROM songs WHERE id = ? AND deleted_at IS NULL', Number(req.params.id)))
  await deleteSong(song)
  return { to: `/channels/${song.channel_id}/songs`, msg: `"${song.title}" excluída.` }
}))

app.post('/visuals/:id/delete', action(async req => {
  const visual = visualOf(req)
  await deleteVisual(visual)
  return { to: `/channels/${visual.channel_id}/visuals`, msg: `"${visual.title}" excluído.` }
}))

app.post('/visuals/:id/retry', action(req => {
  const visual = visualOf(req)
  run("UPDATE visuals SET status = 'pending', error = NULL WHERE id = ? AND status = 'failed'", visual.id)
  wake()
  return { to: `/channels/${visual.channel_id}/visuals` }
}))

// Miniatura fica mesmo depois de excluir o visual (histórico dos vídeos).
app.get('/visuals/:id/thumb', (req, res) => {
  const visual = found(get<Visual>('SELECT * FROM visuals WHERE id = ?', Number(req.params.id)))
  res.sendFile(`${visual.dir}/thumb.jpg`, { root: DATA_DIR, maxAge: '1d' })
})

app.get('/visuals/:id/loop', (req, res) => {
  res.sendFile(`${visualOf(req).dir}/loop.mp4`, { root: DATA_DIR })
})

// ── Vídeos ──────────────────────────────────────────────────────────

app.get('/videos/:id', (req, res) => {
  const video = videoOf(req)
  const ch = found(getChannel(video.channel_id))
  res.send(page(`${ch.name} #${video.number}`, videoPage(video), flash(req)))
})

function videoFile(req: Request): { video: Video; file: string } {
  const video = videoOf(req)
  if (!video.file || video.file_deleted) throw new NotFound('Esse vídeo não tem arquivo.')
  return { video, file: video.file }
}

app.get('/videos/:id/file', (req, res) => {
  res.sendFile(videoFile(req).file, { root: DATA_DIR })
})

app.get('/videos/:id/download', (req, res) => {
  const { video, file } = videoFile(req)
  const ch = found(getChannel(video.channel_id))
  const slug = ch.name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase()
  res.download(file, `${slug || `canal-${ch.id}`}-${video.number}.mp4`, { root: DATA_DIR })
})

app.post('/videos/:id/publish', action(req => {
  const video = videoOf(req)
  setPublished(video, true)
  return { to: `/videos/${video.id}`, msg: 'Marcado como publicado.' }
}))

app.post('/videos/:id/unpublish', action(req => {
  const video = videoOf(req)
  setPublished(video, false)
  return { to: `/videos/${video.id}` }
}))

app.post('/videos/:id/discard', action(async req => {
  const video = videoOf(req)
  await discardVideo(video)
  return { to: `/channels/${video.channel_id}/videos`, msg: `Vídeo #${video.number} descartado; músicas e visual liberados.` }
}))

app.post('/videos/:id/delete-file', action(async req => {
  const video = videoOf(req)
  await deleteVideoFile(video)
  return { to: `/videos/${video.id}`, msg: 'Arquivo apagado.' }
}))

app.post('/videos/:id/retry', action(req => {
  const video = videoOf(req)
  retryVideo(video)
  return { to: `/videos/${video.id}` }
}))

app.get('/api/poll', (_req, res) => {
  const rendering = all<{ id: number; progress: number }>("SELECT id, progress FROM videos WHERE status = 'rendering'")
  res.json({
    sig: stateSignature(),
    progress: Object.fromEntries(rendering.map(v => [v.id, Math.round(v.progress * 100)])),
  })
})

app.use((err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => {
  const status = err.status ?? 500
  if (status >= 500) console.error(err)
  if (req.path.endsWith('/upload')) {
    res.status(status).json({ results: [{ name: '', status: 'error', message: errorMessage(err) }] })
    return
  }
  const title = status === 404 ? 'Não encontrado' : 'Erro'
  res.status(status).send(page(title, html`<h1>${title}</h1><p>${errorMessage(err)}</p><p><a href="/">Voltar</a></p>`))
})

startWorker()
const server = app.listen(PORT, () => {
  console.log(`Fábrica de Mixes em http://localhost:${PORT} (dados em ${DATA_DIR})`)
})
// Upload de vídeo grande pode passar dos 5 min padrão do Node.
server.requestTimeout = 0

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopWorker()
    process.exit(0)
  })
}
