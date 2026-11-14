import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../server/app.js';
import { openDb } from '../server/db.js';
import {
  computePartitionFull,
  computeTableFull,
  partitionDefs,
  scanOrders,
  emptyAggregate,
  ruleToScan,
  SOURCE_VERSIONS,
  DATA,
} from '../server/synthetic.js';

class Clock {
  constructor(start = 1_000_000) {
    this.t = start;
  }
  now = () => this.t;
  advance(ms) {
    this.t += ms;
  }
}

function harness() {
  const db = openDb(':memory:');
  const clock = new Clock();
  const app = new App(db, { clock: clock.now, startEngine: false });
  const tick = (ms = 100, steps = 1) => {
    for (let i = 0; i < steps; i += 1) {
      clock.advance(ms);
      app.engine.tick(clock.now());
    }
  };
  return { db, app, clock, tick };
}

const FAST = { partitionMs: 600, verifyMs: 300, concurrency: 4 };

function completeBuild(app, tick, input, maxTicks = 300) {
  const build = app.createBuild(input);
  for (let i = 0; i < maxTicks; i += 1) {
    tick(100);
    const current = app.state().builds.find((b) => b.id === build.id);
    if (current.complete || current.status === 'failed') break;
  }
  return app.state().builds.find((b) => b.id === build.id);
}

// ---------------- source determinism ----------------

test('source revision is deterministic and partition scans are resumable', () => {
  const rule = { windowDays: 60, feeBps: 290, includeContested: false };
  const def = partitionDefs()[5];
  const whole = computePartitionFull(def.no, 3, rule);

  const chunked = emptyAggregate();
  const mid = Math.round((def.scanStartIndex + def.scanEndIndex) / 2);
  scanOrders({ startIndex: def.scanStartIndex, endIndex: mid, def, dataRevision: 3, rule, agg: chunked });
  scanOrders({ startIndex: mid, endIndex: def.scanEndIndex, def, dataRevision: 3, rule, agg: chunked });

  assert.deepEqual(chunked, whole);
  assert.ok(whole.orderCount > 0);
  assert.ok(whole.refundCount > 0);
});

test('source revisions only add refund events and change totals', () => {
  const rule = { windowDays: 60, feeBps: 290, includeContested: false };
  const v1 = computeTableFull(1, rule);
  const v2 = computeTableFull(2, rule);
  const v3 = computeTableFull(3, rule);
  assert.equal(v1.orderCount, DATA.ordersTotal);
  assert.equal(v1.orderCount, v2.orderCount);
  assert.ok(v2.refundCount > v1.refundCount, 'v2 adds late refunds');
  assert.notEqual(v2.refundCents, v1.refundCents);
  // v3 adds chargebacks but excludes reversed refunds
  assert.ok(v3.refundCount > v2.refundCount);
  assert.ok(v3.refundCents > v2.refundCents);
});

test('rule version changes the derived result', () => {
  const loose = computeTableFull(2, { windowDays: 75, feeBps: 240, includeContested: true });
  const tight = computeTableFull(2, { windowDays: 45, feeBps: 310, includeContested: false });
  assert.notEqual(loose.refundCents, tight.refundCents);
  assert.notEqual(loose.feeCents, tight.feeCents);
  assert.equal(loose.grossCents, tight.grossCents, 'gross is rule-independent');
});

test('every source/rule pair is reproducible', () => {
  for (const source of [1, 2, 3]) {
    for (const rule of [{ windowDays: 45, feeBps: 310, includeContested: false }, { windowDays: 75, feeBps: 240, includeContested: true }]) {
      const a = computePartitionFull(7, source, rule);
      const b = computePartitionFull(7, source, rule);
      assert.deepEqual(a, b);
    }
  }
});

// ---------------- baseline ----------------

test('baseline generation is computed and readable', () => {
  const { app } = harness();
  const state = app.state();
  assert.equal(state.visible.generation, 1);
  assert.ok(state.visible.summary.netCents > 0);
  assert.equal(state.visible.summary.orderCount, DATA.ordersTotal);
  assert.equal(state.builds[0].partitionsVerified, 12);
});

// ---------------- incremental build ----------------

