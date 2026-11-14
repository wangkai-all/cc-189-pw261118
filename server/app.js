import {
  DATA,
  SOURCE_VERSIONS,
  computePartitionFull,
  emptyAggregate,
  partitionDefs,
  ruleToScan,
  scanOrders,
  sumCheckValues,
  VERIFY_FIELDS,
} from './synthetic.js';
import {
  PARTITION_COUNT,
  failurePlan,
  getRule,
  jsonOr,
  listRules,
  logEvent,
  normalizeOptions,
  readSettings,
  stageDurations,
  sumAggs,
  tableNameFor,
} from './support.js';
import {
  Engine,
  ensureBaseline,
  latestGeneration,
  liveLeaseCounts,
  liveLeases,
  pointerFor,
  SOURCE_VERSION_META,
} from './engine.js';

const STATUS_LABEL = {
  pending: '待构建',
  building: '构建中',
  built: '待复核',
  verifying: '复核中',
  verified: '已核对',
  failed: '失败',
  paused: '已暂停',
  queued: '排队中',
  running: '进行中',
  complete: '已完成（可见）',
  superseded: '已被替代',
  reclaimed: '已回收',
};

const STAGE_LABEL = { '': '未开始', build: '构建', verify: '复核', built: '待复核' };

export function statusLabel(status) {
  return STATUS_LABEL[status] || status;
}

export class App {
  constructor(db, { clock = Date.now, startEngine = true } = {}) {
    this.db = db;
    this.clock = clock;
    this.engine = new Engine(db, { clock, tickMs: 100, log: (m) => console.error(m) });
    ensureBaseline(db, clock);
    if (startEngine) this.engine.start();
  }

  close() {
    this.engine.stop();
  }

  tableName() {
    return tableNameFor(this.db);
  }

  // ---------- reads ----------

