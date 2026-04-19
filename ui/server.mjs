#!/usr/bin/env node
/**
 * ui/server.mjs — Browser UI for career-ops SQLite + markdown reports
 * Run: node ui/server.mjs [port]
 */

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve, normalize } from 'path';
import { fileURLToPath } from 'url';
import { openDb, initSchema, listApplications, listPipeline, updateApplication, updatePipelineEntry } from '../lib/db.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const PORT = parseInt(process.argv[2] ?? process.env.PORT ?? '4242');

const db = openDb();
initSchema(db);

// ── Route helpers ─────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function notFound(res, msg = 'Not found') {
  json(res, { error: msg }, 404);
}

function parseQS(url) {
  const u = new URL(url, 'http://localhost');
  const out = {};
  for (const [k, v] of u.searchParams) {
    if (out[k]) {
      if (Array.isArray(out[k])) out[k].push(v);
      else out[k] = [out[k], v];
    } else {
      out[k] = v;
    }
  }
  return { pathname: u.pathname, params: out };
}

// ── API handlers ──────────────────────────────────────────────────────────────

function handleStats(res) {
  const byStatus = db.prepare(`
    SELECT status, COUNT(*) AS count, ROUND(AVG(score),2) AS avg_score
    FROM applications GROUP BY status ORDER BY count DESC
  `).all();

  const totals = db.prepare(`
    SELECT COUNT(*) AS total, ROUND(AVG(score),2) AS avg_score,
           SUM(pdf) AS with_pdf, COUNT(report_path) AS with_report
    FROM applications WHERE score IS NOT NULL
  `).get();

  const pipeline = db.prepare(`
    SELECT state, COUNT(*) AS count FROM pipeline_entries GROUP BY state
  `).all();

  const scanCount = db.prepare('SELECT COUNT(*) AS count FROM scan_history').get();

  json(res, { byStatus, totals, pipeline, scanCount: scanCount.count });
}

function handleApplications(res, params) {
  const filters = {};
  if (params.status) filters.status = params.status;
  if (params.statusIn) {
    const statuses = Array.isArray(params.statusIn) ? params.statusIn : [params.statusIn];
    filters.statusIn = statuses;
  }
  if (params.scoreMin) filters.scoreMin = parseFloat(params.scoreMin);
  if (params.scoreMax) filters.scoreMax = parseFloat(params.scoreMax);
  if (params.company) filters.company = params.company;
  if (params.role) filters.role = params.role;
  if (params.limit) filters.limit = parseInt(params.limit);
  if (params.offset) filters.offset = parseInt(params.offset);

  const rows = listApplications(db, filters);
  json(res, rows);
}

function handleApplication(res, id) {
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(parseInt(id));
  if (!row) return notFound(res, `Application ${id} not found`);
  json(res, row);
}

function handlePipeline(res, params) {
  const filters = {};
  if (params.state) filters.state = params.state;
  if (params.company) filters.company = params.company;
  json(res, listPipeline(db, filters));
}

function handleReport(res, params) {
  if (!params.path) return notFound(res, 'path param required');

  // Prevent path traversal — only allow paths inside ROOT
  const candidate = resolve(ROOT, params.path);
  if (!candidate.startsWith(ROOT + '/')) return json(res, { error: 'Forbidden' }, 403);
  if (!existsSync(candidate)) return notFound(res, 'Report not found');

  const content = readFileSync(candidate, 'utf-8');
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(content);
}

function handleStatuses(res) {
  const rows = db.prepare('SELECT DISTINCT status FROM applications ORDER BY status').all();
  json(res, rows.map(r => r.status));
}

function readBody(req, callback) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const data = body ? JSON.parse(body) : {};
      callback(null, data);
    } catch (e) {
      callback(e);
    }
  });
}

function handleUpdateApplicationStatus(res, id, body) {
  try {
    if (!body.status) return json(res, { error: 'status required' }, 400);
    updateApplication(db, parseInt(id), 'status', body.status);
    json(res, { success: true });
  } catch (err) {
    json(res, { error: err.message }, 400);
  }
}

function handleUpdatePipelineState(res, id, body) {
  try {
    if (!body.state) return json(res, { error: 'state required' }, 400);
    updatePipelineEntry(db, parseInt(id), 'state', body.state);
    json(res, { success: true });
  } catch (err) {
    json(res, { error: err.message }, 400);
  }
}

// ── Static files ──────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
};

function serveStatic(res, filePath) {
  const full = join(__dir, 'public', filePath);
  const safe = resolve(full);
  if (!safe.startsWith(join(__dir, 'public'))) return json(res, { error: 'Forbidden' }, 403);
  if (!existsSync(safe)) return notFound(res);
  const ext = safe.slice(safe.lastIndexOf('.'));
  const content = readFileSync(safe);
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  res.end(content);
}

// ── Router ────────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const { pathname, params } = parseQS(req.url);

  if (pathname === '/' || pathname === '/index.html') {
    return serveStatic(res, 'index.html');
  }

  const appMatch = pathname.match(/^\/api\/applications\/(\d+)$/);
  if (appMatch) return handleApplication(res, appMatch[1]);

  const appStatusMatch = pathname.match(/^\/api\/applications\/(\d+)\/status$/);
  if (appStatusMatch && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return json(res, { error: 'Invalid JSON' }, 400);
      handleUpdateApplicationStatus(res, appStatusMatch[1], body);
    });
  }

  const pipelineStateMatch = pathname.match(/^\/api\/pipeline\/(\d+)\/state$/);
  if (pipelineStateMatch && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return json(res, { error: 'Invalid JSON' }, 400);
      handleUpdatePipelineState(res, pipelineStateMatch[1], body);
    });
  }

  switch (pathname) {
    case '/api/stats':        return handleStats(res);
    case '/api/applications': return handleApplications(res, params);
    case '/api/pipeline':     return handlePipeline(res, params);
    case '/api/report':       return handleReport(res, params);
    case '/api/statuses':     return handleStatuses(res);
    default:                  return notFound(res);
  }
});

server.listen(PORT, () => {
  console.log(`career-ops UI → http://localhost:${PORT}`);
});