test('a build passes through real checkpoints and promotes only when all 12 verified', () => {
  const { app, tick } = harness();
  const build = app.createBuild({ sourceVersion: 2, ruleVersion: 2, options: FAST });
  assert.equal(build.generation, 2);

  let sawPartial = false;
  let sawVerified = false;
  for (let i = 0; i < 200; i += 1) {
    tick(100);
    const current = app.state().builds.find((b) => b.id === build.id);
    if (current.partitionsVerified > 0 && current.partitionsVerified < 12) {
      sawPartial = true;
      assert.equal(app.state().visible.generation, 1, 'pointer must not move mid-build');
    }
    if (current.complete) {
      sawVerified = true;
      break;
    }
  }
  assert.ok(sawPartial, 'build should pass through a partially verified state');
  assert.ok(sawVerified, 'build should complete');

  const state = app.state();
  assert.equal(state.visible.generation, 2);
  assert.equal(state.builds.find((b) => b.generation === 2).partitionsVerified, 12);
  assert.equal(state.builds.find((b) => b.generation === 1).status, 'superseded');
});

test('a failed partition keeps the old read entry and can be retried', () => {
  const { app, tick } = harness();
  const build = app.createBuild({
    sourceVersion: 2,
    ruleVersion: 2,
    options: { ...FAST, failures: [{ partition: 4, stage: 'build', mode: 'once', at: 0.5 }] },
  });
  for (let i = 0; i < 200; i += 1) {
    tick(100);
    const current = app.state().builds.find((b) => b.id === build.id);
    if (!current.partitions.some((p) => ['building', 'verifying', 'pending', 'built'].includes(p.status))) break;
  }
  const failed = app.state();
  const build2 = failed.builds.find((b) => b.generation === 2);
  assert.equal(build2.status, 'failed');
  assert.equal(build2.partitions.find((p) => p.no === 4).status, 'failed');
  assert.equal(failed.visible.generation, 1, 'old table stays visible after failure');

  app.retryPartition(build.id, 4);
  for (let i = 0; i < 200; i += 1) {
    tick(100);
    if (app.state().builds.find((b) => b.generation === 2).complete) break;
  }
  const done = app.state();
  assert.equal(done.builds.find((b) => b.generation === 2).status, 'complete');
  assert.equal(done.visible.generation, 2);
});

test('tampered build output is rejected by the independent verification scan', () => {
  const { app, tick } = harness();
  const build = app.createBuild({
    sourceVersion: 3,
    ruleVersion: 2,
    options: { ...FAST, corrupt: [6] },
  });
  for (let i = 0; i < 200; i += 1) {
    tick(100);
    if (!app.state().builds.find((b) => b.id === build.id).partitions.some((p) => ['building', 'verifying', 'pending', 'built'].includes(p.status))) break;
  }
  const state = app.state();
  const part6 = state.builds.find((b) => b.generation === 2).partitions.find((p) => p.no === 6);
  assert.equal(part6.status, 'failed');
  assert.match(part6.error, /复核不一致/);
  assert.ok(part6.verified.mismatches.some((m) => m.field === 'refundCents'));
  assert.equal(state.visible.generation, 1);

  // Retry rebuilds from the real source, so verification now passes.
  app.retryPartition(build.id, 6);
  for (let i = 0; i < 200; i += 1) {
    tick(100);
    if (app.state().builds.find((b) => b.generation === 2).complete) break;
  }
  assert.equal(app.state().builds.find((b) => b.generation === 2).status, 'complete');
});

// ---------------- interleaving / generations ----------------

test('an older build finishing last cannot override a newer generation', () => {
  const { app, tick } = harness();
  const slow = app.createBuild({
    sourceVersion: 2,
    ruleVersion: 2,
    options: { partitionMs: 9000, verifyMs: 2000, concurrency: 2 },
  });
  tick(100, 6);
  const fast = app.createBuild({ sourceVersion: 3, ruleVersion: 3, options: { partitionMs: 400, verifyMs: 200, concurrency: 6 } });

  for (let i = 0; i < 500; i += 1) {
    tick(100);
    const state = app.state();
    if (state.builds.find((b) => b.id === fast.id).complete) break;
  }
  assert.equal(app.state().visible.generation, fast.generation);

  for (let i = 0; i < 1200; i += 1) {
    tick(100);
    if (app.state().builds.find((b) => b.id === slow.id).complete) break;
  }

  const state = app.state();
  const slowBuild = state.builds.find((b) => b.id === slow.id);
  assert.equal(state.visible.generation, fast.generation, 'read entry stays on newer generation');
  assert.equal(state.pointer.generation, fast.generation);
  assert.equal(slowBuild.complete, true, 'older build still finishes and keeps results');
  assert.equal(slowBuild.isVisible, false);
  assert.equal(slowBuild.supersededByGeneration, fast.generation);
});

