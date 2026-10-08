import { randomInt } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { TMP_DIR, abs } from './config.ts'
import { all, errorMessage, get, run, tx, UserError, type Channel, type Song, type Video, type Visual } from './db.ts'
import { crossfadeSeconds, prepareLoop, probe, renderMix, thumbnail, type FfmpegJob } from './media.ts'

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

/** 100 caracteres quase invisíveis: 99 U+3164 com um U+058D numa posição aleatória. */
function youtubeTitle(): string {
  const filler = '\u3164'.repeat(99)
  const at = randomInt(100)
  return filler.slice(0, at) + '\u058d' + filler.slice(at)
}

/**
 * Reserves a reviewable draft: one style, N songs and a visual. Nothing renders until approved.
 * `style = null` rotates through the least recently used styles.
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
    const timing = mixTiming(songs.map(playedDuration))
    const { next } = get<{ next: number }>(
      'SELECT COALESCE(MAX(number), 0) + 1 AS next FROM videos WHERE channel_id = ?',
      ch.id,
    )!
    const { id } = run(
      `INSERT INTO videos (channel_id, number, style, youtube_title, visual_id, status, duration, crossfade_seconds)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      ch.id, next, chosen, youtubeTitle(), visual.id, timing.duration, timing.crossfade,
    )
    songs.forEach((song, position) => {
      run(
        'INSERT INTO video_songs (video_id, position, song_id, start) VALUES (?, ?, ?, ?)',
        id, position, song.id, timing.starts[position]!,
      )
    })
    return id
  })
}

/** Cria até `count` rascunhos; para no primeiro que faltar material. */
export function createVideos(ch: Channel, style: string | null, count: number): { created: number; stop: string | null } {
  let created = 0
  try {
    while (created < count) {
      createVideo(ch, style)
      created++
    }
  } catch (err) {
    if (!(err instanceof UserError) || created === 0) throw err
    return { created, stop: err.message }
  }
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
 * Modo automático reserva até `auto_buffer` rascunhos/vídeos não publicados.
 * Nunca renderiza rascunhos sem revisão. Pausa no canal com vídeo que falhou.
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
}

function requireDraft(video: Video): void {
  if (video.status !== 'queued' || video.approved_at) throw new UserError('Só rascunhos podem ser editados.')
}

function requireDate(value: string): void {
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new UserError('Informe uma data válida.')
  }
}

/** Seconds of a song heard in the render: its quiet tail is cut only in the ffmpeg filtergraph. */
function playedDuration(song: Pick<Song, 'duration' | 'tail_trim_seconds'>): number {
  return Math.min(song.duration, Math.max(1, song.duration - song.tail_trim_seconds))
}

/** Each track starts `crossfade` seconds before the previous one ends; the last plays to its end. */
function mixTiming(durations: readonly number[]): { crossfade: number; starts: number[]; duration: number } {
  const crossfade = crossfadeSeconds(durations)
  const starts: number[] = []
  let start = 0
  for (const duration of durations) {
    starts.push(start)
    start += duration - crossfade
  }
  return { crossfade, starts, duration: start + crossfade }
}

/** Recomputes overlap, starts and duration from the current track order (inside the caller's tx). */
function updateDraftTiming(videoId: number): void {
  const tracks = all<{ position: number; duration: number; tail_trim_seconds: number }>(
    `SELECT vs.position, s.duration, s.tail_trim_seconds FROM video_songs vs JOIN songs s ON s.id = vs.song_id
      WHERE vs.video_id = ? ORDER BY vs.position`, videoId,
  )
  const { crossfade, starts, duration } = mixTiming(tracks.map(playedDuration))
  tracks.forEach((track, i) => {
    run('UPDATE video_songs SET start = ? WHERE video_id = ? AND position = ?', starts[i]!, videoId, track.position)
  })
  run('UPDATE videos SET duration = ?, crossfade_seconds = ? WHERE id = ?', duration, crossfade, videoId)
}

/** A draft reserves material but cannot enter the ffmpeg queue before approval. */
export function approveDraft(video: Video): void {
  requireDraft(video)
  const { changes } = run(
    "UPDATE videos SET approved_at = datetime('now') WHERE id = ? AND status = 'queued' AND approved_at IS NULL",
    video.id,
  )
  if (!changes) throw new UserError('Rascunho já aprovado ou removido.')
  wake()
}

export function reorderDraftSong(video: Video, position: number, direction: -1 | 1): void {
  requireDraft(video)
  if (!Number.isInteger(position) || (direction !== -1 && direction !== 1)) throw new UserError('Posição inválida.')
  const next = position + direction
  tx(() => {
    const current = get('SELECT 1 FROM video_songs WHERE video_id = ? AND position = ?', video.id, position)
    const neighbor = get('SELECT 1 FROM video_songs WHERE video_id = ? AND position = ?', video.id, next)
    if (!current || !neighbor) throw new UserError('Esta faixa não pode ser movida nessa direção.')
    run('UPDATE video_songs SET position = -1 WHERE video_id = ? AND position = ?', video.id, position)
    run('UPDATE video_songs SET position = ? WHERE video_id = ? AND position = ?', position, video.id, next)
    run('UPDATE video_songs SET position = ? WHERE video_id = ? AND position = -1', next, video.id)
    updateDraftTiming(video.id)
  })
}

