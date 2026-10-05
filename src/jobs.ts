import { mkdirSync, rmSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { TMP_DIR, abs } from './config.ts'
import { all, errorMessage, get, run, tx, UserError, type Channel, type Song, type Video, type Visual } from './db.ts'
import { prepareLoop, probe, renderMix, thumbnail, type FfmpegJob } from './media.ts'

// ── Material disponível ─────────────────────────────────────────────

export interface StylePool {
  style: string
  total: number
  /** Músicas que ainda não estão em nenhum vídeo. */
  fresh: number
}

export function stylePools(channelId: number): StylePool[] {
  return all<StylePool>(
    `SELECT style, COUNT(*) AS total,
            SUM(NOT EXISTS (SELECT 1 FROM video_songs vs WHERE vs.song_id = s.id)) AS fresh
       FROM songs s
      WHERE channel_id = ? AND deleted_at IS NULL
      GROUP BY style ORDER BY style`,
    channelId,
  )
}

export interface VisualPool {
  ready: number
  fresh: number
  preparing: number
  failed: number
}

export function visualPool(channelId: number): VisualPool {
  return get<VisualPool>(
    `SELECT COALESCE(SUM(status = 'ready'), 0) AS ready,
            COALESCE(SUM(status = 'ready' AND NOT EXISTS (SELECT 1 FROM videos x WHERE x.visual_id = v.id)), 0) AS fresh,
            COALESCE(SUM(status IN ('pending', 'processing')), 0) AS preparing,
            COALESCE(SUM(status = 'failed'), 0) AS failed
       FROM visuals v
      WHERE channel_id = ? AND deleted_at IS NULL`,
    channelId,
  )!
}

export interface Capacity {
  styles: (StylePool & { videos: number })[]
  visuals: VisualPool
  /** Quantos vídeos ainda dá pra gerar respeitando as regras de repetição do canal (Infinity = sem limite). */
  videos: number
}

export function capacity(ch: Channel): Capacity {
  const n = ch.songs_per_video
  const visuals = visualPool(ch.id)
  const styles = stylePools(ch.id).map(p => ({
    ...p,
    videos: ch.reuse_songs ? (p.total >= n ? Infinity : 0) : Math.floor(p.fresh / n),
  }))
  const bySongs = styles.reduce((sum, p) => sum + p.videos, 0)
  const byVisuals = ch.reuse_visuals ? (visuals.ready > 0 ? Infinity : 0) : visuals.fresh
  return { styles, visuals, videos: Math.min(bySongs, byVisuals) }
}

// ── Montagem dos vídeos ─────────────────────────────────────────────

/**
 * Reserva músicas + visual e põe o vídeo na fila. Músicas vêm todas do mesmo estilo,
 * sorteadas entre as menos usadas (sem reaproveitar: só as nunca usadas). Visual idem.
 * `style = null` reveza: escolhe o estilo usado há mais tempo.
 */
export function createVideo(ch: Channel, style: string | null): number {
  return tx(() => {
    const n = ch.songs_per_video
    const novas = ch.reuse_songs ? '' : ' novas'
    const usable = stylePools(ch.id).filter(p => (ch.reuse_songs ? p.total : p.fresh) >= n)
    let chosen: string
    if (style !== null) {
      if (!usable.some(p => p.style === style)) {
        throw new UserError(`O estilo "${style || 'sem estilo'}" não tem ${n} músicas${novas}.`)
      }
      chosen = style
    } else {
      if (!usable.length) throw new UserError(`Nenhum estilo tem ${n} músicas${novas} disponíveis.`)
      const lastVideo = new Map(
        all<{ style: string; last: number }>(
          'SELECT style, MAX(id) AS last FROM videos WHERE channel_id = ? GROUP BY style',
          ch.id,
        ).map(r => [r.style, r.last]),
      )
      shuffle(usable)
      usable.sort((a, b) => (lastVideo.get(a.style) ?? 0) - (lastVideo.get(b.style) ?? 0))
      chosen = usable[0]!.style
    }

    const songs = all<Song>(
      `SELECT * FROM (
         SELECT s.*, (SELECT COUNT(*) FROM video_songs vs WHERE vs.song_id = s.id) AS uses
           FROM songs s
          WHERE channel_id = ? AND style = ? AND deleted_at IS NULL)
        WHERE ? OR uses = 0
        ORDER BY uses, random()
        LIMIT ?`,
      ch.id, chosen, ch.reuse_songs, n,
    )
    const visual = get<Visual>(
      `SELECT * FROM (
         SELECT v.*, (SELECT COUNT(*) FROM videos x WHERE x.visual_id = v.id) AS uses
           FROM visuals v
          WHERE channel_id = ? AND status = 'ready' AND deleted_at IS NULL)
        WHERE ? OR uses = 0
        ORDER BY uses, random()
        LIMIT 1`,
      ch.id, ch.reuse_visuals,
    )
    if (!visual) {
      throw new UserError(ch.reuse_visuals ? 'Nenhum visual pronto.' : 'Nenhum visual novo pronto (todos já foram usados).')
    }

    shuffle(songs)
    const duration = songs.reduce((sum, s) => sum + s.duration, 0)
    const { next } = get<{ next: number }>(
      'SELECT COALESCE(MAX(number), 0) + 1 AS next FROM videos WHERE channel_id = ?',
      ch.id,
    )!
    const { id } = run(
      `INSERT INTO videos (channel_id, number, style, visual_id, status, duration) VALUES (?, ?, ?, ?, 'queued', ?)`,
      ch.id, next, chosen, visual.id, duration,
    )
    let start = 0
    songs.forEach((song, position) => {
      run('INSERT INTO video_songs (video_id, position, song_id, start) VALUES (?, ?, ?, ?)', id, position, song.id, start)
      start += song.duration
    })
    return id
  })
}

/** Cria até `count` vídeos; para no primeiro que faltar material. */
export function createVideos(ch: Channel, style: string | null, count: number): { created: number; stop: string | null } {
  let created = 0
  try {
    while (created < count) {
      createVideo(ch, style)
      created++
    }
  } catch (err) {
    if (!(err instanceof UserError) || created === 0) throw err
    wake()
    return { created, stop: err.message }
  }
  wake()
  return { created, stop: null }
}

function shuffle<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[items[i], items[j]] = [items[j]!, items[i]!]
  }
}

