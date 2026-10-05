import path from 'node:path'

const env = process.env

export const PORT = Number(env.PORT ?? 8080)
export const DATA_DIR = path.resolve(env.DATA_DIR ?? 'data')
export const TMP_DIR = path.join(DATA_DIR, 'tmp')
export const APP_PASSWORD = env.APP_PASSWORD ?? ''
export const MAX_UPLOAD_BYTES = Number(env.MAX_UPLOAD_MB ?? 4096) * 1024 * 1024
export const PUBLIC_DIR = path.resolve(import.meta.dirname, '../public')

/** Formato de saída: YouTube 1080p30. */
export const VIDEO = { width: 1920, height: 1080, fps: 30 }
export const AUDIO_BITRATE = '320k'

/** Caminhos no banco são relativos ao DATA_DIR, pra pasta poder mudar de lugar. */
export const abs = (rel: string) => path.join(DATA_DIR, rel)
