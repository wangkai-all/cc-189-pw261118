import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { App } from './app.js';
import { listRules, readSettings, writeSetting } from './support.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw httpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, '请求体不是合法 JSON');
  }
}

function httpError(status, message, extra = {}) {
  const error = new Error(message);
  error.statusCode = status;
  Object.assign(error, extra);
  return error;
}

function parseRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  return parts;
}

export function createServer({ dbPath = process.env.DB_PATH || join(ROOT, '.data', 'console.db'), clock = Date.now } = {}) {
  const db = openDb(dbPath);
  const app = new App(db, { clock });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      await route(req, res, url);
    } catch (error) {
      const status = Number(error.statusCode) || 500;
      if (status >= 500) console.error(error);
      json(res, status, {
        error: error.message || '内部错误',
        ...(error.readers ? { readers: error.readers } : {}),
      });
    }
  });

  async function route(req, res, url) {
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '/index.html') {
      return serveStatic(res, join(PUBLIC, 'index.html'));
    }
    if (pathname.startsWith('/api/')) {
      const parts = parseRoute(pathname).slice(1); // drop 'api'
      return api(req, res, parts, url);
    }
    return serveStatic(res, join(PUBLIC, pathname));
  }

  async function serveStatic(res, filePath) {
    const normal = normalize(filePath);
    if (!normal.startsWith(PUBLIC)) return json(res, 404, { error: '未找到' });
    try {
      const body = await readFile(normal);
      res.writeHead(200, {
        'content-type': MIME[extname(normal)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(body);
    } catch {
      json(res, 404, { error: '未找到' });
    }
  }

  async function api(req, res, parts, url) {
    const method = req.method || 'GET';
    const name = parts[0];

    if (name === 'state' && method === 'GET') {
      return json(res, 200, app.state());
    }

    if (name === 'meta' && method === 'GET') {
      const settings = readSettings(db);
      return json(res, 200, {
        rules: listRules(db),
        settings,
        defaults: {
          partitionMs: settings.partitionMs,
          verifyMs: settings.verifyMs,
          concurrency: settings.concurrency,
        },
      });
    }

    if (name === 'settings' && method === 'POST') {
      const body = await readBody(req);
      if (body.tableName !== undefined) throw httpError(400, '当前演示固定为一张表');
      if (body.defaultPartitionMs !== undefined) {
        const n = Number(body.defaultPartitionMs);
        if (!Number.isFinite(n) || n < 400 || n > 120000) throw httpError(400, '分区构建耗时需在 400–120000ms');
        writeSetting(db, 'default_partition_ms', Math.round(n));
      }
      if (body.defaultVerifyMs !== undefined) {
        const n = Number(body.defaultVerifyMs);
        if (!Number.isFinite(n) || n < 200 || n > 120000) throw httpError(400, '复核耗时需在 200–120000ms');
        writeSetting(db, 'default_verify_ms', Math.round(n));
      }
      if (body.defaultConcurrency !== undefined) {
        const n = Number(body.defaultConcurrency);
        if (!Number.isInteger(n) || n < 1 || n > 12) throw httpError(400, '并发需在 1–12');
        writeSetting(db, 'default_concurrency', n);
      }
      return json(res, 200, { settings: readSettings(db) });
    }

    if (name === 'builds' && parts[1] === undefined && method === 'POST') {
      const body = await readBody(req);
      const build = app.createBuild(body);
      return json(res, 201, { build });
    }

    if (name === 'builds' && parts[1] === undefined && method === 'GET') {
      return json(res, 200, { builds: app.state().builds });
    }

    if (name === 'builds' && parts[1] !== undefined) {
      const buildId = Number(parts[1]);
      if (!Number.isInteger(buildId)) throw httpError(400, '构建 id 无效');
      const action = parts[2];
      if (!action && method === 'GET') {
        const build = app.findBuild(buildId);
        if (!build) throw httpError(404, '构建不存在');
        return json(res, 200, {
          build: app.serializeBuild(build, {
            now: app.clock(),
            pointer: db.prepare('SELECT * FROM read_pointer WHERE table_name = ?').get(app.tableName()),
            latest: app.state().latestGeneration,
          }),
        });
      }
      if (method === 'POST') {
        if (action === 'pause') return json(res, 200, { build: app.pauseBuild(buildId) });
        if (action === 'resume') return json(res, 200, { build: app.resumeBuild(buildId) });
        if (action === 'partitions' && parts[3] !== undefined) {
          const no = Number(parts[3]);
          const sub = parts[4];
          if (sub === 'pause') return json(res, 200, { build: app.pausePartition(buildId, no) });
          if (sub === 'resume') return json(res, 200, { build: app.resumePartition(buildId, no) });
          if (sub === 'retry') return json(res, 200, { build: app.retryPartition(buildId, no) });
          throw httpError(404, `未知分区操作 ${sub}`);
        }
      }
      throw httpError(404, '未知构建操作');
    }

    if (name === 'leases' && method === 'POST') {
      const body = await readBody(req);
      const lease = app.acquireLease(body);
      return json(res, 201, lease);
    }

    if (name === 'leases' && parts[1] !== undefined && method === 'DELETE') {
      return json(res, 200, app.releaseLease(parts[1]));
    }

    if (name === 'generations' && parts[1] !== undefined && parts[2] === 'reclaim' && method === 'POST') {
      return json(res, 200, app.reclaimGeneration(parts[1]));
    }

    throw httpError(404, `未知接口 ${method} ${url.pathname}`);
  }

  return {
    server,
    app,
    db,
    async close() {
      app.close();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT) || 4173;
  const handle = createServer();
  handle.server.listen(port, () => {
    console.log(`derived-table console listening on http://localhost:${port}`);
  });
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
