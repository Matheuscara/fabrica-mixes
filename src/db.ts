import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { DATA_DIR } from './config.ts'

export type VisualStatus = 'pending' | 'processing' | 'ready' | 'failed'
/** done = pronto pra baixar; published = já foi pro YouTube. */
export type VideoStatus = 'queued' | 'rendering' | 'done' | 'published' | 'failed'

export interface Channel {
  id: number
  name: string
  description: string
  songs_per_video: number
  reuse_songs: number
  reuse_visuals: number
  auto_enabled: number
  auto_buffer: number
  created_at: string
}

export interface Song {
  id: number
  channel_id: number
  style: string
  title: string
  file: string
  sha256: string
  duration: number
  size: number
  created_at: string
  deleted_at: string | null
}

/** Prompt atual de geração; histórico das faixas já produzidas continua em songs/videos. */
export interface Style {
  id: number
  channel_id: number
  name: string
  prompt: string
  created_at: string
  updated_at: string
}

export interface Visual {
  id: number
  channel_id: number
  kind: 'image' | 'video'
  title: string
  dir: string
  source: string
  sha256: string
  size: number
  status: VisualStatus
  error: string | null
  created_at: string
  deleted_at: string | null
}

export interface Video {
  id: number
  channel_id: number
  number: number
  style: string
  visual_id: number
  status: VideoStatus
  /** Null with status=queued means a reserved draft awaiting review. */
  approved_at: string | null
  downloaded_at: string | null
  planned_date: string | null
  youtube_url: string | null
  published_date: string | null
  thumbnail_visual_id: number | null
  progress: number
  error: string | null
  duration: number
  size: number | null
  file: string | null
  file_deleted: number
  created_at: string
  started_at: string | null
  finished_at: string | null
  published_at: string | null
}

mkdirSync(DATA_DIR, { recursive: true })
export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'))

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- AUTOINCREMENT: id de algo apagado nunca volta (cache de miniatura, render cancelado, links antigos).
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  songs_per_video INTEGER NOT NULL DEFAULT 20,
  reuse_songs INTEGER NOT NULL DEFAULT 0,
  reuse_visuals INTEGER NOT NULL DEFAULT 0,
  auto_enabled INTEGER NOT NULL DEFAULT 0,
  auto_buffer INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Linhas com deleted_at ficam só como histórico dos vídeos (o arquivo já foi apagado).
CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  style TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  file TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  duration REAL NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE (channel_id, sha256)
);

CREATE TABLE IF NOT EXISTS styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel_id, name)
);
CREATE INDEX IF NOT EXISTS songs_channel_style ON songs (channel_id, style);

CREATE TABLE IF NOT EXISTS visuals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  title TEXT NOT NULL,
  dir TEXT NOT NULL,
  source TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE (channel_id, sha256)
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  number INTEGER NOT NULL,
  style TEXT NOT NULL,
  visual_id INTEGER NOT NULL REFERENCES visuals(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'rendering', 'done', 'published', 'failed')),
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  duration REAL NOT NULL,
  size INTEGER,
  file TEXT,
  file_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  published_at TEXT,
  approved_at TEXT,
  downloaded_at TEXT,
  planned_date TEXT,
  youtube_url TEXT,
  published_date TEXT,
  thumbnail_visual_id INTEGER REFERENCES visuals(id),
  UNIQUE (channel_id, number)
);
CREATE INDEX IF NOT EXISTS videos_visual ON videos (visual_id);

-- Uma música/visual conta como "usada" enquanto existir um vídeo que a referencia.
CREATE TABLE IF NOT EXISTS video_songs (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  song_id INTEGER NOT NULL REFERENCES songs(id),
  start REAL NOT NULL,
  PRIMARY KEY (video_id, position)
);
CREATE INDEX IF NOT EXISTS video_songs_song ON video_songs (song_id);
`)

// Registra estilos dos arquivos já existentes sem alterar músicas nem vídeos históricos.
db.exec(`
INSERT INTO styles (channel_id, name)
  SELECT s.channel_id, s.style FROM (
    SELECT channel_id, style FROM songs WHERE style <> ''
    UNION SELECT channel_id, style FROM videos WHERE style <> ''
  ) s
  WHERE NOT EXISTS (
    SELECT 1 FROM styles st WHERE st.channel_id = s.channel_id AND st.name = s.style
  );
`)

// Migrate existing channels without rebuilding videos/video_songs or changing historical IDs.
const videoColumns = new Set(
  (db.prepare('PRAGMA table_info(videos)').all() as { name: string }[]).map(col => col.name),
)
db.exec('BEGIN IMMEDIATE')
try {
  if (!videoColumns.has('approved_at')) {
    db.exec(`ALTER TABLE videos ADD COLUMN approved_at TEXT;
      UPDATE videos SET approved_at = created_at WHERE status IN ('queued', 'rendering', 'failed');`)
  }
  if (!videoColumns.has('downloaded_at')) {
    db.exec(`ALTER TABLE videos ADD COLUMN downloaded_at TEXT;
      UPDATE videos SET downloaded_at = published_at WHERE status = 'published' AND published_at IS NOT NULL;`)
  }
  if (!videoColumns.has('planned_date')) db.exec('ALTER TABLE videos ADD COLUMN planned_date TEXT')
  if (!videoColumns.has('youtube_url')) db.exec('ALTER TABLE videos ADD COLUMN youtube_url TEXT')
  // Historical timestamps remain available; don't guess a local calendar date from UTC.
  if (!videoColumns.has('published_date')) db.exec('ALTER TABLE videos ADD COLUMN published_date TEXT')
  if (!videoColumns.has('thumbnail_visual_id')) {
    db.exec('ALTER TABLE videos ADD COLUMN thumbnail_visual_id INTEGER REFERENCES visuals(id)')
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  throw err
}

const statements = new Map<string, StatementSync>()
function prepare(sql: string): StatementSync {
  let stmt = statements.get(sql)
  if (!stmt) {
    stmt = db.prepare(sql)
    statements.set(sql, stmt)
  }
  return stmt
}

export function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return prepare(sql).all(...params) as T[]
}

export function get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return prepare(sql).get(...params) as T | undefined
}

export function run(sql: string, ...params: SQLInputValue[]): { changes: number; id: number } {
  const r = prepare(sql).run(...params)
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) }
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function getChannel(id: number): Channel | undefined {
  return get<Channel>('SELECT * FROM channels WHERE id = ?', id)
}

/** Erro com mensagem pra mostrar na tela. */
export class UserError extends Error {}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