  state() {
    const db = this.db;
    const now = this.clock();
    const tableName = this.tableName();
    const settings = readSettings(db);
    const builds = buildsFor(db, tableName);
    const pointer = pointerFor(db, tableName);
    const latest = latestGeneration(db, tableName);
    const leaseCounts = liveLeaseCounts(db, tableName, now);
    const generations = generationRows(db, tableName);

    const buildMap = new Map(builds.map((b) => [b.generation, b]));
    const genMap = new Map(generations.map((g) => [g.generation, g]));

    const serializedBuilds = builds.map((b) => this.serializeBuild(b, { now, pointer, latest }));

    const history = [];
    const maxGen = Math.max(latest, ...generations.map((g) => g.generation), 0);
    for (let generation = 1; generation <= maxGen; generation += 1) {
      const build = buildMap.get(generation);
      const gen = genMap.get(generation);
      if (!build && !gen) continue;
      const visible = pointer?.generation === generation;
      const summary = gen?.summary ? jsonOr(gen.summary, null) : null;
      const live = build ? this.partialSummary(build.id) : null;
      history.push({
        generation,
        buildId: build?.id ?? gen?.build_id ?? null,
        status: build ? build.status : 'reclaimed',
        statusLabel: statusLabel(build ? build.status : 'reclaimed'),
        sourceVersion: build?.source_version ?? null,
        ruleVersion: build?.rule_version ?? null,
        note: build?.note || '',
        visible,
        isLatest: generation === latest,
        completedAt: gen?.completed_at ?? build?.completed_at ?? null,
        reclaimedAt: gen?.reclaimed_at ?? build?.reclaimed_at ?? null,
        liveLeases: leaseCounts.get(generation) || 0,
        // Structurally reclaimable (completed, not the read entry, not latest,
        // not already reclaimed). Live readers are checked again at click time.
        canReclaim:
          Boolean(gen?.completed_at) &&
          !visible &&
          !gen?.reclaimed_at &&
          generation !== latest,
        liveReadersBlockReclaim: (leaseCounts.get(generation) || 0) > 0,
        reclaimBlockedBy:
          gen?.reclaimed_at
            ? '已回收'
            : !Boolean(gen?.completed_at)
              ? '尚未完成'
              : visible
                ? '当前读入口指向该代次'
                : generation === latest
                  ? '最新代次尚未被替代'
                  : (leaseCounts.get(generation) || 0) > 0
                    ? `${leaseCounts.get(generation)} 个读者持有租约`
                    : null,
        summary,
        partial: build && !summary ? live : null,
        partitionsVerified: build?.partitions_verified ?? PARTITION_COUNT,
      });
    }

    const leases = db
      .prepare(
        `SELECT * FROM leases WHERE table_name = ? ORDER BY id DESC LIMIT 50`,
      )
      .all(tableName)
      .map((row) => ({
        id: row.id,
        generation: row.generation,
        readerId: row.reader_id,
        purpose: row.purpose,
        acquiredAt: row.acquired_at,
        expiresAt: row.expires_at,
        releasedAt: row.released_at,
        active: row.released_at === null && row.expires_at > now,
        msLeft: Math.max(0, row.expires_at - now),
      }));

    const events = db
      .prepare(
        `SELECT * FROM events WHERE table_name = ? ORDER BY id DESC LIMIT 120`,
      )
      .all(tableName)
      .map((row) => ({
        id: row.id,
        at: row.at,
        level: row.level,
        kind: row.kind,
        message: row.message,
        buildId: row.build_id,
        generation: row.generation,
        partitionNo: row.partition_no,
      }));

    const visibleBuild = pointer ? buildMap.get(pointer.generation) : null;
    const visibleGeneration = pointer
      ? genMap.get(pointer.generation) ||
        (visibleBuild
          ? {
              generation: pointer.generation,
              build_id: pointer.build_id,
              summary: null,
            }
          : null)
      : null;
    const visibleSummary = pointer
      ? genMap.get(pointer.generation)?.summary
        ? jsonOr(genMap.get(pointer.generation).summary, null)
        : visibleBuild
          ? this.partialSummary(visibleBuild.id)
          : null
      : null;

    const sourceVersions = SOURCE_VERSIONS.map((v) => ({ ...v }));

    return {
      now,
      tableName,
      settings,
      rules: listRules(db),
      sourceVersions,
      structure: {
        name: tableName,
        ordersTotal: DATA.ordersTotal,
        days: DATA.days,
        ordersPerDay: DATA.ordersPerDay,
        partitions: partitionDefs().map((d) => ({
          no: d.no,
          startDay: d.startDay,
          endDay: d.endDay,
          lookbackStartDay: d.lookbackStartDay,
          rowsTotal: d.rowsTotal,
          scanStartDay: d.lookbackStartDay,
        })),
        verifyFields: VERIFY_FIELDS,
      },
      latestGeneration: latest,
      pointer: pointer
        ? {
            generation: pointer.generation,
            buildId: pointer.build_id,
            switchedAt: pointer.switched_at,
          }
        : null,
      visible: {
        generation: pointer?.generation ?? null,
        buildId: pointer?.build_id ?? null,
        switchedAt: pointer?.switched_at ?? null,
        summary: visibleSummary,
        sourceVersion: visibleBuild?.source_version ?? null,
        ruleVersion: visibleBuild?.rule_version ?? null,
        note: visibleBuild?.note ?? '',
        liveLeases: pointer ? leaseCounts.get(pointer.generation) || 0 : 0,
      },
      builds: serializedBuilds,
      history,
      leases,
      events,
    };
  }

