import {
  DATA,
  SOURCE_VERSIONS,
  emptyAggregate,
  partitionDef,
  partitionDefs,
  ruleToScan,
  scanOrders,
  sumCheckValues,
  verifyAggregate,
  VERIFY_FIELDS,
} from './synthetic.js';
import {
  PARTITION_COUNT,
  failurePlan,
  getRule,
  jsonOr,
  logEvent,
  normalizeOptions,
  readSettings,
  stageDurations,
  sumAggs,
  tableNameFor,
} from './support.js';

const ACTIVE = new Set(['building', 'verifying']);

export const SOURCE_VERSION_META = SOURCE_VERSIONS;

export function latestGeneration(db, tableName) {
  const row = db.prepare('SELECT MAX(generation) AS g FROM builds WHERE table_name = ?').get(tableName);
  return row?.g || 0;
}

export function pointerFor(db, tableName) {
  return db.prepare('SELECT * FROM read_pointer WHERE table_name = ?').get(tableName) || null;
}

export function buildsFor(db, tableName) {
  return db
    .prepare('SELECT * FROM builds WHERE table_name = ? ORDER BY generation ASC')
    .all(tableName);
}

export function liveLeases(db, tableName, generation, at = Date.now()) {
  return db
    .prepare(
      `SELECT * FROM leases
       WHERE table_name = ? AND generation = ? AND released_at IS NULL AND expires_at > ?
       ORDER BY acquired_at ASC`,
    )
    .all(tableName, generation, at);
}

export function liveLeaseCounts(db, tableName, at = Date.now()) {
  const rows = db
    .prepare(
      `SELECT generation, COUNT(*) AS n FROM leases
       WHERE table_name = ? AND released_at IS NULL AND expires_at > ?
       GROUP BY generation`,
    )
    .all(tableName, at);
  const map = new Map();
  for (const row of rows) map.set(row.generation, row.n);
  return map;
}

// Bootstraps generation 1 by actually computing the table, so the table is
// readable before any user-initiated rebuild. Idempotent.
export function ensureBaseline(db, clock = Date.now) {
  const tableName = tableNameFor(db);
  const existing = db.prepare('SELECT * FROM builds WHERE table_name = ?').get(tableName);
  if (existing) return existing;

  const now = clock();
  const scanRule = ruleToScan(getRule(db, 1));
  const buildRow = db
    .prepare(
      `INSERT INTO builds (table_name, generation, source_version, rule_version, status, note, options,
                           created_at, started_at, completed_at, promoted_at)
       VALUES (?, 1, 1, 1, 'complete', '初始基线', '{}', ?, ?, ?, ?)`,
    )
    .run(tableName, now, now, now, now);
  const buildId = Number(buildRow.lastInsertRowid);

  const insPart = db.prepare(
    `INSERT INTO partitions (build_id, no, status, stage, rows_total, rows_done, cursor_index,
                             phase_progress, build_attempts, verify_attempts, started_at, finished_at,
                             agg, verify_agg, verified)
     VALUES (?, ?, 'verified', 'done', ?, ?, ?, 1, 1, 1, ?, ?, ?, ?, ?)`,
  );

  const totals = emptyAggregate();
  totals.checkValue = 0;
  const checksums = [];
  for (const def of partitionDefs()) {
    const agg = emptyAggregate();
    scanOrders({
      startIndex: def.scanStartIndex,
      endIndex: def.scanEndIndex,
      def,
      dataRevision: 1,
      rule: scanRule,
      agg,
    });
    checksums.push(agg.checkValue);
    const verified = scorer(agg, 1, 1, now, 0);
    insPart.run(
      buildId,
      def.no,
      def.rowsTotal,
      def.rowsTotal,
      def.scanEndIndex,
      now,
      now,
      JSON.stringify(agg),
      JSON.stringify(agg),
      JSON.stringify(verified),
    );
    totals.grossCents += agg.grossCents;
    totals.refundCents += agg.refundCents;
    totals.feeCents += agg.feeCents;
    totals.netCents += agg.netCents;
    totals.orderCount += agg.orderCount;
    totals.refundCount += agg.refundCount;
    totals.rowsScanned += agg.rowsScanned;
  }
  totals.checkValue = sumCheckValues(checksums);

  db.prepare(
    `INSERT INTO generations (table_name, generation, build_id, created_at, completed_at, summary)
     VALUES (?, 1, ?, ?, ?, ?)`,
  ).run(tableName, buildId, now, now, JSON.stringify(totals));

  db.prepare(
    `INSERT INTO read_pointer (table_name, generation, build_id, switched_at) VALUES (?, 1, ?, ?)`,
  ).run(tableName, buildId, now);

  logEvent(db, {
    tableName,
    buildId,
    generation: 1,
    kind: 'baseline',
    level: 'success',
    message: `基线代次 1 已生成：源 v1 / 规则 v1，${(DATA.ordersTotal / 1000).toFixed(0)}K 订单全量计算并核对通过`,
  });
  return db.prepare('SELECT * FROM builds WHERE id = ?').get(buildId);
}

