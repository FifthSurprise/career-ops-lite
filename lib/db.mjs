import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import yaml from 'js-yaml';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const DB_PATH = join(ROOT, 'db', 'career-ops.db');
const STATES_PATH = join(ROOT, 'templates', 'states.yml');

// ── T005: Connection ─────────────────────────────────────────────────────────

export function openDb(dbPath = DB_PATH) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

// ── T006: Schema ─────────────────────────────────────────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS applications (
  id           INTEGER PRIMARY KEY,
  num          INTEGER NOT NULL,
  date         TEXT    NOT NULL,
  company      TEXT    NOT NULL,
  role         TEXT    NOT NULL,
  cycle_id     INTEGER NOT NULL DEFAULT 1,
  status       TEXT    NOT NULL,
  score        REAL,
  pdf          INTEGER NOT NULL DEFAULT 0,
  report_path  TEXT,
  url          TEXT,
  legitimacy   TEXT,
  notes        TEXT,
  UNIQUE(company, role, cycle_id)
);
CREATE INDEX IF NOT EXISTS idx_applications_status  ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_date    ON applications(date);
CREATE INDEX IF NOT EXISTS idx_applications_company ON applications(company);
CREATE INDEX IF NOT EXISTS idx_applications_num     ON applications(num);

CREATE TABLE IF NOT EXISTS pipeline_entries (
  id             INTEGER PRIMARY KEY,
  url            TEXT    NOT NULL UNIQUE,
  source         TEXT,
  state          TEXT    NOT NULL DEFAULT 'pending',
  title          TEXT,
  company        TEXT,
  local_jd       TEXT,
  discovered_at  TEXT    NOT NULL,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pipeline_state   ON pipeline_entries(state);
CREATE INDEX IF NOT EXISTS idx_pipeline_company ON pipeline_entries(company);

CREATE TABLE IF NOT EXISTS llm_content (
  id          INTEGER PRIMARY KEY,
  owner_type  TEXT    NOT NULL CHECK(owner_type IN ('application', 'pipeline_entry')),
  owner_id    INTEGER NOT NULL,
  tag         TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  UNIQUE(owner_type, owner_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_llm_content_owner ON llm_content(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS scan_history (
  url        TEXT NOT NULL PRIMARY KEY,
  first_seen TEXT NOT NULL,
  portal     TEXT,
  title      TEXT,
  company    TEXT,
  status     TEXT NOT NULL DEFAULT 'added'
);
`;

export function initSchema(db) {
  db.exec(DDL);
  return ['applications', 'pipeline_entries', 'llm_content', 'scan_history'];
}

// ── T007: Status validation ──────────────────────────────────────────────────

let _canonicalStatuses = null;

function loadCanonicalStatuses() {
  if (_canonicalStatuses) return _canonicalStatuses;
  const raw = yaml.load(readFileSync(STATES_PATH, 'utf8'));
  _canonicalStatuses = new Set(raw.states.map(s => s.label.toLowerCase()));
  return _canonicalStatuses;
}

export function validateStatus(s) {
  const statuses = loadCanonicalStatuses();
  if (!statuses.has(s.toLowerCase())) {
    const valid = [...statuses].join(', ');
    throw Object.assign(new Error(`Invalid status "${s}". Valid values: ${valid}`), {
      code: 'INVALID_STATUS',
    });
  }
}

// ── T008: Application read helpers ───────────────────────────────────────────

export function getApplicationById(db, id) {
  return db.prepare('SELECT * FROM applications WHERE id = ?').get(id) ?? null;
}

export function getApplicationByNum(db, num) {
  return db.prepare('SELECT * FROM applications WHERE num = ?').get(num) ?? null;
}

export function listApplications(db, filters = {}) {
  const { status, statusIn, company, role, scoreMin, scoreMax, days, cycleId, limit, offset } = filters;
  const where = [];
  const params = [];

  if (status) {
    where.push('LOWER(status) = LOWER(?)');
    params.push(status);
  }
  if (statusIn && statusIn.length) {
    where.push(`LOWER(status) IN (${statusIn.map(() => 'LOWER(?)').join(',')})`);
    params.push(...statusIn);
  }
  if (company) {
    where.push('LOWER(company) LIKE LOWER(?)');
    params.push(`%${company}%`);
  }
  if (role) {
    where.push('LOWER(role) LIKE LOWER(?)');
    params.push(`%${role}%`);
  }
  if (scoreMin != null) {
    where.push('score >= ?');
    params.push(scoreMin);
  }
  if (scoreMax != null) {
    where.push('score <= ?');
    params.push(scoreMax);
  }
  if (days != null) {
    where.push("date >= date('now', ? || ' days')");
    params.push(`-${days}`);
  }
  if (cycleId != null) {
    where.push('cycle_id = ?');
    params.push(cycleId);
  }

  let sql = 'SELECT * FROM applications';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY num ASC';
  if (limit != null) { sql += ' LIMIT ?'; params.push(limit); }
  if (offset != null) { sql += ' OFFSET ?'; params.push(offset); }

  return db.prepare(sql).all(...params);
}

// ── T009: Application write helpers ──────────────────────────────────────────

export function insertApplication(db, data) {
  validateStatus(data.status);
  const insert = db.transaction((d) => {
    const row = db.prepare('SELECT MAX(num) AS max FROM applications').get();
    const num = (row.max ?? 0) + 1;
    const result = db.prepare(`
      INSERT INTO applications (num, date, company, role, cycle_id, status, score, pdf, report_path, url, legitimacy, notes)
      VALUES (@num, @date, @company, @role, @cycle_id, @status, @score, @pdf, @report_path, @url, @legitimacy, @notes)
    `).run({
      num,
      date: d.date ?? new Date().toISOString().slice(0, 10),
      company: d.company,
      role: d.role,
      cycle_id: d.cycle_id ?? 1,
      status: d.status,
      score: d.score ?? null,
      pdf: d.pdf ? 1 : 0,
      report_path: d.report_path ?? null,
      url: d.url ?? null,
      legitimacy: d.legitimacy ?? null,
      notes: d.notes ?? null,
    });
    return { id: result.lastInsertRowid, num };
  });

  try {
    return insert(data);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const cycleId = data.cycle_id ?? 1;
      throw Object.assign(
        new Error(`Application for ${data.company} + ${data.role} (cycle ${cycleId}) already exists. Use a different cycle_id to re-apply.`),
        { code: 'DUPLICATE' }
      );
    }
    throw err;
  }
}

export function updateApplication(db, id, field, value) {
  if (field === 'status') validateStatus(value);
  const allowed = ['date', 'company', 'role', 'cycle_id', 'status', 'score', 'pdf', 'report_path', 'url', 'legitimacy', 'notes'];
  if (!allowed.includes(field)) {
    throw Object.assign(new Error(`Unknown field "${field}"`), { code: 'UNKNOWN_FIELD' });
  }
  const result = db.prepare(`UPDATE applications SET ${field} = ? WHERE id = ?`).run(value, id);
  if (result.changes === 0) throw Object.assign(new Error(`Application ${id} not found`), { code: 'NOT_FOUND' });
}

export function deleteApplication(db, id) {
  db.transaction(() => {
    deleteLlmContentForOwner(db, 'application', id);
    db.prepare('DELETE FROM applications WHERE id = ?').run(id);
  })();
}

// ── T010: Pipeline read/write helpers ────────────────────────────────────────

export function getPipelineEntryById(db, id) {
  return db.prepare('SELECT * FROM pipeline_entries WHERE id = ?').get(id) ?? null;
}

export function getPipelineEntryByUrl(db, url) {
  return db.prepare('SELECT * FROM pipeline_entries WHERE url = ?').get(url) ?? null;
}

export function listPipeline(db, filters = {}) {
  const { state, company, days } = filters;
  const where = [];
  const params = [];

  if (state) {
    where.push('state = ?');
    params.push(state);
  }
  if (company) {
    where.push('LOWER(company) LIKE LOWER(?)');
    params.push(`%${company}%`);
  }
  if (days != null) {
    where.push("discovered_at >= date('now', ? || ' days')");
    params.push(`-${days}`);
  }

  let sql = 'SELECT * FROM pipeline_entries';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id ASC';

  return db.prepare(sql).all(...params);
}

export function insertPipelineEntry(db, data) {
  try {
    const result = db.prepare(`
      INSERT INTO pipeline_entries (url, source, state, title, company, local_jd, discovered_at, application_id)
      VALUES (@url, @source, @state, @title, @company, @local_jd, @discovered_at, @application_id)
    `).run({
      url: data.url,
      source: data.source ?? null,
      state: data.state ?? 'pending',
      title: data.title ?? null,
      company: data.company ?? null,
      local_jd: data.local_jd ?? null,
      discovered_at: data.discovered_at ?? new Date().toISOString().slice(0, 10),
      application_id: data.application_id ?? null,
    });
    return { id: result.lastInsertRowid };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw Object.assign(
        new Error(`Pipeline entry for URL "${data.url}" already exists.`),
        { code: 'DUPLICATE' }
      );
    }
    throw err;
  }
}

export function updatePipelineEntry(db, id, field, value) {
  const allowed = ['url', 'source', 'state', 'title', 'company', 'local_jd', 'discovered_at', 'application_id'];
  if (!allowed.includes(field)) {
    throw Object.assign(new Error(`Unknown field "${field}"`), { code: 'UNKNOWN_FIELD' });
  }
  const result = db.prepare(`UPDATE pipeline_entries SET ${field} = ? WHERE id = ?`).run(value, id);
  if (result.changes === 0) throw Object.assign(new Error(`Pipeline entry ${id} not found`), { code: 'NOT_FOUND' });
}

export function deletePipelineEntry(db, id) {
  db.transaction(() => {
    deleteLlmContentForOwner(db, 'pipeline_entry', id);
    db.prepare('DELETE FROM pipeline_entries WHERE id = ?').run(id);
  })();
}

// ── T011: Scan history helpers ────────────────────────────────────────────────

export function upsertScanHistory(db, entry) {
  db.prepare(`
    INSERT OR REPLACE INTO scan_history (url, first_seen, portal, title, company, status)
    VALUES (@url, @first_seen, @portal, @title, @company, @status)
  `).run({
    url: entry.url,
    first_seen: entry.first_seen ?? new Date().toISOString().slice(0, 10),
    portal: entry.portal ?? null,
    title: entry.title ?? null,
    company: entry.company ?? null,
    status: entry.status ?? 'added',
  });
}

export function isUrlSeen(db, url) {
  const inHistory = db.prepare('SELECT 1 FROM scan_history WHERE url = ?').get(url);
  if (inHistory) return true;
  const inPipeline = db.prepare('SELECT 1 FROM pipeline_entries WHERE url = ?').get(url);
  return !!inPipeline;
}

export function isCompanyRoleSeen(db, company, role) {
  const row = db.prepare(
    'SELECT 1 FROM applications WHERE LOWER(company) = LOWER(?) AND LOWER(role) = LOWER(?)'
  ).get(company, role);
  return !!row;
}

// ── T025: Dedup helper ────────────────────────────────────────────────────────

export function isDuplicate(db, { url, company, role }) {
  if (url) {
    const inHistory = db.prepare('SELECT 1 FROM scan_history WHERE url = ?').get(url);
    if (inHistory) return { found: true, source: 'scan_history' };
    const inPipeline = db.prepare('SELECT 1 FROM pipeline_entries WHERE url = ?').get(url);
    if (inPipeline) return { found: true, source: 'pipeline' };
  }
  if (company && role) {
    const inApps = db.prepare(
      'SELECT 1 FROM applications WHERE LOWER(company) = LOWER(?) AND LOWER(role) = LOWER(?)'
    ).get(company, role);
    if (inApps) return { found: true, source: 'application' };
  }
  return { found: false, source: null };
}

// ── T036: LLM content CRUD ───────────────────────────────────────────────────

const LLM_BODY_MAX = 65536;

export function getLlmContent(db, ownerType, ownerId, tag) {
  return db.prepare(
    'SELECT * FROM llm_content WHERE owner_type = ? AND owner_id = ? AND tag = ?'
  ).get(ownerType, ownerId, tag) ?? null;
}

export function listLlmContent(db, ownerType, ownerId) {
  return db.prepare(
    'SELECT id, owner_type, owner_id, tag, created_at, SUBSTR(body, 1, 100) AS body_preview FROM llm_content WHERE owner_type = ? AND owner_id = ? ORDER BY id'
  ).all(ownerType, ownerId);
}

export function setLlmContent(db, ownerType, ownerId, tag, body) {
  if (body.length > LLM_BODY_MAX) {
    throw Object.assign(
      new Error(`Body exceeds 64 KB limit (${body.length} bytes)`),
      { code: 'BODY_TOO_LARGE' }
    );
  }
  const existing = getLlmContent(db, ownerType, ownerId, tag);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO llm_content (owner_type, owner_id, tag, body, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(ownerType, ownerId, tag, body, now);
  const row = getLlmContent(db, ownerType, ownerId, tag);
  return { id: row.id, action: existing ? 'updated' : 'created' };
}

export function deleteLlmContent(db, ownerType, ownerId, tag) {
  const result = db.prepare(
    'DELETE FROM llm_content WHERE owner_type = ? AND owner_id = ? AND tag = ?'
  ).run(ownerType, ownerId, tag);
  return result.changes > 0;
}

export function deleteLlmContentForOwner(db, ownerType, ownerId) {
  db.prepare('DELETE FROM llm_content WHERE owner_type = ? AND owner_id = ?').run(ownerType, ownerId);
}

// ── Next num / repost / slug helpers ─────────────────────────────────────────

export function nextApplicationNum(db) {
  const row = db.prepare('SELECT MAX(num) AS max FROM applications').get();
  return (row.max ?? 0) + 1;
}

export function repostCheck(db, { company, role }) {
  const history = db.prepare(
    'SELECT url, first_seen, title FROM scan_history WHERE LOWER(company) = LOWER(?) ORDER BY first_seen ASC'
  ).all(company ?? '');

  const roleTokens = (role ?? '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const matches = roleTokens.length
    ? history.filter(h => {
        const t = (h.title ?? '').toLowerCase();
        return roleTokens.some(tok => t.includes(tok));
      })
    : history;

  return {
    company: company ?? null,
    role: role ?? null,
    count: matches.length,
    first_seen: matches[0]?.first_seen ?? null,
    last_seen: matches[matches.length - 1]?.first_seen ?? null,
    urls: matches.map(m => ({ url: m.url, first_seen: m.first_seen, title: m.title })),
  };
}

export function slugify(text) {
  return (text ?? '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