export function replaceDraftSong(video: Video, position: number, songId: number): void {
  requireDraft(video)
  if (!Number.isInteger(position) || !Number.isInteger(songId)) throw new UserError('Música inválida.')
  const current = get<{ song_id: number }>('SELECT song_id FROM video_songs WHERE video_id = ? AND position = ?', video.id, position)
  if (!current) throw new UserError('Faixa não encontrada no rascunho.')
  if (current.song_id === songId) return
  const replacement = get<Song>(
    'SELECT * FROM songs WHERE id = ? AND channel_id = ? AND style = ? AND deleted_at IS NULL',
    songId, video.channel_id, video.style,
  )
  if (!replacement) throw new UserError('A substituta precisa ser uma música ativa deste estilo e canal.')
  if (get('SELECT 1 FROM video_songs WHERE video_id = ? AND song_id = ?', video.id, songId)) {
    throw new UserError('Esta música já está neste mix.')
  }
  const channel = get<Channel>('SELECT * FROM channels WHERE id = ?', video.channel_id)!
  if (!channel.reuse_songs && get('SELECT 1 FROM video_songs WHERE song_id = ? AND video_id <> ?', songId, video.id)) {
    throw new UserError('Esta música já foi reservada para outro vídeo.')
  }
  tx(() => {
    run('UPDATE video_songs SET song_id = ? WHERE video_id = ? AND position = ?', songId, video.id, position)
    updateDraftTiming(video.id)
  })
}

export function setDraftVisual(video: Video, visualId: number): void {
  requireDraft(video)
  const visual = get<Visual>(
    "SELECT * FROM visuals WHERE id = ? AND channel_id = ? AND status = 'ready' AND deleted_at IS NULL",
    visualId, video.channel_id,
  )
  if (!visual) throw new UserError('Visual indisponível neste canal.')
  if (visual.id === video.visual_id) return
  const channel = get<Channel>('SELECT * FROM channels WHERE id = ?', video.channel_id)!
  if (!channel.reuse_visuals && get('SELECT 1 FROM videos WHERE visual_id = ? AND id <> ?', visualId, video.id)) {
    throw new UserError('Visual já reservado em outro vídeo.')
  }
  run('UPDATE videos SET visual_id = ? WHERE id = ?', visualId, video.id)
}

export function setThumbnailVisual(video: Video, visualId: number): void {
  if (!(video.status === 'queued' && !video.approved_at) && video.status !== 'done') {
    throw new UserError('A thumbnail só pode ser alterada no rascunho ou antes da publicação.')
  }
  const visual = get<Visual>(
    "SELECT * FROM visuals WHERE id = ? AND channel_id = ? AND status = 'ready' AND deleted_at IS NULL",
    visualId, video.channel_id,
  )
  if (!visual) throw new UserError('Thumbnail indisponível neste canal.')
  run('UPDATE videos SET thumbnail_visual_id = ? WHERE id = ?',
    visualId === video.visual_id ? null : visualId, video.id)
}

export function setDownloaded(video: Video, downloaded: boolean): void {
  if (video.status !== 'done') throw new UserError('Marque o download somente em vídeos prontos.')
  run("UPDATE videos SET downloaded_at = CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id = ?",
    downloaded ? 1 : 0, video.id)
}

export function setSchedule(video: Video, date: string | null): void {
  if (video.status !== 'done') throw new UserError('Só vídeos prontos podem ser agendados.')
  if (date !== null) requireDate(date)
  run('UPDATE videos SET planned_date = ? WHERE id = ?', date, video.id)
}

export function publishVideo(video: Video, url: string, date: string): void {
  if (video.status !== 'done' && video.status !== 'published') throw new UserError('Vídeo ainda não está pronto.')
  requireDate(date)
  let target: URL
  try { target = new URL(url) } catch { throw new UserError('Informe um link válido do YouTube.') }
  if (target.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(target.hostname)) {
    throw new UserError('O link precisa ser HTTPS do YouTube ou youtu.be.')
  }
  const id = target.hostname === 'youtu.be'
    ? target.pathname.slice(1).split('/')[0]
    : target.pathname === '/watch' ? target.searchParams.get('v') : target.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1]
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new UserError('O link do YouTube não contém um vídeo válido.')
  run(`UPDATE videos SET status = 'published', youtube_url = ?, published_date = ?,
       published_at = COALESCE(published_at, datetime('now')),
       downloaded_at = COALESCE(downloaded_at, datetime('now')) WHERE id = ?`,
    target.toString(), date, video.id)
  if (video.status === 'done') autoFill()
}

export function unpublishVideo(video: Video): void {
  if (video.status !== 'published' || video.file_deleted) {
    throw new UserError('Não é possível desmarcar este vídeo publicado.')
  }
  run("UPDATE videos SET status = 'done', published_at = NULL, published_date = NULL WHERE id = ?", video.id)
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
  // Fila criada antes do crossfade ganha a sobreposição; done/published mantêm arquivo e duração.
  tx(() => {
    for (const { id } of all<{ id: number }>(
      "SELECT id FROM videos WHERE status IN ('queued', 'failed') AND crossfade_seconds = 0",
    )) updateDraftTiming(id)
  })
  // Vídeos anteriores ao título invisível ganham um, uma vez só; nada mais muda neles.
  tx(() => {
    for (const { id } of all<{ id: number }>("SELECT id FROM videos WHERE youtube_title = ''")) {
      run('UPDATE videos SET youtube_title = ? WHERE id = ?', youtubeTitle(), id)
    }
  })
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
      const video = get<Video>(
        "SELECT * FROM videos WHERE status = 'queued' AND approved_at IS NOT NULL ORDER BY id LIMIT 1",
      )
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

    const tracks = songs.map(s => ({
      file: abs(s.file),
      duration: s.duration,
      tailTrimSeconds: s.duration - playedDuration(s),
    }))
    let lastWrite = 0
    await step(self, () =>
      renderMix(path.join(abs(visual.dir), 'loop.mp4'), tracks, video.duration, video.crossfade_seconds, out, seconds => {
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