test('generations increase monotonically and only the latest is eligible to promote', () => {
  const { app, tick } = harness();
  const a = app.createBuild({ sourceVersion: 1, ruleVersion: 2, options: FAST });
  const b = app.createBuild({ sourceVersion: 2, ruleVersion: 3, options: FAST });
  assert.equal(a.generation, 2);
  assert.equal(b.generation, 3);
  for (let i = 0; i < 400; i += 1) {
    tick(100);
    if (app.state().builds.every((x) => x.complete || x.status === 'superseded' || x.status === 'failed')) break;
  }
  assert.equal(app.state().visible.generation, 3);
});

// ---------------- pause / resume ----------------

test('pausing a partition freezes its checkpoint and resume continues from it', () => {
  const { app, tick } = harness();
  const build = app.createBuild({
    sourceVersion: 2,
    ruleVersion: 2,
    options: { partitionMs: 5000, verifyMs: 1000, concurrency: 2 },
  });
  tick(100, 12);
  const before = app.state().builds.find((b) => b.id === build.id);
  const running = before.partitions.find((p) => p.status === 'building');
  assert.ok(running, 'expected an active build');
  assert.ok(running.rowsDone > 0);

  app.pausePartition(build.id, running.no);
  tick(100, 10);
  const paused = app.state().builds.find((b) => b.id === build.id).partitions.find((p) => p.no === running.no);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.rowsDone, running.rowsDone, 'checkpoint does not advance while paused');

  app.resumePartition(build.id, running.no);
  const resumed = app.state().builds.find((b) => b.id === build.id).partitions.find((p) => p.no === running.no);
  assert.equal(resumed.status, 'building');
  assert.equal(resumed.rowsDone, running.rowsDone, 'resume continues from the checkpoint');
});

test('resume current task picks up paused and failed partitions', () => {
  const { app, tick } = harness();
  const build = app.createBuild({
    sourceVersion: 2,
    ruleVersion: 2,
    options: { ...FAST, failures: [{ partition: 2, stage: 'build', mode: 'always', at: 0.4 }] },
  });
  app.pausePartition(build.id, 5);
  for (let i = 0; i < 300; i += 1) {
    tick(100);
    const current = app.state().builds.find((b) => b.id === build.id);
    if (!current.partitions.some((p) => ['building', 'verifying', 'built'].includes(p.status))) break;
  }
  const stuck = app.state().builds.find((b) => b.id === build.id);
  assert.equal(stuck.status, 'failed');
  assert.equal(stuck.partitions.find((p) => p.no === 5).status, 'paused');
  assert.equal(stuck.canResume, true);

  app.resumeBuild(build.id);
  const afterResume = app.state().builds.find((b) => b.id === build.id);
  assert.ok(!afterResume.partitions.some((p) => p.status === 'paused'));
  assert.ok(afterResume.partitions.some((p) => ['pending', 'building', 'verifying'].includes(p.status)));
});

test('old generations cannot be resumed into the read entry', () => {
  const { app, tick } = harness();
  const slow = app.createBuild({ sourceVersion: 2, ruleVersion: 2, options: { partitionMs: 3000, verifyMs: 800, concurrency: 1 } });
  tick(100, 5);
  const fast = app.createBuild({ sourceVersion: 3, ruleVersion: 3, options: { partitionMs: 400, verifyMs: 150, concurrency: 6 } });
  for (let i = 0; i < 400; i += 1) {
    tick(100);
    if (app.state().builds.find((b) => b.id === fast.id).complete) break;
  }
  assert.throws(() => app.resumeBuild(slow.id), /不是当前代次/);
});

