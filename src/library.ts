import busboy from 'busboy'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MAX_UPLOAD_BYTES, TMP_DIR, abs } from './config.ts'
import { errorMessage, get, run, tx, UserError, type Song, type Visual } from './db.ts'
import { cancelChannelJobs, cancelJob, wake } from './jobs.ts'
import { measureAudio, probe } from './media.ts'

const AUDIO_EXT = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus']
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp']
const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi', '.gif']
/** Usado no `accept` do upload e pelo JS pra pular arquivos irrelevantes ao arrastar pastas. */
export const ACCEPTED_EXT = [...AUDIO_EXT, ...IMAGE_EXT, ...VIDEO_EXT].join(',')

export interface UploadResult {
  name: string
  status: 'added' | 'restored' | 'duplicate' | 'error'
  kind?: 'song' | 'visual'
  message?: string
}

/**
 * Recebe um multipart com campo `style` (antes dos arquivos) e um ou mais arquivos.
 * Músicas e visuais são separados pela extensão; duplicatas (mesmo conteúdo no canal) são ignoradas.
 */
export function receiveUpload(req: IncomingMessage, channelId: number): Promise<UploadResult[]> {
  const { promise, resolve, reject } = Promise.withResolvers<UploadResult[]>()
  const parser = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES } })
  const results: Promise<UploadResult>[] = []
  let style = ''
  parser.on('field', (name, value) => {
    if (name === 'style') style = value.trim().slice(0, 80)
  })
  parser.on('file', (_field, stream, info) => {
    results.push(ingestFile(channelId, path.basename(info.filename || 'arquivo'), stream, style))
  })
  parser.on('error', reject)
  parser.on('close', () => {
    Promise.all(results).then(resolve, reject)
  })
  req.pipe(parser)
  return promise
}

async function ingestFile(
  channelId: number,
  name: string,
  stream: Readable & { truncated?: boolean },
  style: string,
): Promise<UploadResult> {
  const ext = path.extname(name).toLowerCase()
  const kind = AUDIO_EXT.includes(ext) ? 'song' : IMAGE_EXT.includes(ext) || VIDEO_EXT.includes(ext) ? 'visual' : null
  if (!kind) {
    stream.resume()
    return { name, status: 'error', message: 'formato não suportado' }
  }
  const tmp = path.join(TMP_DIR, randomUUID() + ext)
  try {
    const hash = createHash('sha256')
    let size = 0
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        size += chunk.length
        callback(null, chunk)
      },
    })
    await pipeline(stream, hasher, createWriteStream(tmp))
    if (stream.truncated) throw new UserError(`maior que o limite de ${Math.round(MAX_UPLOAD_BYTES / 2 ** 20)} MB`)
    const file = { name, ext, tmp, sha256: hash.digest('hex'), size }
    return kind === 'song' ? await addSong(channelId, file, style) : await addVisual(channelId, file)
  } catch (err) {
    return { name, kind, status: 'error', message: errorMessage(err) }
  } finally {
    await rm(tmp, { force: true })
  }
}

interface Received {
  name: string
  ext: string
  tmp: string
  sha256: string
  size: number
}

async function addSong(channelId: number, file: Received, style: string): Promise<UploadResult> {
  const { name } = file
  const existing = get<Song>('SELECT * FROM songs WHERE channel_id = ? AND sha256 = ?', channelId, file.sha256)
  if (existing && !existing.deleted_at) {
    return { name, kind: 'song', status: 'duplicate', message: `já existe como "${existing.title}"` }
  }
  const info = await probe(file.tmp)
  if (!info.hasAudio) throw new UserError('arquivo sem áudio')
  const duration = await measureAudio(file.tmp)
  if (duration < 1) throw new UserError('áudio vazio')
  const title = info.title ?? path.basename(name, path.extname(name))
  const rel = `channels/${channelId}/songs/${file.sha256.slice(0, 16)}${file.ext}`
  await mkdir(path.dirname(abs(rel)), { recursive: true })
  await rename(file.tmp, abs(rel))

  if (existing) {
    // Tinha sido excluída e ficou só como histórico: volta a valer.
    run(
      'UPDATE songs SET style = ?, title = ?, file = ?, duration = ?, size = ?, deleted_at = NULL WHERE id = ?',
      style, title, rel, duration, file.size, existing.id,
    )
    return { name, kind: 'song', status: 'restored' }
  }
  try {
    run(
      'INSERT INTO songs (channel_id, style, title, file, sha256, duration, size) VALUES (?, ?, ?, ?, ?, ?, ?)',
      channelId, style, title, rel, file.sha256, duration, file.size,
    )
  } catch (err) {
    if (!errorMessage(err).includes('UNIQUE constraint failed')) throw err
    // Mesmo arquivo enviado em paralelo: o outro ganhou.
    const winner = get<Song>('SELECT * FROM songs WHERE channel_id = ? AND sha256 = ?', channelId, file.sha256)
    if (winner?.file !== rel) await rm(abs(rel), { force: true })
    return { name, kind: 'song', status: 'duplicate', message: 'enviada em paralelo' }
  }
  return { name, kind: 'song', status: 'added' }
}