  serializeBuild(build, { now, pointer, latest }) {
    const db = this.db;
    const options = normalizeOptions(jsonOr(build.options, {}), readSettings(db));
    const parts = db
      .prepare('SELECT * FROM partitions WHERE build_id = ? ORDER BY no')
      .all(build.id);
    const counts = {};
    for (const p of parts) counts[p.status] = (counts[p.status] || 0) + 1;
    const verifiedCount = counts.verified || 0;
    const failedCount = counts.failed || 0;
    const pausedCount = counts.paused || 0;
    const activeCount = (counts.building || 0) + (counts.verifying || 0);
    const complete = verifiedCount === parts.length && parts.length > 0;
    const visible = pointer?.build_id === build.id;
    const superseded = build.status === 'superseded' || (build.generation < latest && !visible);
    const running = build.status === 'running' || activeCount > 0;
    const paused = !running && pausedCount > 0 && !complete;

    let displayStatus = build.status;
    if (build.status === 'reclaimed') displayStatus = 'reclaimed';
    else if (complete && visible) displayStatus = 'complete';
    else if (complete && !visible) displayStatus = 'superseded';
    else if (running) displayStatus = 'running';
    else if (failedCount > 0) displayStatus = 'failed';
    else if (paused) displayStatus = 'paused';
    else if (superseded && !complete) displayStatus = 'superseded';
    else displayStatus = 'queued';

    const effectiveOptions = options;
    const partitions = parts.map((p) => this.serializePartition(p, effectiveOptions, build));
    const agg = complete ? sumAggs(parts) : null;
    const liveAgg = this.partialAgg(parts);
    const supersededByGeneration = build.superseded_by
      ? db
          .prepare('SELECT generation FROM builds WHERE id = ?')
          .get(build.superseded_by)?.generation ?? null
      : null;

    return {
      id: build.id,
      generation: build.generation,
      tableName: build.table_name,
      sourceVersion: build.source_version,
      ruleVersion: build.rule_version,
      status: displayStatus,
      statusLabel: statusLabel(displayStatus),
      rawStatus: build.status,
      note: build.note,
      options: effectiveOptions,
      createdAt: build.created_at,
      startedAt: build.started_at,
      completedAt: build.completed_at,
      supersededAt: build.superseded_at,
      supersededBy: build.superseded_by,
      supersededByGeneration,
      promotedAt: build.promoted_at,
      reclaimedAt: build.reclaimed_at,
      reclaimBlockedAt: build.reclaim_blocked_at,
      release: build.generation < latest && !visible,
      isLatest: build.generation === latest,
      isVisible: visible,
      canResume:
        build.generation === latest &&
        build.status !== 'reclaimed' &&
        !complete &&
        (failedCount > 0 || pausedCount > 0),
      canPause:
        build.generation === latest &&
        build.status !== 'reclaimed' &&
        !complete &&
        (activeCount > 0 || (counts.pending || 0) > 0 || (counts.built || 0) > 0),
      canReclaim:
        complete &&
        !visible &&
        build.status !== 'reclaimed' &&
        build.generation !== latest,
      counts,
      partitionsTotal: parts.length,
      partitionsVerified: verifiedCount,
      partitionsFailed: failedCount,
      partitionsPaused: pausedCount,
      partitionsActive: activeCount,
      partitionsPending: counts.pending || 0,
      complete,
      agg,
      liveAgg,
      partitions,
    };
  }

  serializePartition(row, options, build) {
    const verified = jsonOr(row.verified, null);
    const stage = row.stage || '';
    // Reclaim drops the partition artifacts. The row keeps its historical
    // status for audit, but the console must not render it as a live result.
    const reclaimed = build.status === 'reclaimed' && row.agg === null;
    const status = reclaimed ? 'reclaimed' : row.status;
    const planned =
      row.status === 'failed' && stage
        ? failurePlan(options, row.no, stage, stage === 'build' ? row.build_attempts : row.verify_attempts)
        : null;
    return {
      no: row.no,
      status,
      statusLabel: statusLabel(status),
      stage,
      stageLabel: STAGE_LABEL[stage] || '',
      rowsTotal: row.rows_total,
      rowsDone: row.rows_done,
      progress: Number(row.phase_progress) || 0,
      pct: row.rows_total ? Math.min(1, (row.rows_done / row.rows_total)) : 0,
      cursorIndex: row.cursor_index,
      error: row.error,
      buildAttempts: row.build_attempts,
      verifyAttempts: row.verify_attempts,
      plannedFailure: planned ? { at: planned.at, stage: planned.stage, mode: planned.mode } : null,
      corruptOnBuild: options.corrupt.includes(row.no) && Number(row.build_attempts) <= 1,
      tampered: Boolean(options.corrupt.includes(row.no)),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      agg: jsonOr(row.agg, null),
      verifyAgg: jsonOr(row.verify_agg, null),
      verified: reclaimed ? null : verified,
      canPause:
        !reclaimed &&
        ['pending', 'building', 'verifying', 'built'].includes(row.status) &&
        !(row.status === 'verified') &&
        build.status !== 'reclaimed',
      canResume: !reclaimed && row.status === 'paused',
      canRetry: !reclaimed && row.status === 'failed',
    };
  }

  partialAgg(parts) {
    return sumAggs(parts);
  }