export function hasFailedVideo(channelId: number): boolean {
  return !!get("SELECT 1 FROM videos WHERE channel_id = ? AND status = 'failed' LIMIT 1", channelId)
}

/**
 * Modo automático: mantém `auto_buffer` vídeos não publicados (fila + renderizando + prontos).
 * Pausa no canal que tiver vídeo com erro, pra não ficar falhando em loop.
 */
export function autoFill(): void {
  for (const ch of all<Channel>('SELECT * FROM channels WHERE auto_enabled = 1')) {
    if (hasFailedVideo(ch.id)) continue
    const { pending } = get<{ pending: number }>(
      `SELECT COUNT(*) AS pending FROM videos WHERE channel_id = ? AND status IN ('queued', 'rendering', 'done')`,
      ch.id,
    )!
    for (let i = pending; i < ch.auto_buffer; i++) {
      try {
        createVideo(ch, null)
      } catch (err) {
        if (err instanceof UserError) break
        throw err
      }
    }
  }
  wake()
}

// ── Ações nos vídeos ────────────────────────────────────────────────

/** Apaga o vídeo e libera as músicas/visual pra serem usadas de novo. */
export async function discardVideo(video: Video): Promise<void> {
  if (video.status === 'published') {
    throw new UserError('Vídeo publicado não pode ser descartado (as músicas dele continuam usadas). Use "Apagar arquivo".')
  }
  cancelJob('video', video.id)
  run('DELETE FROM videos WHERE id = ?', video.id)
  if (video.file) await rm(abs(video.file), { force: true })
  autoFill()
}

export function setPublished(video: Video, published: boolean): void {
  if (published) {
    run("UPDATE videos SET status = 'published', published_at = datetime('now') WHERE id = ? AND status = 'done'", video.id)
  } else {
    run("UPDATE videos SET status = 'done', published_at = NULL WHERE id = ? AND status = 'published' AND file_deleted = 0", video.id)
  }
  autoFill()
}

/** Libera espaço de um vídeo publicado; o registro (e o que ele usou) fica. */
export async function deleteVideoFile(video: Video): Promise<void> {
  if (video.status !== 'published' || !video.file) throw new UserError('Só dá pra apagar o arquivo de vídeo já publicado.')
  await rm(abs(video.file), { force: true })
  run('UPDATE videos SET file_deleted = 1 WHERE id = ?', video.id)
}

export function retryVideo(video: Video): void {
  run("UPDATE videos SET status = 'queued', progress = 0, error = NULL WHERE id = ? AND status = 'failed'", video.id)
  wake()
}

// ── Worker: uma tarefa de ffmpeg por vez ────────────────────────────

interface Running {
  kind: 'visual' | 'video'
  id: number
  channelId: number
  job: FfmpegJob | null
  cancelled: boolean
}

let running: Running | null = null
let wakeUp: (() => void) | null = null

export function wake(): void {
  wakeUp?.()
}

export function cancelJob(kind: Running['kind'], id: number): void {
  if (running?.kind === kind && running.id === id) {
    running.cancelled = true
    running.job?.kill()
  }
}

export function cancelChannelJobs(channelId: number): void {
  if (running?.channelId === channelId) {
    running.cancelled = true
    running.job?.kill()
  }
}