// ---------------- leases + reclaim ----------------

test('reclaim is refused while a reader holds a lease, and allowed after release', () => {
  const { app, tick } = harness();
  completeBuild(app, tick, { sourceVersion: 2, ruleVersion: 2, options: FAST });
  assert.equal(app.state().visible.generation, 2);

  const lease = app.acquireLease({ generation: 1, readerId: 'analyst', purpose: '对比', ttlMs: 60000 });
  assert.equal(app.state().history.find((h) => h.generation === 1).liveLeases, 1);
  assert.throws(() => app.reclaimGeneration(1), /回收被拒绝/);

  app.releaseLease(lease.leaseId);
  const reclaimed = app.reclaimGeneration(1);
  assert.equal(reclaimed.reclaimed, true);

  const history = app.state().history.find((h) => h.generation === 1);
  assert.equal(history.status, 'reclaimed');
  assert.ok(history.reclaimedAt);
  assert.ok(history.summary, 'summary retained for comparison');
  assert.throws(() => app.acquireLease({ generation: 1 }), /已回收/);

  // Reclaimed partition artifacts are gone: the console must not keep showing
  // them as verified results with a zeroed checksum.
  const reclaimedBuild = app.state().builds.find((b) => b.generation === 1);
  assert.ok(reclaimedBuild.partitions.every((p) => p.status === 'reclaimed'));
  assert.ok(reclaimedBuild.partitions.every((p) => p.verified === null && p.agg === null));
  assert.equal(reclaimedBuild.partitionsVerified, 12, 'audit count retained');
  assert.equal(reclaimedBuild.canPause, false);
});

test('reclaim is refused for the visible generation and incomplete generations', () => {
  const { app } = harness();
  assert.throws(() => app.reclaimGeneration(1), /当前读入口/);
  const build = app.createBuild({ sourceVersion: 2, ruleVersion: 2, options: FAST });
  assert.throws(() => app.reclaimGeneration(build.generation), /尚未完成/);
});

test('expired leases no longer block reclaim', () => {
  const { app, clock, tick } = harness();
  completeBuild(app, tick, { sourceVersion: 2, ruleVersion: 2, options: FAST });
  app.acquireLease({ generation: 1, readerId: 'short', ttlMs: 1000 });
  clock.advance(1500);
  const reclaimed = app.reclaimGeneration(1);
  assert.equal(reclaimed.reclaimed, true);
});

test('reader leases snapshot the generation value they opened', () => {
  const { app, tick } = harness();
  completeBuild(app, tick, { sourceVersion: 2, ruleVersion: 2, options: FAST });
  const lease = app.acquireLease({ generation: 2, readerId: 'r1' });
  assert.ok(lease.value.netCents > 0);
  assert.equal(lease.generation, 2);
});

// ---------------- settings / options ----------------

test('injected faults never fire inside the verification scan unless configured', () => {
  const { app, tick } = harness();
  const build = completeBuild(app, tick, {
    sourceVersion: 3,
    ruleVersion: 3,
    options: { ...FAST, failures: [{ partition: 8, stage: 'build', mode: 'once', at: 0.3 }] },
  });
  if (build.status === 'failed') {
    app.retryPartition(build.id, 8);
    for (let i = 0; i < 200; i += 1) {
      tick(100);
      if (app.state().builds.find((b) => b.id === build.id).complete) break;
    }
  }
  assert.equal(app.state().builds.find((b) => b.id === build.id).status, 'complete');
});

test('each partition only writes its own 30-day output window', () => {
  const rule = ruleToScan({ windowDays: 60, feeBps: 290, includeContested: false });
  const totals = partitionDefs().reduce((acc, def) => {
    const agg = computePartitionFull(def.no, 1, rule);
    return acc + agg.orderCount;
  }, 0);
  assert.equal(totals, DATA.ordersTotal, 'partitions exactly cover all orders with no duplication');
});

test('unknown source or rule versions are rejected', () => {
  const { app } = harness();
  assert.throws(() => app.createBuild({ sourceVersion: 99, ruleVersion: 1 }), /未知源版本/);
  assert.throws(() => app.createBuild({ sourceVersion: 1, ruleVersion: 99 }), /未知规则版本/);
});
