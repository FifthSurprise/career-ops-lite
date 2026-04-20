import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname, resolve } from 'path';
import yaml from 'js-yaml';
import {
  eq, and, or, sql, gte, lte, asc, desc,
  max, count, avg, sum, isNotNull,
} from 'drizzle-orm';
import { openDrizzle } from './drizzle.mjs';
import { applications, pipelineEntries, llmContent, scanHistory, jdCache, cvChunks } from './schema.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const DB_PATH = join(ROOT, 'db', 'career-ops.db');
const STATES_PATH = join(ROOT, 'templates', 'states.yml');

// ── T005: Connection ─────────────────────────────────────────────────────────

export function openDb(dbPath = DB_PATH) {
  return openDrizzle(dbPath);
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

CREATE TABLE IF NOT EXISTS jd_cache (
  url        TEXT NOT NULL PRIMARY KEY,
  title      TEXT,
  company    TEXT,
  body_md    TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cv_chunks (
  id         INTEGER PRIMARY KEY,
  section    TEXT NOT NULL,
  text       TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'cv',
  created_at TEXT NOT NULL,
  UNIQUE(section, source)
);
CREATE INDEX IF NOT EXISTS idx_cv_chunks_source ON cv_chunks(source);
`;

export function initSchema(db) {
  db.$client.exec(DDL);
  return ['applications', 'pipeline_entries', 'llm_content', 'scan_history', 'jd_cache', 'cv_chunks'];
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
  return db.select().from(applications).where(eq(applications.id, id)).get() ?? null;
}

export function getApplicationByNum(db, num) {
  return db.select().from(applications).where(eq(applications.num, num)).get() ?? null;
}

export function listApplications(db, filters = {}) {
  const { status, statusIn, company, role, scoreMin, scoreMax, days, cycleId, limit, offset } = filters;
  const conditions = [];

  if (status) {
    conditions.push(sql`LOWER(${applications.status}) = LOWER(${status})`);
  }
  if (statusIn?.length) {
    conditions.push(or(...statusIn.map(s => sql`LOWER(${applications.status}) = LOWER(${s})`)));
  }
  if (company) {
    conditions.push(sql`LOWER(${applications.company}) LIKE ${'%' + company.toLowerCase() + '%'}`);
  }
  if (role) {
    conditions.push(sql`LOWER(${applications.role}) LIKE ${'%' + role.toLowerCase() + '%'}`);
  }
  if (scoreMin != null) conditions.push(gte(applications.score, scoreMin));
  if (scoreMax != null) conditions.push(lte(applications.score, scoreMax));
  if (days != null) {
    conditions.push(sql`${applications.date} >= date('now', ${'-' + days + ' days'})`);
  }
  if (cycleId != null) conditions.push(eq(applications.cycle_id, cycleId));

  let q = db.select().from(applications);
  if (conditions.length) q = q.where(and(...conditions));
  q = q.orderBy(asc(applications.num));
  if (limit != null) q = q.limit(limit);
  if (offset != null) q = q.offset(offset);

  return q.all().map(row => {
    if (row.report_path) {
      const candidate = resolve(ROOT, row.report_path);
      if (!existsSync(candidate)) row.report_path = null;
    }
    return row;
  });
}

// ── T009: Application write helpers ──────────────────────────────────────────

export function insertApplication(db, data) {
  return insertApplications(db, [data])[0];
}

export function insertApplications(db, dataList) {
  try {
    return db.transaction((tx) => {
      let row = tx.select({ max: max(applications.num) }).from(applications).get();
      let currentNum = (row?.max ?? 0) + 1;
      const results = [];
      
      for (const data of dataList) {
        validateStatus(data.status);
        const result = tx.insert(applications).values({
          num: currentNum,
          date: data.date ?? new Date().toISOString().slice(0, 10),
          company: data.company,
          role: data.role,
          cycle_id: data.cycle_id ?? 1,
          status: data.status,
          score: data.score ?? null,
          pdf: data.pdf ? 1 : 0,
          report_path: data.report_path ?? null,
          url: data.url ?? null,
          legitimacy: data.legitimacy ?? null,
          notes: data.notes ?? null,
        }).run();
        results.push({ id: Number(result.lastInsertRowid), num: currentNum });
        currentNum++;
      }
      return results;
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw Object.assign(
        new Error(`Application already exists. Use a different cycle_id to re-apply.`),
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
  const result = db.update(applications).set({ [field]: value }).where(eq(applications.id, id)).run();
  if (result.changes === 0) throw Object.assign(new Error(`Application ${id} not found`), { code: 'NOT_FOUND' });
}

export function deleteApplication(db, id) {
  db.transaction((tx) => {
    deleteLlmContentForOwner(tx, 'application', id);
    tx.delete(applications).where(eq(applications.id, id)).run();
  });
}

// ── T010: Pipeline read/write helpers ────────────────────────────────────────

export function getPipelineEntryById(db, id) {
  return db.select().from(pipelineEntries).where(eq(pipelineEntries.id, id)).get() ?? null;
}

export function getPipelineEntryByUrl(db, url) {
  return db.select().from(pipelineEntries).where(eq(pipelineEntries.url, url)).get() ?? null;
}

export function listPipeline(db, filters = {}) {
  const { state, company, days } = filters;
  const conditions = [];

  if (state) conditions.push(eq(pipelineEntries.state, state));
  if (company) {
    conditions.push(sql`LOWER(${pipelineEntries.company}) LIKE ${'%' + company.toLowerCase() + '%'}`);
  }
  if (days != null) {
    conditions.push(sql`${pipelineEntries.discovered_at} >= date('now', ${'-' + days + ' days'})`);
  }

  let q = db.select().from(pipelineEntries);
  if (conditions.length) q = q.where(and(...conditions));
  return q.orderBy(asc(pipelineEntries.id)).all();
}

export function insertPipelineEntry(db, data) {
  return insertPipelineEntries(db, [data])[0];
}

export function insertPipelineEntries(db, dataList) {
  try {
    return db.transaction((tx) => {
      const results = [];
      for (const data of dataList) {
        const result = tx.insert(pipelineEntries).values({
      url: data.url,
      source: data.source ?? null,
      state: data.state ?? 'pending',
      title: data.title ?? null,
      company: data.company ?? null,
      local_jd: data.local_jd ?? null,
      discovered_at: data.discovered_at ?? new Date().toISOString().slice(0, 10),
          application_id: data.application_id ?? null,
        }).run();
        results.push({ id: Number(result.lastInsertRowid) });
      }
      return results;
    });
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
  const result = db.update(pipelineEntries).set({ [field]: value }).where(eq(pipelineEntries.id, id)).run();
  if (result.changes === 0) throw Object.assign(new Error(`Pipeline entry ${id} not found`), { code: 'NOT_FOUND' });
}

export function deletePipelineEntry(db, id) {
  db.transaction((tx) => {
    deleteLlmContentForOwner(tx, 'pipeline_entry', id);
    tx.delete(pipelineEntries).where(eq(pipelineEntries.id, id)).run();
  });
}

// ── T011: Scan history helpers ────────────────────────────────────────────────

export function upsertScanHistory(db, entry) {
  const now = new Date().toISOString().slice(0, 10);
  db.insert(scanHistory).values({
    url: entry.url,
    first_seen: entry.first_seen ?? now,
    portal: entry.portal ?? null,
    title: entry.title ?? null,
    company: entry.company ?? null,
    status: entry.status ?? 'added',
  }).onConflictDoUpdate({
    target: scanHistory.url,
    set: {
      first_seen: sql`excluded.first_seen`,
      portal: sql`excluded.portal`,
      title: sql`excluded.title`,
      company: sql`excluded.company`,
      status: sql`excluded.status`,
    },
  }).run();
}

export function isUrlSeen(db, url) {
  const inHistory = db.select({ v: sql`1` }).from(scanHistory).where(eq(scanHistory.url, url)).get();
  if (inHistory) return true;
  const inPipeline = db.select({ v: sql`1` }).from(pipelineEntries).where(eq(pipelineEntries.url, url)).get();
  return !!inPipeline;
}

export function isCompanyRoleSeen(db, company, role) {
  return !!db.select({ v: sql`1` }).from(applications).where(
    and(
      sql`LOWER(${applications.company}) = LOWER(${company})`,
      sql`LOWER(${applications.role}) = LOWER(${role})`
    )
  ).get();
}

// ── T025: Dedup helper ────────────────────────────────────────────────────────

export function isDuplicate(db, { url, company, role }) {
  if (url) {
    if (db.select({ v: sql`1` }).from(scanHistory).where(eq(scanHistory.url, url)).get()) {
      return { found: true, source: 'scan_history' };
    }
    if (db.select({ v: sql`1` }).from(pipelineEntries).where(eq(pipelineEntries.url, url)).get()) {
      return { found: true, source: 'pipeline' };
    }
  }
  if (company && role) {
    if (db.select({ v: sql`1` }).from(applications).where(
      and(
        sql`LOWER(${applications.company}) = LOWER(${company})`,
        sql`LOWER(${applications.role}) = LOWER(${role})`
      )
    ).get()) {
      return { found: true, source: 'application' };
    }
  }
  return { found: false, source: null };
}

// ── T036: LLM content CRUD ───────────────────────────────────────────────────

const LLM_BODY_MAX = 65536;

export function getLlmContent(db, ownerType, ownerId, tag) {
  return db.select().from(llmContent).where(
    and(
      eq(llmContent.owner_type, ownerType),
      eq(llmContent.owner_id, ownerId),
      eq(llmContent.tag, tag)
    )
  ).get() ?? null;
}

export function listLlmContent(db, ownerType, ownerId) {
  return db.select({
    id: llmContent.id,
    owner_type: llmContent.owner_type,
    owner_id: llmContent.owner_id,
    tag: llmContent.tag,
    created_at: llmContent.created_at,
    body_preview: sql`SUBSTR(${llmContent.body}, 1, 100)`,
  }).from(llmContent).where(
    and(eq(llmContent.owner_type, ownerType), eq(llmContent.owner_id, ownerId))
  ).orderBy(asc(llmContent.id)).all();
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
  db.insert(llmContent).values({
    owner_type: ownerType,
    owner_id: ownerId,
    tag,
    body,
    created_at: now,
  }).onConflictDoUpdate({
    target: [llmContent.owner_type, llmContent.owner_id, llmContent.tag],
    set: { body, created_at: now },
  }).run();
  const row = getLlmContent(db, ownerType, ownerId, tag);
  return { id: row.id, action: existing ? 'updated' : 'created' };
}

export function deleteLlmContent(db, ownerType, ownerId, tag) {
  const result = db.delete(llmContent).where(
    and(
      eq(llmContent.owner_type, ownerType),
      eq(llmContent.owner_id, ownerId),
      eq(llmContent.tag, tag)
    )
  ).run();
  return result.changes > 0;
}

export function deleteLlmContentForOwner(db, ownerType, ownerId) {
  db.delete(llmContent).where(
    and(eq(llmContent.owner_type, ownerType), eq(llmContent.owner_id, ownerId))
  ).run();
}

// ── Next num / repost / slug helpers ─────────────────────────────────────────

export function nextApplicationNum(db) {
  const row = db.select({ max: max(applications.num) }).from(applications).get();
  return (row?.max ?? 0) + 1;
}

export function repostCheck(db, { company, role }) {
  const history = db.select({
    url: scanHistory.url,
    first_seen: scanHistory.first_seen,
    title: scanHistory.title,
  }).from(scanHistory).where(
    sql`LOWER(${scanHistory.company}) = LOWER(${company ?? ''})`
  ).orderBy(asc(scanHistory.first_seen)).all();

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

// ── JD cache helpers ──────────────────────────────────────────────────────────

export function getJdCache(db, url) {
  return db.select().from(jdCache).where(eq(jdCache.url, url)).get() ?? null;
}

export function setJdCache(db, { url, title, company, body_md }) {
  const now = new Date().toISOString();
  db.insert(jdCache).values({
    url,
    title: title ?? null,
    company: company ?? null,
    body_md,
    fetched_at: now,
  }).onConflictDoUpdate({
    target: jdCache.url,
    set: {
      title: sql`excluded.title`,
      company: sql`excluded.company`,
      body_md: sql`excluded.body_md`,
      fetched_at: sql`excluded.fetched_at`,
    },
  }).run();
}

export function pruneJdCache(db, days = 90) {
  const result = db.delete(jdCache).where(
    sql`${jdCache.fetched_at} < datetime('now', ${'-' + days + ' days'})`
  ).run();
  return result.changes;
}

// ── CV chunks helpers ─────────────────────────────────────────────────────────

export function listCvChunks(db, tags = [], limit = 20) {
  if (!tags.length) {
    return db.select().from(cvChunks).orderBy(asc(cvChunks.id)).limit(limit).all();
  }
  const conditions = tags.map(t =>
    sql`(LOWER(${cvChunks.tags}) LIKE ${'%' + t.toLowerCase() + '%'} OR LOWER(${cvChunks.section}) LIKE ${'%' + t.toLowerCase() + '%'})`
  );
  return db.select().from(cvChunks)
    .where(or(...conditions))
    .orderBy(asc(cvChunks.id))
    .limit(limit)
    .all();
}

export function insertCvChunk(db, { section, text, tags, source }) {
  const now = new Date().toISOString();
  db.insert(cvChunks).values({ section, text, tags: tags ?? '', source: source ?? 'cv', created_at: now }).run();
}

export function clearCvChunks(db, source) {
  const result = db.delete(cvChunks).where(eq(cvChunks.source, source)).run();
  return result.changes;
}