export function stopWorker(): void {
  running?.job?.kill()
}

export function startWorker(): void {
  // O que estava rodando quando o processo caiu volta pra fila.
  run("UPDATE visuals SET status = 'pending' WHERE status = 'processing'")
  run("UPDATE videos SET status = 'queued', progress = 0 WHERE status = 'rendering'")
  rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(TMP_DIR, { recursive: true })
  autoFill()
  setInterval(autoFill, 60_000)
  void loop()
}

async function loop(): Promise<void> {
  for (;;) {
    try {
      const visual = get<Visual>("SELECT * FROM visuals WHERE status = 'pending' AND deleted_at IS NULL ORDER BY id LIMIT 1")
      if (visual) {
        await prepareVisual(visual)
        continue
      }
      const video = get<Video>("SELECT * FROM videos WHERE status = 'queued' ORDER BY id LIMIT 1")
      if (video) {
        await renderVideo(video)
        continue
      }
      const { promise, resolve } = Promise.withResolvers<void>()
      const timer = setTimeout(resolve, 30_000)
      wakeUp = () => {
        clearTimeout(timer)
        resolve()
      }
      await promise
      wakeUp = null
    } catch (err) {
      console.error('worker:', err)
      await sleep(5000)
    }
  }
}

async function step(self: Running, start: () => FfmpegJob): Promise<void> {
  if (self.cancelled) throw new Error('cancelado')
  self.job = start()
  await self.job.done
}

async function prepareVisual(visual: Visual): Promise<void> {
  run("UPDATE visuals SET status = 'processing', error = NULL WHERE id = ?", visual.id)
  const dir = abs(visual.dir)
  const loopFile = path.join(dir, 'loop.mp4')
  const tmpLoop = path.join(dir, 'loop.tmp.mp4')
  const self: Running = { kind: 'visual', id: visual.id, channelId: visual.channel_id, job: null, cancelled: false }
  running = self
  try {
    const src = path.join(dir, visual.source)
    const { duration } = await probe(src)
    await step(self, () => prepareLoop(visual.kind, src, duration, tmpLoop))
    await rename(tmpLoop, loopFile)
    await step(self, () => thumbnail(loopFile, path.join(dir, 'thumb.jpg')))
    run("UPDATE visuals SET status = 'ready' WHERE id = ? AND status = 'processing'", visual.id)
  } catch (err) {
    await rm(tmpLoop, { force: true })
    if (!self.cancelled) run("UPDATE visuals SET status = 'failed', error = ? WHERE id = ?", errorMessage(err), visual.id)
  } finally {
    running = null
  }
  autoFill()
}

async function renderVideo(video: Video): Promise<void> {
  run("UPDATE videos SET status = 'rendering', progress = 0, error = NULL, started_at = datetime('now') WHERE id = ?", video.id)
  const out = path.join(TMP_DIR, `render-${video.id}.mp4`)
  const self: Running = { kind: 'video', id: video.id, channelId: video.channel_id, job: null, cancelled: false }
  running = self
  try {
    const visual = get<Visual>('SELECT * FROM visuals WHERE id = ?', video.visual_id)!
    const songs = all<Song>(
      'SELECT s.* FROM video_songs vs JOIN songs s ON s.id = vs.song_id WHERE vs.video_id = ? ORDER BY vs.position',
      video.id,
    )
    const gone = songs.find(s => s.deleted_at)
    if (gone) throw new Error(`A música "${gone.title}" foi excluída.`)
    if (visual.deleted_at) throw new Error(`O visual "${visual.title}" foi excluído.`)

    let lastWrite = 0
    await step(self, () =>
      renderMix(path.join(abs(visual.dir), 'loop.mp4'), songs.map(s => abs(s.file)), video.duration, out, seconds => {
        const now = Date.now()
        if (now - lastWrite < 1000) return
        lastWrite = now
        run('UPDATE videos SET progress = ? WHERE id = ?', Math.min(seconds / video.duration, 0.999), video.id)
      }),
    )
    const rel = `channels/${video.channel_id}/videos/${video.id}.mp4`
    await mkdir(path.dirname(abs(rel)), { recursive: true })
    await rename(out, abs(rel))
    const { size } = await stat(abs(rel))
    const { changes } = run(
      `UPDATE videos SET status = 'done', progress = 1, file = ?, size = ?, finished_at = datetime('now')
        WHERE id = ? AND status = 'rendering'`,
      rel, size, video.id,
    )
    // Descartado bem na hora que terminou.
    if (!changes) await rm(abs(rel), { force: true })
  } catch (err) {
    await rm(out, { force: true })
    if (!self.cancelled) run("UPDATE videos SET status = 'failed', error = ? WHERE id = ?", errorMessage(err), video.id)
  } finally {
    running = null
  }
}
