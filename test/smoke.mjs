// Smoke test ponta a ponta: sobe o servidor real (Node + ffmpeg) num DATA_DIR temporário e percorre
// canal → upload → rascunho → revisão → aprovação → render → download → baixado → agenda → publicação.
// Não toca nos dados reais, não usa rede externa e apaga tudo no fim. Uso: npm run smoke
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(import.meta.dirname, '..')
const TOTAL_TIMEOUT_MS = 8 * 60_000
const started = Date.now()

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fabrica-smoke-'))
const dataDir = path.join(tmp, 'data')
const mediaDir = path.join(tmp, 'media')

/** @type {import('node:child_process').ChildProcess | null} */
let server = null
let serverLog = ''
/** @type {DatabaseSync | null} Só leitura: o teste observa o estado, quem escreve é o servidor. */
let db = null
let base = ''
let current = 'preparação'

function step(name) {
  current = name
  console.log(`- ${name}`)
}

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} fora de ${expected} ± ${tolerance}`)
}

// ── ffmpeg ──────────────────────────────────────────────────────────

async function ffmpeg(args) {
  const { stderr } = await execFileAsync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], {
    timeout: 60_000,
    maxBuffer: 16 * 2 ** 20,
  })
  return stderr
}

async function probe(file) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height',
    '-of', 'json',
    file,
  ], { timeout: 30_000 })
  const data = JSON.parse(stdout)
  return { duration: Number(data.format?.duration), streams: data.streams ?? [] }
}

/** Volume médio (dB) de um trecho do áudio; silêncio digital fica perto de -91 dB. */
async function meanVolume(file, start, length) {
  const log = await ffmpeg([
    '-ss', start.toFixed(3), '-i', file, '-t', length.toFixed(3),
    '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-',
  ])
  const match = log.match(/mean_volume:\s*(-?inf|-?\d+(?:\.\d+)?) dB/)
  assert.ok(match, `volumedetect sem resultado:\n${log.slice(-1000)}`)
  return match[1].endsWith('inf') ? -Infinity : Number(match[1])
}

// ── Servidor ────────────────────────────────────────────────────────

async function freePort() {
  const probeServer = net.createServer()
  await new Promise((resolve, reject) => {
    probeServer.once('error', reject)
    probeServer.listen(0, '127.0.0.1', resolve)
  })
  const { port } = probeServer.address()
  await new Promise(resolve => probeServer.close(resolve))
  return port
}

const serverAlive = () => !!server && server.exitCode === null && server.signalCode === null

async function startServer() {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const capture = chunk => {
    serverLog = (serverLog + chunk).slice(-20_000)
  }
  server.stdout.setEncoding('utf8').on('data', capture)
  server.stderr.setEncoding('utf8').on('data', capture)
  await waitFor('o servidor responder', 30_000, async () => {
    let res
    try {
      res = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) })
    } catch {
      return false
    }
    const body = await res.text()
    assert.equal(res.status, 200, `GET / → ${res.status}\n${body.slice(0, 600)}`)
    return true
  })
}

async function stopServer() {
  if (!serverAlive()) return
  const exited = new Promise(resolve => server.once('exit', resolve))
  server.kill('SIGTERM')
  const stopped = await Promise.race([exited.then(() => true), sleep(10_000, false, { ref: false })])
  if (!stopped) {
    server.kill('SIGKILL')
    await exited
  }
}

async function waitFor(label, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!serverAlive()) throw new Error(`o servidor saiu (${server?.exitCode ?? server?.signalCode}) esperando ${label}`)
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`tempo esgotado (${timeoutMs / 1000}s) esperando ${label}`)
    await sleep(200)
  }
}

// ── HTTP: as mesmas requisições que o navegador faz ─────────────────

function http(method, pathname, init = {}) {
  return fetch(base + pathname, { method, redirect: 'manual', signal: AbortSignal.timeout(30_000), ...init })
}

async function get(pathname, expected = 200) {
  const res = await http('GET', pathname)
  const body = Buffer.from(await res.arrayBuffer())
  assert.equal(res.status, expected, `GET ${pathname} → ${res.status}\n${body.toString('utf8', 0, 600)}`)
  return { res, body }
}

/** POST de formulário: sempre redireciona (303); recusa aparece ao usuário como `?err=`. Nunca aceita 500. */
async function submit(pathname, fields) {
  const res = await http('POST', pathname, { body: new URLSearchParams(fields) })
  const text = await res.text()
  assert.equal(res.status, 303, `POST ${pathname} → ${res.status}\n${text.slice(0, 600)}`)
  return new URL(res.headers.get('location') ?? '/', base).searchParams.get('err')
}

async function act(pathname, fields = {}) {
  const error = await submit(pathname, fields)
  assert.equal(error, null, `POST ${pathname} recusado: ${error}`)
}

async function refuse(pathname, fields = {}) {
  const error = await submit(pathname, fields)
  assert.ok(error, `POST ${pathname} ${JSON.stringify(fields)} deveria ter sido recusado`)
}

/** Upload multipart igual ao da página: campo `style` antes dos arquivos. Devolve o resultado por nome. */
async function upload(channelId, style, files) {
  const form = new FormData()
  form.append('style', style)
  for (const file of files) form.append('file', new Blob([await readFile(file)]), path.basename(file))
  const res = await http('POST', `/channels/${channelId}/upload`, {
    body: form,
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(120_000),
  })
  const text = await res.text()
  assert.equal(res.status, 200, `upload → ${res.status}\n${text.slice(0, 600)}`)
  return Object.fromEntries(JSON.parse(text).results.map(result => [result.name, result]))
}

function assertUploaded(results, name, status) {
  assert.equal(results[name]?.status, status, `upload de ${name}: ${JSON.stringify(results[name])}`)
}

async function pagesRender(channelId, videoId) {
  for (const pathname of ['/', `/channels/${channelId}`, `/channels/${channelId}/videos`, `/videos/${videoId}`]) {
    await get(pathname)
  }
}

// ── Estado persistido ───────────────────────────────────────────────

const row = (sql, ...params) => {
  const found = db.prepare(sql).get(...params)
  return found && { ...found }
}
const rows = (sql, ...params) => db.prepare(sql).all(...params).map(found => ({ ...found }))
const videoRow = id => row('SELECT * FROM videos WHERE id = ?', id)
const tracks = videoId => rows(
  `SELECT vs.position, vs.start, s.id, s.duration FROM video_songs vs JOIN songs s ON s.id = vs.song_id
    WHERE vs.video_id = ? ORDER BY vs.position`,
  videoId,
)

/** Faixas em posições 0..n-1, cada uma começando onde a anterior termina; duração do vídeo = soma. */
function assertTiming(video, list) {
  let start = 0
  list.forEach((track, i) => {
    assert.equal(track.position, i, 'posições das faixas')
    near(track.start, start, 0.001, `início da faixa ${i}`)
    start += track.duration
  })
  near(video.duration, start, 0.001, 'duração do vídeo')
}

async function waitVisualReady(id) {
  await waitFor(`o visual #${id} ficar pronto`, 180_000, () => {
    const visual = row('SELECT status, error FROM visuals WHERE id = ?', id)
    if (visual?.status === 'failed') throw new Error(`visual #${id} falhou: ${visual.error}`)
    return visual?.status === 'ready'
  })
}

