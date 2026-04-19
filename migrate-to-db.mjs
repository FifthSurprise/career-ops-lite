#!/usr/bin/env node
/**
 * migrate-to-db.mjs — One-shot migration from markdown/TSV to SQLite
 *
 * Sources:
 *   data/applications.md   → applications table
 *   data/pipeline.md        → pipeline_entries table
 *   data/scan-history.tsv  → scan_history table
 *   batch/tracker-additions/*.tsv → applications (merge logic)
 *
 * Run:
 *   node migrate-to-db.mjs               # migrate
 *   node migrate-to-db.mjs --dry-run     # preview counts without writing
 *   node migrate-to-db.mjs --force       # re-run even if DB has data
 *   node migrate-to-db.mjs --json        # JSON summary output
 */

import { readFileSync, readdirSync, existsSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { openDb, initSchema, insertApplication, insertPipelineEntry, upsertScanHistory } from './lib/db.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APPS_FILE = join(ROOT, 'data/applications.md');
const PIPELINE_FILE = join(ROOT, 'data/pipeline.md');
const SCAN_HISTORY_FILE = join(ROOT, 'data/scan-history.tsv');
const ADDITIONS_DIR = join(ROOT, 'batch/tracker-additions');
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const JSON_OUT = process.argv.includes('--json');

mkdirSync(join(ROOT, 'data'), { recursive: true });

function log(msg) { if (!JSON_OUT) console.log(msg); }
function warn(msg) { if (!JSON_OUT) console.warn(msg); }

// ── Helpers ────────────────────────────────────────────────────────────────────

const CANONICAL_MAP = {
  'evaluada': 'Evaluated', 'condicional': 'Evaluated', 'hold': 'Evaluated', 'evaluar': 'Evaluated', 'verificar': 'Evaluated',
  'aplicado': 'Applied', 'enviada': 'Applied', 'aplicada': 'Applied', 'applied': 'Applied', 'sent': 'Applied',
  'respondido': 'Responded',
  'entrevista': 'Interview',
  'oferta': 'Offer',
  'rechazado': 'Rejected', 'rechazada': 'Rejected',
  'descartado': 'Discarded', 'descartada': 'Discarded', 'cerrada': 'Discarded', 'cancelada': 'Discarded',
  'no aplicar': 'SKIP', 'no_aplicar': 'SKIP', 'skip': 'SKIP', 'monitor': 'SKIP', 'geo blocker': 'SKIP',
};
const CANONICAL_LABELS = new Set(['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP']);

function normalizeStatus(raw) {
  const clean = (raw || '').replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  const lower = clean.toLowerCase();
  if (CANONICAL_LABELS.has(clean)) return clean;
  if (CANONICAL_MAP[lower]) return CANONICAL_MAP[lower];
  if (/^(duplicado|dup|repost)/i.test(lower)) return 'Discarded';
  return 'Evaluated';
}

function parseScore(s) {
  if (!s) return null;
  const m = s.replace(/\*\*/g, '').match(/^([\d.]+)\s*\/\s*\d/);
  return m ? parseFloat(m[1]) : null;
}

// ── T043: Parse applications.md ────────────────────────────────────────────────

function parseApplicationsMd(errors) {
  if (!existsSync(APPS_FILE)) return [];
  const lines = readFileSync(APPS_FILE, 'utf-8').split('\n');
  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 9) continue;
    const num = parseInt(parts[1]);
    if (isNaN(num) || num === 0) continue;
    // header row
    if (parts[1] === '#' || parts[2] === 'Date') continue;

    try {
      const score = parseScore(parts[5]);
      const status = normalizeStatus(parts[6]);
      const reportPath = parts[8]?.match(/\]\(([^)]+)\)/)?.[1] || null;
      rows.push({
        num,
        date: parts[2] || new Date().toISOString().slice(0, 10),
        company: parts[3],
        role: parts[4],
        score,
        status,
        pdf: parts[7]?.includes('✅') ? 1 : 0,
        report_path: reportPath,
        notes: parts[9] || null,
        cycle_id: 1,
      });
    } catch (e) {
      errors.push({ source: APPS_FILE, line: i + 1, message: e.message });
    }
  }

  return rows;
}

