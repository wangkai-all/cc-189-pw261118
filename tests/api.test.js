import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';

// Route-level regression tests. The partition commands were once shadowed by
// the collection route (`POST /api/builds`), so every pause/resume/retry hit
// createBuild and failed with "未知源版本 undefined". These tests pin the URLs.

async function withServer(fn) {
  const handle = createServer({ dbPath: ':memory:' });
  await new Promise((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  const { port } = handle.server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  const raw = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
  };
  try {
    await fn(call, raw);
  } finally {
    await handle.close();
  }
}

test('POST /api/builds creates a build, and partition subroutes reach partition commands', async () => {
  await withServer(async (call) => {
    const created = await call('/api/builds', {
      method: 'POST',
      body: { sourceVersion: 2, ruleVersion: 2, options: { partitionMs: 60000, verifyMs: 60000, concurrency: 1 } },
    });
    assert.equal(created.status, 201);
    const buildId = created.data.build.id;
    assert.equal(created.data.build.generation, 2);

    // A partition subroute must not be parsed as a createBuild body.
    const paused = await call(`/api/builds/${buildId}/partitions/3/pause`, { method: 'POST' });
    assert.equal(paused.status, 200, JSON.stringify(paused.data));
    const pausedPart = paused.data.build.partitions.find((p) => p.no === 3);
    assert.equal(pausedPart.status, 'paused');

    const resumed = await call(`/api/builds/${buildId}/partitions/3/resume`, { method: 'POST' });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
    assert.equal(resumed.data.build.partitions.find((p) => p.no === 3).status !== 'paused', true);

    const retried = await call(`/api/builds/${buildId}/partitions/3/retry`, { method: 'POST' });
    assert.equal(retried.status, 409, 'a non-failed partition cannot be retried');
    assert.match(retried.data.error, /不在失败状态/);

    const badSub = await call(`/api/builds/${buildId}/partitions/3/explode`, { method: 'POST' });
    assert.equal(badSub.status, 404);
    assert.match(badSub.data.error, /未知分区操作/);

    const unknownBuild = await call('/api/builds/9999/partitions/1/pause', { method: 'POST' });
    assert.equal(unknownBuild.status, 404);
  });
});

test('POST /api/builds rejects unknown versions without creating a generation', async () => {
  await withServer(async (call) => {
    const before = await call('/api/state');
    const res = await call('/api/builds', {
      method: 'POST',
      body: { sourceVersion: 99, ruleVersion: 1 },
    });
    assert.equal(res.status, 409);
    assert.match(res.data.error, /未知源版本 99/);
    const empty = await call('/api/builds', { method: 'POST', body: {} });
    assert.equal(empty.status, 409);
    assert.match(empty.data.error, /需要同时指定/);
    const after = await call('/api/state');
    assert.equal(after.data.latestGeneration, before.data.latestGeneration);
  });
});

test('lease and reclaim routes validate their inputs', async () => {
  await withServer(async (call) => {
    const missing = await call('/api/leases', { method: 'POST', body: { generation: 99 } });
    assert.equal(missing.status, 404);
    assert.match(missing.data.error, /尚未完成/);

    const visible = await call('/api/leases', {
      method: 'POST',
      body: { readerId: 'analyst', generation: 1, ttlMs: 5000 },
    });
    assert.equal(visible.status, 201, JSON.stringify(visible.data));
    assert.ok(visible.data.value.netCents > 0);

    const blocked = await call('/api/generations/1/reclaim', { method: 'POST' });
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /当前读入口/);
  });
});

test('static assets are served and traversal outside public/ is refused', async () => {
  await withServer(async (call, raw) => {
    const index = await raw('/');
    assert.equal(index.status, 200);
    assert.match(index.text, /派生表重建控制台/);
    const css = await raw('/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.type, /text\/css/);
    const escape = await raw('/..%2fserver%2fdb.js');
    assert.equal(escape.status, 404);
  });
});