// ── Cenário ─────────────────────────────────────────────────────────

async function main() {
  step('gerando mídia de teste com ffmpeg')
  await mkdir(mediaDir, { recursive: true })
  const media = name => path.join(mediaDir, name)
  const generate = args => ffmpeg(['-loglevel', 'error', ...args])
  await generate(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-ac', '2', media('tone.wav')])
  await generate(['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '3', media('quiet.wav')])
  await generate(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1.5', '-ac', '2', media('chime.wav')])
  await generate(['-f', 'lavfi', '-i', 'color=c=0x2a6f97:s=320x180', '-frames:v', '1', '-update', '1', media('cover.png')])
  await generate(['-f', 'lavfi', '-i', 'testsrc2=s=320x180', '-frames:v', '1', '-update', '1', media('alt.png')])

  step('subindo o servidor num DATA_DIR temporário')
  await startServer()
  db = new DatabaseSync(path.join(dataDir, 'app.db'), { readOnly: true })

  step('criando canal com 2 músicas por vídeo')
  const name = 'Canal Smoke'
  await act('/channels', { name, description: 'teste ponta a ponta' })
  const channelId = row('SELECT id FROM channels WHERE name = ?', name)?.id
  assert.ok(channelId, 'canal não foi criado')
  await act(`/channels/${channelId}/settings`, { name, description: 'teste ponta a ponta', songs_per_video: '2', auto_buffer: '3' })
  const channel = row('SELECT * FROM channels WHERE id = ?', channelId)
  assert.equal(channel.songs_per_video, 2)
  assert.equal(channel.reuse_songs, 0)
  assert.equal(channel.auto_enabled, 0)

  step('enviando duas músicas e uma imagem')
  const first = await upload(channelId, 'lofi', [media('tone.wav'), media('quiet.wav'), media('cover.png')])
  for (const file of ['tone.wav', 'quiet.wav', 'cover.png']) assertUploaded(first, file, 'added')
  assertUploaded(await upload(channelId, 'lofi', [media('tone.wav')]), 'tone.wav', 'duplicate')
  assert.equal(row('SELECT COUNT(*) AS n FROM songs WHERE channel_id = ?', channelId).n, 2, 'duplicata não pode virar outra música')
  const song = title => row('SELECT * FROM songs WHERE channel_id = ? AND title = ? AND deleted_at IS NULL', channelId, title)
  const visual = title => row('SELECT * FROM visuals WHERE channel_id = ? AND title = ?', channelId, title)
  const tone = song('tone')
  const quiet = song('quiet')
  assert.ok(tone && quiet, 'músicas enviadas não foram registradas')
  assert.equal(tone.style, 'lofi')
  near(tone.duration, 2, 0.1, 'duração medida de tone.wav')
  near(quiet.duration, 3, 0.1, 'duração medida de quiet.wav')
  const cover = visual('cover.png')
  assert.ok(cover, 'imagem enviada não foi registrada')
  await waitVisualReady(cover.id)
  await get(`/visuals/${cover.id}/thumb`)

  step('criando rascunho')
  await act(`/channels/${channelId}/generate`, { style: 's:lofi', count: '1' })
  const drafts = rows('SELECT id FROM videos WHERE channel_id = ?', channelId)
  assert.equal(drafts.length, 1, 'deveria haver exatamente um rascunho')
  const videoId = drafts[0].id
  let video = videoRow(videoId)
  assert.equal(video.status, 'queued')
  assert.equal(video.approved_at, null)
  assert.equal(video.visual_id, cover.id)
  let list = tracks(videoId)
  assert.deepEqual(list.map(track => track.id).sort((a, b) => a - b), [tone.id, quiet.id].sort((a, b) => a - b))
  assertTiming(video, list)
  // Sem músicas novas sobrando (canal não reutiliza), outro rascunho é recusado.
  await refuse(`/channels/${channelId}/generate`, { style: 's:lofi', count: '1' })
  assert.equal(rows('SELECT id FROM videos WHERE channel_id = ?', channelId).length, 1)
  await refuse(`/videos/${videoId}/schedule`, { planned_date: '2026-11-20' })
  for (const section of ['produce', 'upload', 'songs', 'visuals', 'settings']) await get(`/channels/${channelId}/${section}`)
  await pagesRender(channelId, videoId)

  // O worker acorda pra preparar outro visual; ao terminar, o rascunho não aprovado continua fora da fila.
  step('worker processa outro visual sem renderizar o rascunho')
  const second = await upload(channelId, 'lofi', [media('chime.wav'), media('alt.png')])
  for (const file of ['chime.wav', 'alt.png']) assertUploaded(second, file, 'added')
  const chime = song('chime')
  const alt = visual('alt.png')
  assert.ok(chime && alt, 'segundo envio não foi registrado')
  await waitVisualReady(alt.id)
  await sleep(500)
  video = videoRow(videoId)
  assert.equal(video.status, 'queued', 'rascunho entrou em render sem aprovação')
  assert.equal(video.approved_at, null)
  assert.equal(video.started_at, null, 'rascunho entrou em render sem aprovação')
  assert.equal(video.file, null)
  await get(`/videos/${videoId}/download`, 404)

  step('revisando o rascunho: troca de faixa, reordenação e visual')
  const tonePosition = list.find(track => track.id === tone.id).position
  await refuse(`/videos/${videoId}/replace-song`, { position: String(tonePosition), song_id: String(quiet.id) })
  await act(`/videos/${videoId}/replace-song`, { position: String(tonePosition), song_id: String(chime.id) })
  list = tracks(videoId)
  assert.equal(list[tonePosition].id, chime.id, 'faixa trocada na posição errada')
  assert.ok(!list.some(track => track.id === tone.id), 'música substituída continua no mix')
  assertTiming(videoRow(videoId), list)

  const order = list.map(track => track.id)
  await refuse(`/videos/${videoId}/reorder`, { position: String(list.length - 1), direction: '1' })
  await act(`/videos/${videoId}/reorder`, { position: '0', direction: '1' })
  list = tracks(videoId)
  const reviewed = [order[1], order[0]]
  assert.deepEqual(list.map(track => track.id), reviewed, 'reordenação não trocou as faixas')
  assertTiming(videoRow(videoId), list)

  await act(`/videos/${videoId}/visual`, { visual_id: String(alt.id) })
  assert.equal(videoRow(videoId).visual_id, alt.id)
  await get(`/videos/${videoId}`)

  step('aprovando e renderizando')
  await act(`/videos/${videoId}/approve`)
  assert.ok(videoRow(videoId).approved_at, 'aprovação não registrada')
  await refuse(`/videos/${videoId}/approve`)
  await refuse(`/videos/${videoId}/reorder`, { position: '0', direction: '1' })
  assert.deepEqual(tracks(videoId).map(track => track.id), reviewed, 'faixas mudaram depois da aprovação')
  video = await waitFor('o render terminar', 180_000, () => {
    const latest = videoRow(videoId)
    if (latest.status === 'failed') throw new Error(`render falhou: ${latest.error}`)
    return latest.status === 'done' && latest
  })
  assert.equal(video.progress, 1)
  assert.ok(video.file && video.size > 0, 'vídeo pronto sem arquivo')

  step('baixando e conferindo o MP4')
  const download = await get(`/videos/${videoId}/download`)
  assert.match(download.res.headers.get('content-disposition') ?? '', /^attachment;.*\.mp4"?$/)
  assert.equal(download.body.length, video.size)
  const output = path.join(tmp, 'download.mp4')
  await writeFile(output, download.body)
  const info = await probe(output)
  const videoStream = info.streams.find(stream => stream.codec_type === 'video')
  assert.ok(videoStream, 'MP4 sem vídeo')
  assert.ok(info.streams.some(stream => stream.codec_type === 'audio'), 'MP4 sem áudio')
  assert.equal(videoStream.width, 1920)
  assert.equal(videoStream.height, 1080)
  near(info.duration, video.duration, 0.35, 'duração do MP4')
  // A ordem revisada chega ao áudio final: o meio de cada faixa tem o tom (chime) ou silêncio (quiet).
  for (const track of tracks(videoId)) {
    const level = await meanVolume(output, track.start + track.duration / 2 - 0.25, 0.5)
    if (track.id === chime.id) assert.ok(level > -40, `faixa ${track.position} (chime) deveria ter som: ${level} dB`)
    else assert.ok(level < -60, `faixa ${track.position} (quiet) deveria ser silêncio: ${level} dB`)
  }
  await get(`/videos/${videoId}/thumbnail`)
  await pagesRender(channelId, videoId)

  step('marcando como baixado')
  assert.equal(video.downloaded_at, null)
  await refuse(`/videos/${videoId}/downloaded`, { downloaded: 'sim' })
  await act(`/videos/${videoId}/downloaded`, { downloaded: '1' })
  assert.ok(videoRow(videoId).downloaded_at, 'baixado não registrado')
  await act(`/videos/${videoId}/downloaded`, { downloaded: '0' })
  assert.equal(videoRow(videoId).downloaded_at, null, 'baixado não foi desmarcado')
  await act(`/videos/${videoId}/downloaded`, { downloaded: '1' })
  assert.ok(videoRow(videoId).downloaded_at)

  step('agendando')
  await act(`/videos/${videoId}/schedule`, { planned_date: '2026-11-20' })
  assert.equal(videoRow(videoId).planned_date, '2026-11-20')
  await refuse(`/videos/${videoId}/schedule`, { planned_date: '2026-02-30' })
  assert.equal(videoRow(videoId).planned_date, '2026-11-20', 'data inválida alterou o agendamento')
  await pagesRender(channelId, videoId)

  step('registrando a publicação no YouTube')
  const youtube = 'https://www.youtube.com/watch?v=smokeTest01'
  await refuse(`/videos/${videoId}/publish`, { youtube_url: 'https://example.com/watch?v=smokeTest01', published_date: '2026-11-21' })
  assert.equal(videoRow(videoId).status, 'done', 'link inválido mudou o status')
  await act(`/videos/${videoId}/publish`, { youtube_url: youtube, published_date: '2026-11-21' })
  video = videoRow(videoId)
  assert.equal(video.status, 'published')
  assert.equal(video.youtube_url, youtube)
  assert.equal(video.published_date, '2026-11-21')
  assert.ok(video.downloaded_at)
  const published = (await get(`/videos/${videoId}`)).body.toString('utf8')
  assert.ok(published.includes(`href="${youtube}"`), 'página do vídeo publicado sem o link do YouTube')
  await refuse(`/videos/${videoId}/discard`)
  assert.equal(videoRow(videoId)?.status, 'published', 'vídeo publicado foi descartado')
  await get(`/videos/${videoId}/download`)
  await pagesRender(channelId, videoId)
}

// ── Execução com limpeza garantida ──────────────────────────────────

function diagnostics() {
  const lines = [`etapa: ${current}`]
  if (db) {
    try {
      lines.push(`videos: ${JSON.stringify(rows('SELECT id, status, approved_at, progress, error, file FROM videos'))}`)
      lines.push(`visuais: ${JSON.stringify(rows('SELECT id, title, status, error FROM visuals'))}`)
    } catch (err) {
      lines.push(`(banco ilegível: ${err.message})`)
    }
  }
  lines.push('--- log do servidor ---', serverLog.trim() || '(vazio)')
  return lines.join('\n')
}

function abortNow(code) {
  if (serverAlive()) server.kill('SIGTERM')
  try {
    db?.close()
  } catch {}
  rmSync(tmp, { recursive: true, force: true })
  process.exit(code)
}

const watchdog = setTimeout(() => {
  console.error(`smoke: tempo total esgotado (${TOTAL_TIMEOUT_MS / 60_000} min)\n${diagnostics()}`)
  abortNow(1)
}, TOTAL_TIMEOUT_MS)
watchdog.unref()
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abortNow(130))

try {
  await main()
  console.log(`smoke: ok em ${((Date.now() - started) / 1000).toFixed(1)}s`)
} catch (err) {
  process.exitCode = 1
  console.error(`smoke: FALHOU\n${err?.stack ?? err}\n${diagnostics()}`)
} finally {
  clearTimeout(watchdog)
  db?.close()
  db = null
  await stopServer()
  await rm(tmp, { recursive: true, force: true })
}