function scorer(agg, sourceVersion, ruleVersion, at, durationMs) {
  return {
    ok: true,
    fields: VERIFY_FIELDS.length,
    mismatches: [],
    verifiedAt: at,
    durationMs,
    rowsScanned: agg.rowsScanned,
    checkValue: agg.checkValue >>> 0,
    checksum: `fnv-${(agg.checkValue >>> 0).toString(16).padStart(8, '0')}`,
    sourceVersion,
    ruleVersion,
  };
}

export class Engine {
  constructor(db, { clock = Date.now, tickMs = 100, log = () => {} } = {}) {
    this.db = db;
    this.clock = clock;
    this.tickMs = tickMs;
    this.lastTickAt = clock();
    this.timer = null;
    this.log = log;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.log(`engine tick failed: ${error.stack || error.message}`);
      }
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(nowOverride) {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = nowOverride ?? this.clock();
      const dt = Math.max(0, Math.min(2000, now - this.lastTickAt));
      this.lastTickAt = now;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const tables = this.db.prepare('SELECT DISTINCT table_name FROM builds').all();
        for (const { table_name: tableName } of tables) this.tickTable(tableName, now, dt);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.busy = false;
    }
  }

  tickTable(tableName, now, dt) {
    const builds = this.db
      .prepare(
        `SELECT * FROM builds WHERE table_name = ? AND status != 'reclaimed'
         ORDER BY generation ASC`,
      )
      .all(tableName);
    if (!builds.length) return;

    // 1. Fill free worker slots. A build schedules only its own partitions, up
    //    to its own concurrency, so two builds can genuinely interleave.
    for (const build of builds) {
      const options = normalizeOptions(jsonOr(build.options, {}), readSettings(this.db));
      const parts = this.db
        .prepare('SELECT * FROM partitions WHERE build_id = ? ORDER BY no')
        .all(build.id);
      let active = parts.filter((p) => ACTIVE.has(p.status)).length;
      let free = Math.max(0, options.concurrency - active);
      if (free === 0) continue;
      for (const part of parts) {
        if (free === 0) break;
        if (part.status === 'pending') {
          this.startBuildStage(build, part, options, now);
          free -= 1;
        } else if (part.status === 'built') {
          this.startVerifyStage(build, part, options, now);
          free -= 1;
        }
      }
      if (build.started_at === null && parts.some((p) => p.status !== 'pending')) {
        this.db.prepare('UPDATE builds SET started_at = ? WHERE id = ?').run(now, build.id);
      }
    }

    // 2. Advance in-flight stages by this tick's wall time. Reads hit the
    //    actual synthetic source and checkpoint into the partition row.
    const activeParts = this.db
      .prepare(
        `SELECT p.* FROM partitions p JOIN builds b ON b.id = p.build_id
         WHERE b.table_name = ? AND b.status != 'reclaimed'
           AND p.status IN ('building', 'verifying')`,
      )
      .all(tableName);
    for (const part of activeParts) {
      const build = builds.find((b) => b.id === part.build_id);
      if (!build) continue;
      const options = normalizeOptions(jsonOr(build.options, {}), readSettings(this.db));
      if (part.status === 'building') this.advanceBuild(build, part, options, now, dt);
      else this.advanceVerify(build, part, options, now, dt);
    }

    // 3. Settle build-level status, promotion and supersession.
    for (const build of builds) this.settleBuild(build, now);
  }

  setBuildRunning(build, now) {
    if (build.status === 'queued' || build.status === 'paused' || build.status === 'failed') {
      this.db.prepare('UPDATE builds SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?')
        .run('running', now, build.id);
      build.status = 'running';
    }
  }

  startBuildStage(buildRow, part, options, now) {
    const build = this.freshBuild(buildRow);
    const def = partitionDef(part.no);
    const attempt = Number(part.build_attempts) + 1;
    this.db
      .prepare(
        `UPDATE partitions
         SET status='building', stage='build', cursor_index=?, rows_done=0, phase_progress=0,
             agg=?, verify_agg=NULL, verified=NULL, error=NULL, build_attempts=?,
             started_at=COALESCE(started_at, ?), finished_at=NULL
         WHERE id=?`,
      )
      .run(def.scanStartIndex, JSON.stringify(emptyAggregate()), attempt, now, part.id);
    this.db
      .prepare('UPDATE builds SET started_at = COALESCE(started_at, ?), status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
      .run(now, 'queued', 'running', build.id);
    const planned = failurePlan(options, part.no, 'build', attempt);
    const { buildMs } = stageDurations(options, part.no);
    logEvent(this.db, {
      tableName: build.table_name,
      buildId: build.id,
      generation: build.generation,
      partitionNo: part.no,
      kind: 'partition-start',
      message: `分区 ${part.no} 开始构建：扫描 ${def.rowsTotal.toLocaleString('en-US')} 行，预算 ${buildMs}ms，第 ${attempt} 次尝试${planned ? '，已挂载注入故障' : ''}`,
    });
  }

  startVerifyStage(buildRow, part, options, now) {
    const build = this.freshBuild(buildRow);
    const def = partitionDef(part.no);
    const attempt = Number(part.verify_attempts) + 1;
    const planned = failurePlan(options, part.no, 'verify', attempt);
    const { verifyMs } = stageDurations(options, part.no);
    this.db
      .prepare(
        `UPDATE partitions
         SET status='verifying', stage='verify', cursor_index=?, rows_done=0, phase_progress=0,
             verify_agg=?, error=NULL, verify_attempts=?
         WHERE id=?`,
      )
      .run(def.scanStartIndex, JSON.stringify(emptyAggregate()), attempt, part.id);
    logEvent(this.db, {
      tableName: build.table_name,
      buildId: build.id,
      generation: build.generation,
      partitionNo: part.no,
      kind: 'partition-verify-start',
      message: `分区 ${part.no} 开始独立复核：重扫 ${def.rowsTotal.toLocaleString('en-US')} 行，预算 ${verifyMs}ms，第 ${attempt} 次${planned ? '，已挂载注入故障' : ''}`,
    });
  }

  advanceBuild(buildRow, part, options, now, dt) {
    const build = this.freshBuild(buildRow);
    const def = partitionDef(part.no);
    const scanRule = ruleToScan(getRule(this.db, build.rule_version));
    const { buildMs } = stageDurations(options, part.no);
    const nextProgress = Math.min(1, Number(part.phase_progress) + dt / buildMs);
    const planned = failurePlan(options, part.no, 'build', Number(part.build_attempts));
    const failAt = planned && nextProgress >= planned.at ? planned.at : null;
    const prog = failAt ?? nextProgress;
    const target = Math.min(def.scanEndIndex, def.scanStartIndex + Math.round(def.rowsTotal * prog));
    const agg = jsonOr(part.agg, emptyAggregate());

    if (target > part.cursor_index) {
      scanOrders({
        startIndex: part.cursor_index,
        endIndex: target,
        def,
        dataRevision: build.source_version,
        rule: scanRule,
        agg,
      });
    }
    const cursor = Math.max(part.cursor_index, target);
    const rowsDone = Math.min(def.rowsTotal, cursor - def.scanStartIndex);

    if (failAt !== null) {
      const message = `注入故障：构建阶段在 ${pct(failAt)} 处中断（已扫 ${rowsDone.toLocaleString('en-US')} / ${def.rowsTotal.toLocaleString('en-US')} 行）`;
      this.db
        .prepare(
          `UPDATE partitions SET status='failed', error=?, cursor_index=?, rows_done=?, agg=?, phase_progress=?
           WHERE id=?`,
        )
        .run(message, cursor, rowsDone, JSON.stringify(agg), failAt, part.id);
      logEvent(this.db, {
        tableName: build.table_name,
        buildId: build.id,
        generation: build.generation,
        partitionNo: part.no,
        kind: 'partition-failed',
        level: 'error',
        message: `分区 ${part.no} 构建失败：${message}`,
      });
      return;
    }

    if (nextProgress >= 1) {
      agg.netCents = agg.grossCents - agg.refundCents + agg.feeCents;
      let tampered = false;
      // Corruption is injected once per partition: retrying rebuilds from the
      // real source and recovers, which is what the demo is meant to show.
      if (options.corrupt.includes(part.no) && Number(part.build_attempts) === 1) {
        // Deliberate corruption of the staged aggregate - the verification
        // stage must catch this with its independent re-scan.
        agg.refundCents += 147_832;
        agg.checkValue = (agg.checkValue ^ 0x5a5a5a5a) >>> 0;
        tampered = true;
      }
      this.db
        .prepare(
          `UPDATE partitions
           SET status='built', stage='build', cursor_index=?, rows_done=?, agg=?, phase_progress=1,
               error=?, verify_agg=NULL, verified=NULL
           WHERE id=?`,
        )
        .run(
          cursor,
          rowsDone,
          JSON.stringify(agg),
          tampered ? '注入故障：构建产物已被篡改，等待复核' : null,
          part.id,
        );
      logEvent(this.db, {
        tableName: build.table_name,
        buildId: build.id,
        generation: build.generation,
        partitionNo: part.no,
        kind: tampered ? 'partition-tampered' : 'partition-built',
        level: tampered ? 'warning' : 'success',
        message: tampered
          ? `分区 ${part.no} 构建产物被注入篡改（退款额被改写），复核将独立重扫验证`
          : `分区 ${part.no} 构建完成：${rowsDone.toLocaleString('en-US')} 行，净额 ${money(agg.netCents)}，校验值 0x${(agg.checkValue >>> 0).toString(16).slice(-8)}`,
      });
      return;
    }

    this.db
      .prepare(
        `UPDATE partitions SET cursor_index=?, rows_done=?, agg=?, phase_progress=? WHERE id=?`,
      )
      .run(cursor, rowsDone, JSON.stringify(agg), nextProgress, part.id);
  }

  advanceVerify(buildRow, part, options, now, dt) {
    const build = this.freshBuild(buildRow);
    const def = partitionDef(part.no);
    const scanRule = ruleToScan(getRule(this.db, build.rule_version));
    const { verifyMs } = stageDurations(options, part.no);
    const nextProgress = Math.min(1, Number(part.phase_progress) + dt / verifyMs);
    const planned = failurePlan(options, part.no, 'verify', Number(part.verify_attempts));
    const failAt = planned && nextProgress >= planned.at ? planned.at : null;
    const prog = failAt ?? nextProgress;
    const target = Math.min(def.scanEndIndex, def.scanStartIndex + Math.round(def.rowsTotal * prog));
    const verifyAgg = jsonOr(part.verify_agg, emptyAggregate());

    if (target > part.cursor_index) {
      scanOrders({
        startIndex: part.cursor_index,
        endIndex: target,
        def,
        dataRevision: build.source_version,
        rule: scanRule,
        agg: verifyAgg,
      });
    }
    const cursor = Math.max(part.cursor_index, target);
    const rowsDone = Math.min(def.rowsTotal, cursor - def.scanStartIndex);

    if (failAt !== null) {
      this.db
        .prepare(
          `UPDATE partitions SET status='failed', error=?, cursor_index=?, rows_done=?, verify_agg=?, phase_progress=?
           WHERE id=?`,
        )
        .run(
          `注入故障：复核阶段在 ${pct(failAt)} 处中断（已重扫 ${rowsDone.toLocaleString('en-US')} 行）`,
          cursor,
          rowsDone,
          JSON.stringify(verifyAgg),
          failAt,
          part.id,
        );
      logEvent(this.db, {
        tableName: build.table_name,
        buildId: build.id,
        generation: build.generation,
        partitionNo: part.no,
        kind: 'partition-verify-failed',
        level: 'error',
        message: `分区 ${part.no} 复核中断：注入故障触发`,
      });
      return;
    }

    if (nextProgress < 1) {
      this.db
        .prepare(
          `UPDATE partitions SET cursor_index=?, rows_done=?, verify_agg=?, phase_progress=? WHERE id=?`,
        )
        .run(cursor, rowsDone, JSON.stringify(verifyAgg), nextProgress, part.id);
      return;
    }

    const built = jsonOr(part.agg, emptyAggregate());
    const outcome = verifyAggregate(built, verifyAgg);
    const verified = {
      ...scorer(built, build.source_version, build.rule_version, now, verifyMs),
      ok: outcome.ok,
      mismatches: outcome.mismatches,
      rowsScanned: verifyAgg.rowsScanned,
    };

    if (!outcome.ok) {
      const fields = outcome.mismatches.map((m) => m.field).join(', ');
      this.db
        .prepare(
          `UPDATE partitions SET status='failed', error=?, cursor_index=?, rows_done=?, verify_agg=?, verified=?, phase_progress=1
           WHERE id=?`,
        )
        .run(
          `复核不一致：${fields}`,
          cursor,
          rowsDone,
          JSON.stringify(verifyAgg),
          JSON.stringify(verified),
          part.id,
        );
      logEvent(this.db, {
        tableName: build.table_name,
        buildId: build.id,
        generation: build.generation,
        partitionNo: part.no,
        kind: 'partition-mismatch',
        level: 'error',
        message: `分区 ${part.no} 复核不一致：${fields}。读入口保持不变`,
      });
      return;
    }

    this.db
      .prepare(
        `UPDATE partitions
         SET status='verified', stage='done', cursor_index=?, rows_done=?, verify_agg=?, verified=?,
             phase_progress=1, finished_at=?, error=NULL
         WHERE id=?`,
      )
      .run(cursor, rowsDone, JSON.stringify(verifyAgg), JSON.stringify(verified), now, part.id);
    logEvent(this.db, {
      tableName: build.table_name,
      buildId: build.id,
      generation: build.generation,
      partitionNo: part.no,
      kind: 'partition-verified',
      level: 'success',
      message: `分区 ${part.no} 核对通过：${VERIFY_FIELDS.length} 项字段一致，独立重扫 ${verifyAgg.rowsScanned.toLocaleString('en-US')} 行，校验值 0x${(verifyAgg.checkValue >>> 0).toString(16).slice(-8)}`,
    });
  }

  freshBuild(buildRow) {
    return this.db.prepare('SELECT * FROM builds WHERE id = ?').get(buildRow.id) || buildRow;
  }

  settleBuild(buildRow, now) {
    const build = this.freshBuild(buildRow);
    if (build.status === 'reclaimed') return;
    const parts = this.db
      .prepare('SELECT * FROM partitions WHERE build_id = ? ORDER BY no')
      .all(build.id);
    const allVerified = parts.length > 0 && parts.every((p) => p.status === 'verified');

    if (allVerified) {
      if (build.completed_at) return;
      const totals = sumAggs(parts);
      this.db
        .prepare('UPDATE generations SET completed_at = ?, summary = ? WHERE table_name = ? AND generation = ?')
        .run(now, JSON.stringify(totals), build.table_name, build.generation);
      const pointer = pointerFor(this.db, build.table_name);
      const latest = latestGeneration(this.db, build.table_name);
      // Only the current generation may move the read entry. If a newer
      // generation was initiated while this one was running - or the pointer
      // already moved past it - the result is retained for comparison but
      // never overrides the newer read entry.
      if (latest > build.generation || (pointer && pointer.generation > build.generation)) {
        const blocker = latest > build.generation ? latest : pointer.generation;
        const blockerBuild = this.db
          .prepare('SELECT id FROM builds WHERE table_name = ? AND generation = ?')
          .get(build.table_name, blocker);
        this.db
          .prepare(
            `UPDATE builds SET status='superseded', completed_at=?, superseded_at=?, superseded_by=?
             WHERE id=?`,
          )
          .run(now, now, blockerBuild?.id ?? null, build.id);
        logEvent(this.db, {
          tableName: build.table_name,
          buildId: build.id,
          generation: build.generation,
          kind: 'build-superseded',
          level: 'warning',
          message: `代次 ${build.generation} 全部核对通过，但代次 ${blocker} 已在推进或已可见；结果保留用于对比，不切换读入口`,
        });
        return;
      }
      this.promote(build, totals, now);
      return;
    }

    if (build.completed_at) return;

    const anyActive = parts.some((p) => ACTIVE.has(p.status));
    const anyPaused = parts.some((p) => p.status === 'paused');
    const anyFailed = parts.some((p) => p.status === 'failed');
    let status = 'queued';
    if (anyActive) status = 'running';
    else if (anyFailed) status = 'failed';
    else if (anyPaused) status = 'paused';
    else if (parts.some((p) => p.status !== 'pending')) status = 'running';
    if (status !== build.status) {
      this.db.prepare('UPDATE builds SET status=? WHERE id=?').run(status, build.id);
    }
  }

  promote(build, totals, now) {
    this.db
      .prepare(
        `INSERT INTO read_pointer (table_name, generation, build_id, switched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(table_name) DO UPDATE SET
           generation=excluded.generation, build_id=excluded.build_id, switched_at=excluded.switched_at`,
      )
      .run(build.table_name, build.generation, build.id, now);
    this.db
      .prepare('UPDATE builds SET status=?, completed_at=COALESCE(completed_at, ?), promoted_at=? WHERE id=?')
      .run('complete', now, now, build.id);
    // Every older completed generation is now superseded; results are retained
    // for comparison until explicitly reclaimed.
    const older = this.db
      .prepare(
        `SELECT id, generation FROM builds
         WHERE table_name = ? AND generation < ? AND completed_at IS NOT NULL
           AND status != 'reclaimed' AND status != 'superseded'`,
      )
      .all(build.table_name, build.generation);
    for (const row of older) {
      this.db
        .prepare('UPDATE builds SET status=?, superseded_at=COALESCE(superseded_at, ?), superseded_by=? WHERE id=?')
        .run('superseded', now, build.id, row.id);
    }
    logEvent(this.db, {
      tableName: build.table_name,
      buildId: build.id,
      generation: build.generation,
      kind: 'promote',
      level: 'success',
      message: `${PARTITION_COUNT}/${PARTITION_COUNT} 分区核对通过，读入口切换到代次 ${build.generation}；全表净额 ${money(totals.netCents)}`,
    });
  }
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function money(cents) {
  return `¥${((cents || 0) / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