  partialSummary(buildId) {
    const parts = this.db
      .prepare('SELECT * FROM partitions WHERE build_id = ? ORDER BY no')
      .all(buildId);
    return sumAggs(parts);
  }

  // ---------- commands ----------

  createBuild(input) {
    const db = this.db;
    const tableName = this.tableName();
    if (input?.sourceVersion === undefined || input?.ruleVersion === undefined) {
      throw conflict('发起重建需要同时指定 sourceVersion 与 ruleVersion');
    }
    const dataSource = Number(input.sourceVersion);
    const ruleVersion = Number(input.ruleVersion);
    if (!SOURCE_VERSION_META.some((v) => v.version === dataSource)) {
      throw conflict(`未知源版本 ${input.sourceVersion}`);
    }
    const rule = getRule(db, ruleVersion);
    if (!rule) throw conflict(`未知规则版本 ${input.ruleVersion}`);

    const defaults = readSettings(db);
    const options = normalizeOptions(input.options ?? {}, defaults);
    const now = this.clock();
    const generation = latestGeneration(db, tableName) + 1;

    const insert = db
      .prepare(
        `INSERT INTO builds (table_name, generation, source_version, rule_version, status, note, options, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(
        tableName,
        generation,
        dataSource,
        ruleVersion,
        String(input.note ?? '').slice(0, 200),
        JSON.stringify(options),
        now,
      );
    const buildId = Number(insert.lastInsertRowid);

    const insPart = db.prepare(
      `INSERT INTO partitions (build_id, no, status, stage, rows_total, rows_done, cursor_index,
                               phase_progress, build_attempts, verify_attempts)
       VALUES (?, ?, 'pending', '', ?, 0, ?, 0, 0, 0)`,
    );
    for (const def of partitionDefs()) {
      insPart.run(buildId, def.no, def.rowsTotal, def.scanStartIndex);
    }

    // The generation ledger is written at creation time so a build is
    // traceable (and non-readable) before it completes.
    db.prepare(
      `INSERT INTO generations (table_name, generation, build_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(tableName, generation, buildId, now);

    logEvent(db, {
      tableName,
      buildId,
      generation,
      kind: 'build-create',
      message: `发起重建代次 ${generation}：源 v${dataSource} / 规则 v${ruleVersion}；${PARTITION_COUNT} 个分区，并发 ${options.concurrency}，构建 ${options.partitionMs}ms + 复核 ${options.verifyMs}ms${options.failures.length ? `，注入 ${options.failures.length} 个故障` : ''}${options.corrupt.length ? `，篡改分区 ${options.corrupt.join(',')}` : ''}`,
    });

    return this.serializeBuild(
      db.prepare('SELECT * FROM builds WHERE id = ?').get(buildId),
      { now, pointer: pointerFor(db, tableName), latest: generation },
    );
  }

  findBuild(buildId) {
    return this.db.prepare('SELECT * FROM builds WHERE id = ?').get(Number(buildId)) || null;
  }

  findPartition(buildId, no) {
    return (
      this.db
        .prepare('SELECT * FROM partitions WHERE build_id = ? AND no = ?')
        .get(Number(buildId), Number(no)) || null
    );
  }

  requireBuild(buildId, { mutation = true } = {}) {
    const build = this.findBuild(buildId);
    if (!build) throw notFound(`构建任务 ${buildId} 不存在`);
    if (build.table_name !== this.tableName()) throw notFound('构建任务不属于当前表');
    if (build.status === 'reclaimed') throw conflict(`代次 ${build.generation} 已回收，无法继续操作`);
    return build;
  }

  requirePartition(buildId, no) {
    const build = this.requireBuild(buildId);
    const part = this.findPartition(buildId, no);
    if (!part) throw notFound(`分区 ${no} 不存在`);
    return { build, part };
  }

  pausePartition(buildId, no) {
    const { build, part } = this.requirePartition(buildId, no);
    if (part.status === 'verified') throw conflict(`分区 ${no} 已核对通过，无法暂停`);
    if (part.status === 'failed') throw conflict(`分区 ${no} 已失败，请使用重试`);
    if (part.status === 'paused') throw conflict(`分区 ${no} 已处于暂停状态`);
    if (part.status === 'pending' && build.status === 'complete') throw conflict('已完成的构建无需暂停');

    const now = this.clock();
    let stage = part.stage;
    if (part.status === 'pending' || part.status === 'building' || part.status === 'verifying') {
      stage = part.stage;
    } else if (part.status === 'built') {
      stage = 'built';
    }
    this.db
      .prepare(
        `UPDATE partitions
         SET status='paused', stage=?, error=?, cursor_index=?
         WHERE id=?`,
      )
      .run(
        stage,
        `已暂停于${STAGE_LABEL[stage] || '排队'}阶段（进度 ${Math.round((part.phase_progress || 0) * 100)}%）`,
        part.cursor_index,
        part.id,
      );
    logEvent(this.db, {
      tableName: build.table_name,
      buildId: build.id,
      generation: build.generation,
      partitionNo: no,
      kind: 'partition-paused',
      level: 'warning',
      message: `分区 ${no} 已暂停：${STAGE_LABEL[stage] || '排队'}阶段进度 ${Math.round((part.phase_progress || 0) * 100)}%，检查点保留（${part.cursor_index.toLocaleString('en-US')} 行位置）`,
    });
    this.settleAfterMutation(build);
    return this.serializeBuild(this.findBuild(buildId), {
      now,
      pointer: pointerFor(this.db, build.table_name),
      latest: latestGeneration(this.db, build.table_name),
    });
  }

  resumePartition(buildId, no) {
    const { build, part } = this.requirePartition(buildId, no);
    if (part.status !== 'paused') throw conflict(`分区 ${no} 不在暂停状态`);
    const now = this.clock();
    let status;
    if (part.stage === 'build') status = 'building';
    else if (part.stage === 'verify') status = 'verifying';
    else if (part.stage === 'built') status = 'built';
    else status = 'pending';
    this.db
      .prepare('UPDATE partitions SET status=?, error=NULL WHERE id=?')
      .run(status, part.id);
    logEvent(this.db, {
      tableName: build.table_name,
      buildId: build.id,
      generation: build.generation,
      partitionNo: no,
      kind: 'partition-resumed',
      message: `分区 ${no} 从${STAGE_LABEL[part.stage] || '排队'}阶段的检查点继续（已扫 ${part.rows_done.toLocaleString('en-US')} 行）`,
    });
    this.settleAfterMutation(build);
    return this.serializeBuild(this.findBuild(buildId), {
      now,
      pointer: pointerFor(this.db, build.table_name),
      latest: latestGeneration(this.db, build.table_name),
    });
  }

  retryPartition(buildId, no) {
    const { build, part } = this.requirePartition(buildId, no);
    if (part.status !== 'failed') throw conflict(`分区 ${no} 不在失败状态`);
    const now = this.clock();
    this.db
      .prepare(
        `UPDATE partitions
         SET status='pending', stage='', agg=NULL, verify_agg=NULL, verified=NULL, error=NULL,
             cursor_index=?, rows_done=0, phase_progress=0, finished_at=NULL
         WHERE id=?`,
      )
      .run(partitionDefs()[part.no - 1].scanStartIndex, part.id);
    logEvent(this.db, {
      tableName: build.table_name,
      buildId: build.id,
      generation: build.generation,
      partitionNo: no,
      kind: 'partition-retry',
      level: 'warning',
      message: `分区 ${no} 重新排队（构建第 ${part.build_attempts + 1} 次尝试）：丢弃旧产物并从头重算`,
    });
    this.settleAfterMutation(build);
    return this.serializeBuild(this.findBuild(buildId), {
      now,
      pointer: pointerFor(this.db, build.table_name),
      latest: latestGeneration(this.db, build.table_name),
    });
  }

  pauseBuild(buildId) {
    const build = this.requireBuild(buildId);
    const parts = this.db
      .prepare('SELECT * FROM partitions WHERE build_id = ? ORDER BY no')
      .all(build.id);
    let paused = 0;
    for (const part of parts) {
      if (['pending', 'building', 'verifying', 'built'].includes(part.status)) {
        this.pausePartition(build.id, part.no);
        paused += 1;
      }
    }
    if (paused === 0) throw conflict('该构建没有可暂停的分区');
    return this.serializeBuild(this.findBuild(buildId), {
      now: this.clock(),
      pointer: pointerFor(this.db, build.table_name),
      latest: latestGeneration(this.db, build.table_name),
    });
  }

  resumeBuild(buildId) {
    const build = this.requireBuild(buildId);
    const latest = latestGeneration(this.db, build.table_name);
    if (build.generation !== latest) {
      throw conflict(
        `代次 ${build.generation} 不是当前代次（当前为 ${latest}）；旧任务即使恢复也无法切换读入口，仅保留结果用于对比`,
      );
    }
    const parts = this.db
      .prepare('SELECT * FROM partitions WHERE build_id = ? ORDER BY no')
      .all(build.id);
    const paused = parts.filter((p) => p.status === 'paused');
    const failed = parts.filter((p) => p.status === 'failed');
    if (paused.length === 0 && failed.length === 0) throw conflict('当前任务没有可恢复的暂停或失败分区');

    const now = this.clock();
    for (const part of paused) this.resumePartition(build.id, part.no);
    for (const part of failed) this.retryPartition(build.id, part.no);
    if (build.status !== 'running') {
      this.db
        .prepare("UPDATE builds SET status='queued', completed_at=NULL WHERE id=?")
        .run(build.id);
    }
    logEvent(this.db, {
      tableName: build.table_name,
      buildId: build.id,
      generation: build.generation,
      kind: 'build-resumed',
      message: `恢复当前任务代次 ${build.generation}：${paused.length} 个暂停分区继续检查点，${failed.length} 个失败分区重新排队`,
    });
    return this.serializeBuild(this.findBuild(buildId), {
      now,
      pointer: pointerFor(this.db, build.table_name),
      latest,
    });
  }

  settleAfterMutation(build) {
    const parts = this.db
      .prepare('SELECT * FROM partitions WHERE build_id = ? ORDER BY no')
      .all(build.id);
    const active = parts.some((p) => ['building', 'verifying'].includes(p.status));
    const failed = parts.some((p) => p.status === 'failed');
    const paused = parts.some((p) => p.status === 'paused');
    const status = active ? 'running' : failed ? 'failed' : paused ? 'paused' : 'queued';
    if (build.status !== status && build.status !== 'reclaimed' && !build.completed_at) {
      this.db.prepare('UPDATE builds SET status=? WHERE id=?').run(status, build.id);
    }
  }

  acquireLease(input) {
    const db = this.db;
    const tableName = this.tableName();
    const now = this.clock();
    const pointer = pointerFor(db, tableName);
    const generation = Number(input.generation ?? pointer?.generation);
    if (!generation) throw conflict('当前没有任何可见代次');
    const gen = db
      .prepare('SELECT * FROM generations WHERE table_name = ? AND generation = ?')
      .get(tableName, generation);
    if (!gen) throw notFound(`代次 ${generation} 尚未完成，无法读取`);
    if (gen.reclaimed_at) throw conflict(`代次 ${generation} 已回收，读者无法再打开`);
    if (!gen.completed_at) throw conflict(`代次 ${generation} 尚未完成核对，无法读取`);
    const ttlMs = Math.min(600000, Math.max(1000, Number(input.ttlMs) || 15000));
    const readerId = String(input.readerId ?? '').trim().slice(0, 60) || `reader-${Math.random().toString(36).slice(2, 8)}`;
    const purpose = String(input.purpose ?? '').slice(0, 120) || '读取可见明细';
    const row = db
      .prepare(
        `INSERT INTO leases (table_name, generation, reader_id, purpose, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(tableName, generation, readerId, purpose, now, now + ttlMs);
    logEvent(db, {
      tableName,
      generation,
      kind: 'lease-acquired',
      message: `读者 ${readerId} 打开代次 ${generation}（${purpose}），租约 ${Math.round(ttlMs / 1000)}s，期间禁止回收`,
    });
    return {
      leaseId: Number(row.lastInsertRowid),
      generation,
      readerId,
      purpose,
      expiresAt: now + ttlMs,
      value: jsonOr(gen.summary, null),
    };
  }

  releaseLease(leaseId) {
    const now = this.clock();
    const lease = this.db.prepare('SELECT * FROM leases WHERE id = ?').get(Number(leaseId));
    if (!lease) throw notFound(`租约 ${leaseId} 不存在`);
    if (lease.released_at !== null) throw conflict(`租约 ${leaseId} 已释放`);
    this.db
      .prepare('UPDATE leases SET released_at = ? WHERE id = ?')
      .run(now, lease.id);
    logEvent(this.db, {
      tableName: lease.table_name,
      generation: lease.generation,
      kind: 'lease-released',
      message: `读者 ${lease.reader_id} 关闭代次 ${lease.generation}，租约 ${lease.id} 释放`,
    });
    return { released: true, leaseId: lease.id };
  }

  reclaimGeneration(generationInput) {
    const db = this.db;
    const tableName = this.tableName();
    const generation = Number(generationInput);
    if (!Number.isInteger(generation)) throw conflict('代次无效');
    const now = this.clock();
    const gen = db
      .prepare('SELECT * FROM generations WHERE table_name = ? AND generation = ?')
      .get(tableName, generation);
    if (!gen) throw notFound(`代次 ${generation} 不存在或尚未完成`);
    if (gen.reclaimed_at) throw conflict(`代次 ${generation} 已回收`);
    if (!gen.completed_at) throw conflict(`代次 ${generation} 尚未完成，不能回收`);
    const pointer = pointerFor(db, tableName);
    if (pointer?.generation === generation) throw conflict(`代次 ${generation} 是当前读入口，不能回收`);
    if (generation === latestGeneration(db, tableName)) throw conflict(`代次 ${generation} 是最新代次，尚未被替代，不能回收`);

    const active = liveLeases(db, tableName, generation, now);
    if (active.length > 0) {
      const readers = active.map((l) => `${l.reader_id}（剩余 ${Math.max(0, Math.round((l.expires_at - now) / 1000))}s）`).join('、');
      logEvent(db, {
        tableName,
        generation,
        kind: 'reclaim-blocked',
        level: 'warning',
        message: `回收代次 ${generation} 被拒绝：仍有 ${active.length} 个活跃读者（${readers}）`,
      });
      const error = conflict(`回收被拒绝：还有 ${active.length} 个读者正在使用代次 ${generation}（${readers}）`);
      error.statusCode = 409;
      error.readers = active.map((l) => ({ readerId: l.reader_id, expiresAt: l.expires_at, purpose: l.purpose }));
      throw error;
    }

    db.prepare(
      `UPDATE generations SET reclaimed_at = ? WHERE table_name = ? AND generation = ?`,
    ).run(now, tableName, generation);
    const build = db
      .prepare('SELECT id FROM builds WHERE table_name = ? AND generation = ?')
      .get(tableName, generation);
    if (build) {
      db.prepare(
        `UPDATE builds SET status='reclaimed', reclaimed_at=? WHERE id=?`,
      ).run(now, build.id);
      db.prepare(
        `UPDATE partitions SET agg=NULL, verify_agg=NULL, verified=NULL, error=NULL WHERE build_id=?`,
      ).run(build.id);
    }
    logEvent(db, {
      tableName,
      buildId: build?.id ?? null,
      generation,
      kind: 'reclaim',
      level: 'warning',
      message: `代次 ${generation} 已回收：无活跃读者，分区产物释放，汇总结果保留用于对比`,
    });
    return { reclaimed: true, generation };
  }

  // ---------- helpers exposed for tests ----------

  readGeneration(generation) {
    const tableName = this.tableName();
    const gen = this.db
      .prepare('SELECT * FROM generations WHERE table_name = ? AND generation = ?')
      .get(tableName, Number(generation));
    if (!gen) throw notFound(`代次 ${generation} 不存在`);
    if (gen.reclaimed_at) throw conflict(`代次 ${generation} 已回收`);
    return jsonOr(gen.summary, null);
  }

  recomputePartition(no, sourceVersion, ruleVersion) {
    const rule = ruleToScan(getRule(this.db, ruleVersion));
    return computePartitionFull(no, sourceVersion, rule);
  }
}

export function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

export function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

function buildsFor(db, tableName) {
  return db
    .prepare('SELECT * FROM builds WHERE table_name = ? ORDER BY generation ASC')
    .all(tableName);
}

function generationRows(db, tableName) {
  return db
    .prepare('SELECT * FROM generations WHERE table_name = ? ORDER BY generation ASC')
    .all(tableName);
}
