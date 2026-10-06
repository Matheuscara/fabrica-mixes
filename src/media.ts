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

/** Só os últimos segundos do arquivo são examinados; nada antes deles é cortado. */
const TAIL_WINDOW_SECONDS = 12
/** Abaixo de -45 dB por pelo menos 0,25 s conta como silêncio. */
const TAIL_SILENCE_FILTER = 'silencedetect=noise=-45dB:duration=0.25'
/** Silêncio mantido no fim, pra música não terminar seca. */
const TAIL_KEEP_SECONDS = 0.7
const MAX_TAIL_TRIM_SECONDS = 10
/** Folga numérica dos tempos do log do ffmpeg ao comparar com as bordas da janela. */
const EDGE_TOLERANCE_SECONDS = 0.01

/**
 * Examina até 12 s do fim (a faixa inteira, se for mais curta) sem alterar o arquivo.
 * Só aceita silêncio que chega ao fim e começa depois do início da janela: áudio todo
 * silencioso nunca é encurtado. Mantém 0,7 s de respiro, nunca remove mais de 10 s nem
 * deixa menos de 1 s de música, e arredonda para baixo em milissegundos.
 * Em MP3 VBR sem cabeçalho, -sseof usa o fim real mesmo se a duração estimada variar.
 */
export async function tailTrimSeconds(file: string, duration: number): Promise<number> {
  if (!(duration > 1)) return 0
  const { stdout, stderr } = await execFileAsync('ffmpeg', [
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-progress', 'pipe:1',
    ...(duration > TAIL_WINDOW_SECONDS ? ['-sseof', String(-TAIL_WINDOW_SECONDS)] : []),
    '-i', file, '-map', '0:a:0', '-af', TAIL_SILENCE_FILTER, '-f', 'null', '-',
  ])
  let end = 0
  for (const [, us] of stdout.matchAll(/^out_time_us=(\d+)$/gm)) end = Math.max(end, Number(us) / 1e6)
  // Último trecho de silêncio; ffmpeg novo fecha com silence_end no fim do áudio, o antigo deixa aberto.
  let silenceStart = NaN
  let silenceEnd: number | null = null
  for (const [, kind, value] of stderr.matchAll(/^\[\w*silencedetect\w* @ [^\]]+\] silence_(start|end): (\S+)/gm)) {
    if (kind === 'start') {
      silenceStart = Number(value)
      silenceEnd = null
    } else {
      silenceEnd = Number(value)
    }
  }
  if (silenceEnd !== null) {
    if (!(silenceEnd >= end - EDGE_TOLERANCE_SECONDS)) return 0
    end = Math.max(end, silenceEnd)
  }
  if (!(silenceStart > Math.max(0, end - TAIL_WINDOW_SECONDS) + EDGE_TOLERANCE_SECONDS)) return 0
  const trim = Math.min(MAX_TAIL_TRIM_SECONDS, duration - 1, end - silenceStart - TAIL_KEEP_SECONDS)
  return trim > 0 ? Math.floor(trim * 1000) / 1000 : 0
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

/** Teto do crossfade entre músicas vizinhas. */
const MAX_CROSSFADE_SECONDS = 2

/**
 * Sobreposição única do vídeo: 0 com uma música; senão min(2s, metade da música mais curta),
 * pra cada faixa caber o fade de entrada e o de saída sem se cruzarem.
 * Arredondado pra baixo em milissegundos: o mesmo número vai pro filtro e pro cálculo da timeline.
 */
export function crossfadeSeconds(durations: readonly number[]): number {
  if (durations.length < 2) return 0
  let shortest = Infinity
  for (const d of durations) if (d < shortest) shortest = d
  const seconds = Math.min(MAX_CROSSFADE_SECONDS, shortest / 2)
  return seconds > 0 ? Math.floor(seconds * 1000) / 1000 : 0
}

/**
 * Loop de vídeo copiado (sem recodificar) + músicas emendadas em AAC.
 * Música com `tailTrimSeconds` > 0 para em `duration - tailTrimSeconds` (o arquivo segue inteiro).
 * Cada música é normalizada pra estéreo 48k float; com `crossfade` > 0 as vizinhas se sobrepõem
 * com acrossfade linear (tri, sem somar picos), senão são concatenadas direto.
 * Corta em `duration` com -t porque -shortest com cópia de vídeo passa do fim do áudio.
 */
export function renderMix(
  loop: string,
  songs: readonly { file: string; duration: number; tailTrimSeconds: number }[],
  duration: number,
  crossfade: number,
  out: string,
  onProgress: (seconds: number) => void,
): FfmpegJob {
  const n = songs.length
  const last = n === 1 ? 'aout' : `a${n - 1}`
  const graph = songs.map((song, i) => {
    const trim = song.tailTrimSeconds > 0
      ? `atrim=end=${(song.duration - song.tailTrimSeconds).toFixed(6)},asetpts=PTS-STARTPTS,`
      : ''
    const label = i === n - 1 ? last : `a${i}`
    return `[${i + 1}:a]${trim}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[${label}]`
  })
  if (n > 1 && crossfade > 0) {
    // [a0][a1]→[x1], [x1][a2]→[x2], …, última saída vira [aout].
    for (let i = 1; i < n; i++) {
      const left = i === 1 ? '[a0]' : `[x${i - 1}]`
      const output = i === n - 1 ? '[aout]' : `[x${i}]`
      graph.push(`${left}[a${i}]acrossfade=d=${crossfade}:c1=tri:c2=tri${output}`)
    }
  } else if (n > 1) {
    graph.push(`${songs.map((_, i) => `[a${i}]`).join('')}concat=n=${n}:v=0:a=1[aout]`)
  }
  return ffmpeg(
    [
      '-stream_loop', '-1', '-i', loop,
      ...songs.flatMap(({ file }) => ['-i', file]),
      '-filter_complex', graph.join(';'),
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac', '-aac_coder', 'fast', '-b:a', AUDIO_BITRATE,
      '-t', duration.toFixed(3),
      '-movflags', '+faststart', out,
    ],
    onProgress,
  )
}
