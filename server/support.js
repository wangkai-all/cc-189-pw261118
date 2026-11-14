import { emptyAggregate } from './synthetic.js';

export const PARTITION_COUNT = 12;

export function getRule(db, version) {
  const row = db.prepare('SELECT * FROM rules WHERE version = ?').get(version);
  if (!row) return null;
  return {
    version: row.version,
    label: row.label,
    windowDays: row.window_days,
    feeBps: row.fee_bps,
    includeContested: Boolean(row.include_contested),
  };
}

export function listRules(db) {
  return db
    .prepare('SELECT * FROM rules ORDER BY version')
    .all()
    .map((row) => ({
      version: row.version,
      label: row.label,
      windowDays: row.window_days,
      feeBps: row.fee_bps,
      includeContested: Boolean(row.include_contested),
    }));
}

export function readSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    tableName: map.table_name || 'daily_settlement',
    partitionMs: Number(map.default_partition_ms) || 1400,
    verifyMs: Number(map.default_verify_ms) || 500,
    concurrency: Number(map.default_concurrency) || 4,
  };
}

export function writeSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value));
}

export function jsonOr(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function logEvent(
  db,
  { tableName, buildId = null, generation = null, partitionNo = null, level = 'info', kind, message },
) {
  db.prepare(
    `INSERT INTO events (at, table_name, build_id, generation, partition_no, level, kind, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(Date.now(), tableName, buildId, generation, partitionNo, level, kind, message);
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)));
}

export function normalizeOptions(raw, defaults = {}) {
  const opts = raw && typeof raw === 'object' ? raw : {};
  const failures = Array.isArray(opts.failures)
    ? opts.failures
        .filter((f) => {
          const n = Number(f?.partition);
          return Number.isInteger(n) && n >= 1 && n <= PARTITION_COUNT;
        })
        .map((f) => ({
          partition: Number(f.partition),
          stage: f.stage === 'verify' ? 'verify' : 'build',
          mode: f.mode === 'always' ? 'always' : 'once',
          at: Math.round(clamp(f.at ?? 0.5, 0.05, 0.98) * 100) / 100,
        }))
    : [];

  const slow = Array.isArray(opts.slow)
    ? opts.slow
        .filter((s) => {
          const n = Number(s?.partition);
          return Number.isInteger(n) && n >= 1 && n <= PARTITION_COUNT;
        })
        .map((s) => ({
          partition: Number(s.partition),
          buildMs: s.buildMs === undefined || s.buildMs === null ? null : clampInt(s.buildMs, 200, 120000, null),
          verifyMs: s.verifyMs === undefined || s.verifyMs === null ? null : clampInt(s.verifyMs, 100, 120000, null),
        }))
    : [];

  const corrupt = Array.isArray(opts.corrupt)
    ? [...new Set(opts.corrupt.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= PARTITION_COUNT))]
    : [];

  return {
    partitionMs: clampInt(opts.partitionMs ?? defaults.partitionMs, 400, 120000, 1400),
    verifyMs: clampInt(opts.verifyMs ?? defaults.verifyMs, 200, 120000, 500),
    concurrency: clampInt(opts.concurrency ?? defaults.concurrency, 1, PARTITION_COUNT, 4),
    failures,
    slow,
    corrupt,
  };
}

export function stageDurations(options, partitionNo) {
  const slow = options.slow.find((s) => s.partition === partitionNo);
  return {
    buildMs: slow?.buildMs ?? options.partitionMs,
    verifyMs: slow?.verifyMs ?? options.verifyMs,
  };
}

// A failure plan fires on the configured stage. `once` fires only on the first
// attempt of that stage; retrying / rebuilding clears it. `always` keeps firing.
export function failurePlan(options, partitionNo, stage, attempt) {
  return (
    options.failures.find(
      (f) =>
        f.partition === partitionNo &&
        f.stage === stage &&
        (f.mode === 'always' || attempt === 1),
    ) || null
  );
}

export function sumAggs(partRows) {
  const total = emptyAggregate();
  total.checkValue = 0;
  for (const part of partRows) {
    const agg = part && part.agg ? jsonOr(part.agg, null) : null;
    if (!agg) continue;
    total.grossCents += agg.grossCents || 0;
    total.refundCents += agg.refundCents || 0;
    total.feeCents += agg.feeCents || 0;
    total.netCents += agg.netCents || 0;
    total.orderCount += agg.orderCount || 0;
    total.refundCount += agg.refundCount || 0;
    total.rowsScanned += agg.rowsScanned || 0;
  }
  return total;
}

export function formatMoney(cents) {
  const value = (cents || 0) / 100;
  return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function tableNameFor(db) {
  return readSettings(db).tableName;
}