// ── T044: Parse pipeline.md ────────────────────────────────────────────────────

function parsePipelineMd(errors) {
  if (!existsSync(PIPELINE_FILE)) return [];
  const lines = readFileSync(PIPELINE_FILE, 'utf-8').split('\n');
  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = line.match(/^- \[([ x])\] (https?:\/\/\S+)(.*)?$/);
    if (!m) continue;

    try {
      const checked = m[1] === 'x';
      const url = m[2];
      const rest = (m[3] || '').trim();
      const parts = rest.split('|').map(s => s.trim());
      rows.push({
        url,
        state: checked ? 'evaluated' : 'pending',
        company: parts[0] || null,
        title: parts[1] || null,
        discovered_at: new Date().toISOString().slice(0, 10),
      });
    } catch (e) {
      errors.push({ source: PIPELINE_FILE, line: i + 1, message: e.message });
    }
  }

  return rows;
}

// ── T045: Parse scan-history.tsv ──────────────────────────────────────────────

function parseScanHistoryTsv(errors) {
  if (!existsSync(SCAN_HISTORY_FILE)) return [];
  const lines = readFileSync(SCAN_HISTORY_FILE, 'utf-8').split('\n');
  const rows = [];

  for (let i = 1; i < lines.length; i++) { // skip header
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;

    try {
      rows.push({
        url: parts[0],
        first_seen: parts[1] || new Date().toISOString().slice(0, 10),
        portal: parts[2] || null,
        title: parts[3] || null,
        company: parts[4] || null,
        status: parts[5] || 'added',
      });
    } catch (e) {
      errors.push({ source: SCAN_HISTORY_FILE, line: i + 1, message: e.message });
    }
  }

  return rows;
}

// ── T046: Parse pending TSV batches ───────────────────────────────────────────

function parsePendingTsvBatches(errors) {
  if (!existsSync(ADDITIONS_DIR)) return [];
  const files = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
  const rows = [];

  for (const file of files) {
    const content = readFileSync(join(ADDITIONS_DIR, file), 'utf-8').trim();
    if (!content) continue;

    try {
      let parts;
      if (content.startsWith('|')) {
        parts = content.split('|').map(s => s.trim()).filter(Boolean);
        if (parts.length < 8) continue;
        rows.push({
          _file: file,
          date: parts[1],
          company: parts[2],
          role: parts[3],
          score: parseScore(parts[4]),
          status: normalizeStatus(parts[5]),
          pdf: parts[6]?.includes('✅') ? 1 : 0,
          report_path: parts[7]?.match(/\]\(([^)]+)\)/)?.[1] || null,
          notes: parts[8] || null,
          cycle_id: 1,
        });
      } else {
        parts = content.split('\t');
        if (parts.length < 8) continue;
        rows.push({
          _file: file,
          date: parts[1],
          company: parts[2],
          role: parts[3],
          status: normalizeStatus(parts[4]),
          score: parseScore(parts[5]),
          pdf: parts[6]?.includes('✅') ? 1 : 0,
          report_path: parts[7]?.match(/\]\(([^)]+)\)/)?.[1] || null,
          notes: parts[8] || null,
          cycle_id: 1,
        });
      }
    } catch (e) {
      errors.push({ source: file, line: 1, message: e.message });
    }
  }

  return rows;
}

// ── Main ────────────────────────────────────────────────────────────────────────

const db = openDb();
initSchema(db);

