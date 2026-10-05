import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { AUDIO_BITRATE, VIDEO } from './config.ts'

const execFileAsync = promisify(execFile)

/** Loops curtos viram pelo menos isso, pra não reabrir o arquivo milhares de vezes no render. */
const MIN_LOOP_SECONDS = 10
const IMAGE_LOOP_SECONDS = 10

export interface Probe {
  duration: number
  hasAudio: boolean
  hasVideo: boolean
  title: string | null
}

export async function probe(file: string): Promise<Probe> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:format_tags=title:stream=codec_type',
    '-of', 'json',
    file,
  ])
  const data = JSON.parse(stdout) as {
    format?: { duration?: string; tags?: { title?: string } }
    streams?: { codec_type?: string }[]
  }
  const streams = data.streams ?? []
  return {
    duration: Number(data.format?.duration) || 0,
    hasAudio: streams.some(s => s.codec_type === 'audio'),
    hasVideo: streams.some(s => s.codec_type === 'video'),
    title: data.format?.tags?.title?.trim() || null,
  }
}

export interface FfmpegJob {
  done: Promise<void>
  kill(): void
}

/** Roda o ffmpeg; `onProgress` recebe os segundos já escritos na saída. Rejeita com o fim do stderr. */
export function ffmpeg(args: string[], onProgress?: (seconds: number) => void): FfmpegJob {
  const child = spawn(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', ...args],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000)
  })
  let pending = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('out_time_us=')) continue
      const us = Number(line.slice('out_time_us='.length))
      if (Number.isFinite(us) && us >= 0) onProgress?.(us / 1e6)
    }
  })
  const { promise: done, resolve, reject } = Promise.withResolvers<void>()
  child.on('error', reject)
  child.on('close', (code, signal) => {
    if (code === 0) resolve()
    else reject(new Error(signal ? `ffmpeg interrompido (${signal})` : stderr.trim() || `ffmpeg saiu com código ${code}`))
  })
  return { done, kill: () => child.kill('SIGKILL') }
}

/** Duração exata decodificando o áudio (o ffprobe só estima em MP3 VBR sem cabeçalho). */
export async function measureAudio(file: string): Promise<number> {
  let seconds = 0
  await ffmpeg(['-i', file, '-map', '0:a:0', '-f', 'null', '-'], s => { seconds = s }).done
  return seconds
}

const FIT =
  `scale=${VIDEO.width}:${VIDEO.height}:force_original_aspect_ratio=decrease,` +
  `pad=${VIDEO.width}:${VIDEO.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`

/**
 * Converte a imagem/vídeo enviado num loop H.264 1080p30 sem áudio (barras pretas se não for 16:9).
 * Feito uma vez por visual; depois cada render só copia esse loop, sem recodificar vídeo.
 * Sem B-frames pra emenda do loop copiado ficar limpa.
 */
export function prepareLoop(kind: 'image' | 'video', src: string, srcDuration: number, out: string): FfmpegJob {
  const { fps } = VIDEO
  if (kind === 'image') {
    return ffmpeg([
      '-loop', '1', '-framerate', String(fps), '-i', src, '-t', String(IMAGE_LOOP_SECONDS),
      '-vf', FIT, '-an',
      '-c:v', 'libx264', '-preset', 'slow', '-tune', 'stillimage', '-crf', '18',
      '-bf', '0', '-g', String(fps * IMAGE_LOOP_SECONDS),
      '-movflags', '+faststart', out,
    ])
  }
  const repeats = srcDuration > 0 && srcDuration < MIN_LOOP_SECONDS ? Math.ceil(MIN_LOOP_SECONDS / srcDuration) - 1 : 0
  return ffmpeg([
    '-stream_loop', String(repeats), '-i', src,
    '-vf', `fps=${fps},${FIT}`, '-an',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-maxrate', '4M', '-bufsize', '8M',
    '-bf', '0', '-g', String(fps * 2),
    '-movflags', '+faststart', out,
  ])
}

export function thumbnail(loop: string, out: string): FfmpegJob {
  return ffmpeg(['-i', loop, '-vf', 'thumbnail,scale=480:-2', '-frames:v', '1', '-q:v', '4', out])
}

/**
 * Loop de vídeo copiado (sem recodificar) + músicas emendadas em AAC.
 * Corta em `duration` com -t porque -shortest com cópia de vídeo passa do fim do áudio.
 */
export function renderMix(loop: string, songs: string[], duration: number, out: string, onProgress: (seconds: number) => void): FfmpegJob {
  const chains = songs.map((_, i) => `[${i + 1}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`)
  const inputs = songs.map((_, i) => `[a${i}]`).join('')
  return ffmpeg(
    [
      '-stream_loop', '-1', '-i', loop,
      ...songs.flatMap(file => ['-i', file]),
      '-filter_complex', `${chains.join(';')};${inputs}concat=n=${songs.length}:v=0:a=1[aout]`,
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac', '-aac_coder', 'fast', '-b:a', AUDIO_BITRATE,
      '-t', duration.toFixed(3),
      '-movflags', '+faststart', out,
    ],
    onProgress,
  )
}
