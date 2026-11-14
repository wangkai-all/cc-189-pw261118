import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  version           INTEGER PRIMARY KEY,
  label             TEXT NOT NULL,
  window_days       INTEGER NOT NULL,
  fee_bps           INTEGER NOT NULL,
  include_contested INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS builds (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name        TEXT NOT NULL,
  generation        INTEGER NOT NULL,
  source_version    INTEGER NOT NULL,
  rule_version      INTEGER NOT NULL,
  status            TEXT NOT NULL,
  note              TEXT NOT NULL DEFAULT '',
  options           TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  completed_at      INTEGER,
  superseded_at     INTEGER,
  superseded_by     INTEGER,
  promoted_at       INTEGER,
  reclaim_blocked_at INTEGER,
  reclaimed_at      INTEGER,
  UNIQUE (table_name, generation)
);

CREATE TABLE IF NOT EXISTS partitions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id          INTEGER NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  no                INTEGER NOT NULL,
  status            TEXT NOT NULL,
  stage             TEXT NOT NULL DEFAULT '',
  rows_total        INTEGER NOT NULL,
  rows_done         INTEGER NOT NULL DEFAULT 0,
  cursor_index      INTEGER NOT NULL,
  phase_progress    REAL NOT NULL DEFAULT 0,
  error             TEXT,
  build_attempts    INTEGER NOT NULL DEFAULT 0,
  verify_attempts   INTEGER NOT NULL DEFAULT 0,
  started_at        INTEGER,
  finished_at       INTEGER,
  agg               TEXT,
  verify_agg        TEXT,
  verified          TEXT,
  UNIQUE (build_id, no)
);

CREATE TABLE IF NOT EXISTS generations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name        TEXT NOT NULL,
  generation        INTEGER NOT NULL,
  build_id          INTEGER NOT NULL REFERENCES builds(id),
  created_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  reclaimed_at      INTEGER,
  summary           TEXT,
  UNIQUE (table_name, generation)
);

CREATE TABLE IF NOT EXISTS read_pointer (
  table_name        TEXT PRIMARY KEY,
  generation        INTEGER NOT NULL,
  build_id          INTEGER NOT NULL REFERENCES builds(id),
  switched_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name        TEXT NOT NULL,
  generation        INTEGER NOT NULL,
  reader_id         TEXT NOT NULL,
  purpose           TEXT NOT NULL DEFAULT '',
  acquired_at       INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  released_at       INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  at                INTEGER NOT NULL,
  table_name        TEXT NOT NULL,
  build_id          INTEGER,
  generation        INTEGER,
  partition_no      INTEGER,
  level             TEXT NOT NULL,
  kind              TEXT NOT NULL,
  message           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_partitions_build ON partitions(build_id);
CREATE INDEX IF NOT EXISTS idx_leases_live ON leases(table_name, generation, released_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_events_id ON events(id);
`;

const DEFAULT_RULES = [
  {
    version: 1,
    label: '基线 · 60 天窗口 / 2.9% 费率 / 排除争议',
    window_days: 60,
    fee_bps: 290,
    include_contested: 0,
  },
  {
    version: 2,
    label: '迁移 · 75 天窗口 / 2.4% 费率 / 计入争议',
    window_days: 75,
    fee_bps: 240,
    include_contested: 1,
  },
  {
    version: 3,
    label: '收紧 · 45 天窗口 / 3.1% 费率 / 排除争议',
    window_days: 45,
    fee_bps: 310,
    include_contested: 0,
  },
];

const DEFAULT_SETTINGS = {
  table_name: 'daily_settlement',
  default_partition_ms: '1500',
  default_verify_ms: '500',
  default_concurrency: '4',
};

export function openDb(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM rules').get().n === 0) {
    const at = Date.now();
    const ins = db.prepare(
      `INSERT INTO rules (version, label, window_days, fee_bps, include_contested, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of DEFAULT_RULES) {
      ins.run(r.version, r.label, r.window_days, r.fee_bps, r.include_contested, at);
    }
  }
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (!get.get(key)) ins.run(key, value);
  }
}

export { DEFAULT_RULES, DEFAULT_SETTINGS };