// T047: Idempotency guard
const existingCount = db.prepare('SELECT COUNT(*) AS cnt FROM applications').get().cnt;
if (existingCount > 0 && !FORCE) {
  const msg = `DB already contains ${existingCount} applications. Pass --force to re-run migration (will skip existing rows).`;
  if (JSON_OUT) { console.log(JSON.stringify({ status: 'skipped', message: msg })); }
  else { console.log(msg); }
  process.exit(0);
}

const errors = [];
let applications_imported = 0;
let pipeline_imported = 0;
let scan_history_imported = 0;
let tsv_batches_imported = 0;

log('\n📦 Migrating from markdown/TSV → SQLite\n');

// Applications
const appRows = parseApplicationsMd(errors);
log(`  applications.md: ${appRows.length} rows found`);
for (const row of appRows) {
  if (DRY_RUN) { applications_imported++; continue; }
  try {
    insertApplication(db, row);
    applications_imported++;
  } catch (e) {
    if (e.code === 'DUPLICATE') {
      // already exists (--force re-run) — skip
    } else {
      errors.push({ source: 'applications.md', line: row.num, message: e.message });
    }
  }
}
log(`  → ${applications_imported} applications imported`);

// Pipeline
const pipeRows = parsePipelineMd(errors);
log(`  pipeline.md: ${pipeRows.length} rows found`);
for (const row of pipeRows) {
  if (DRY_RUN) { pipeline_imported++; continue; }
  try {
    insertPipelineEntry(db, row);
    pipeline_imported++;
  } catch (e) {
    if (e.code !== 'DUPLICATE') {
      errors.push({ source: 'pipeline.md', line: row.url, message: e.message });
    }
  }
}
log(`  → ${pipeline_imported} pipeline entries imported`);

// Scan history
const scanRows = parseScanHistoryTsv(errors);
log(`  scan-history.tsv: ${scanRows.length} rows found`);
for (const row of scanRows) {
  if (DRY_RUN) { scan_history_imported++; continue; }
  try {
    upsertScanHistory(db, row);
    scan_history_imported++;
  } catch (e) {
    errors.push({ source: 'scan-history.tsv', line: row.url, message: e.message });
  }
}
log(`  → ${scan_history_imported} scan history entries imported`);

// Pending TSV batches
const tsvRows = parsePendingTsvBatches(errors);
const tsvFiles = new Set(tsvRows.map(r => r._file));
log(`  batch/tracker-additions: ${tsvRows.length} rows in ${tsvFiles.size} files`);
for (const row of tsvRows) {
  if (DRY_RUN) { tsv_batches_imported++; continue; }
  const { _file, ...data } = row;
  try {
    insertApplication(db, data);
    tsv_batches_imported++;
  } catch (e) {
    if (e.code !== 'DUPLICATE') {
      errors.push({ source: _file, line: 1, message: e.message });
    }
  }
}
if (!DRY_RUN && tsvFiles.size > 0) {
  mkdirSync(MERGED_DIR, { recursive: true });
  for (const file of tsvFiles) {
    try { renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file)); } catch {}
  }
}
log(`  → ${tsv_batches_imported} TSV batch rows imported`);

const summary = {
  status: DRY_RUN ? 'dry_run' : 'ok',
  applications_imported,
  pipeline_imported,
  scan_history_imported,
  tsv_batches_imported,
  errors,
};

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  log('\n' + '═'.repeat(45));
  log(`Migration ${DRY_RUN ? '(dry run) ' : ''}complete:`);
  log(`  Applications:   ${applications_imported}`);
  log(`  Pipeline:       ${pipeline_imported}`);
  log(`  Scan history:   ${scan_history_imported}`);
  log(`  TSV batches:    ${tsv_batches_imported}`);
  if (errors.length > 0) {
    log(`  Errors:         ${errors.length}`);
    for (const e of errors) log(`    [${e.source}] line ${e.line}: ${e.message}`);
  }
  if (!DRY_RUN) log('\n✅ DB ready. Run "node db.mjs stats" to verify.');
}