async function addVisual(channelId: number, file: Received): Promise<UploadResult> {
  const { name } = file
  const existing = get<Visual>('SELECT * FROM visuals WHERE channel_id = ? AND sha256 = ?', channelId, file.sha256)
  if (existing && !existing.deleted_at) {
    return { name, kind: 'visual', status: 'duplicate', message: `já existe como "${existing.title}"` }
  }
  const info = await probe(file.tmp)
  if (!info.hasVideo) throw new UserError('não é uma imagem/vídeo válido')
  const kind = IMAGE_EXT.includes(file.ext) ? 'image' : 'video'
  const source = `source${file.ext}`
  const dir = existing?.dir ?? `channels/${channelId}/visuals/${file.sha256.slice(0, 16)}`
  await mkdir(abs(dir), { recursive: true })
  await rename(file.tmp, path.join(abs(dir), source))

  if (existing) {
    run(
      "UPDATE visuals SET kind = ?, title = ?, source = ?, status = 'pending', error = NULL, deleted_at = NULL WHERE id = ?",
      kind, name, source, existing.id,
    )
    wake()
    return { name, kind: 'visual', status: 'restored' }
  }
  try {
    run(
      'INSERT INTO visuals (channel_id, kind, title, dir, source, sha256, size) VALUES (?, ?, ?, ?, ?, ?, ?)',
      channelId, kind, name, dir, source, file.sha256, file.size,
    )
  } catch (err) {
    if (!errorMessage(err).includes('UNIQUE constraint failed')) throw err
    const winner = get<Visual>('SELECT * FROM visuals WHERE channel_id = ? AND sha256 = ?', channelId, file.sha256)
    if (winner?.source !== source) await rm(path.join(abs(dir), source), { force: true })
    return { name, kind: 'visual', status: 'duplicate', message: 'enviado em paralelo' }
  }
  wake()
  return { name, kind: 'visual', status: 'added' }
}

/** Sem uso: some de vez. Usada em vídeo pronto: arquivo sai, registro fica como histórico. */
export async function deleteSong(song: Song): Promise<void> {
  const pendingVideo = get(
    `SELECT 1 FROM video_songs vs JOIN videos v ON v.id = vs.video_id
      WHERE vs.song_id = ? AND v.status IN ('queued', 'rendering', 'failed')`,
    song.id,
  )
  if (pendingVideo) throw new UserError(`"${song.title}" está num vídeo que ainda não foi renderizado. Descarte esse vídeo antes.`)
  if (get('SELECT 1 FROM video_songs WHERE song_id = ?', song.id)) {
    run("UPDATE songs SET deleted_at = datetime('now') WHERE id = ?", song.id)
  } else {
    run('DELETE FROM songs WHERE id = ?', song.id)
  }
  await rm(abs(song.file), { force: true })
}

/** Igual a deleteSong; no histórico fica só a miniatura. */
export async function deleteVisual(visual: Visual): Promise<void> {
  if (get("SELECT 1 FROM videos WHERE visual_id = ? AND status IN ('queued', 'rendering', 'failed')", visual.id)) {
    throw new UserError(`"${visual.title}" está num vídeo que ainda não foi renderizado. Descarte esse vídeo antes.`)
  }
  cancelJob('visual', visual.id)
  const dir = abs(visual.dir)
  if (get('SELECT 1 FROM videos WHERE visual_id = ?', visual.id)) {
    run("UPDATE visuals SET deleted_at = datetime('now') WHERE id = ?", visual.id)
    await Promise.all([
      rm(path.join(dir, visual.source), { force: true }),
      rm(path.join(dir, 'loop.mp4'), { force: true }),
    ])
  } else {
    run('DELETE FROM visuals WHERE id = ?', visual.id)
    await rm(dir, { recursive: true, force: true })
  }
}

export async function deleteChannel(channelId: number): Promise<void> {
  cancelChannelJobs(channelId)
  tx(() => {
    run('DELETE FROM videos WHERE channel_id = ?', channelId)
    run('DELETE FROM songs WHERE channel_id = ?', channelId)
    run('DELETE FROM visuals WHERE channel_id = ?', channelId)
    run('DELETE FROM channels WHERE id = ?', channelId)
  })
  await rm(abs(`channels/${channelId}`), { recursive: true, force: true })
}
