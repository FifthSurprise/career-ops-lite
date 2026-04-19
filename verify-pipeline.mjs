#!/usr/bin/env node
/**
 * verify-pipeline.mjs — Health check for career-ops pipeline integrity
 *
 * Checks (sourced from SQLite DB):
 * 1. All statuses are canonical (per states.yml)
 * 2. No duplicate company+role entries
 * 3. All report links point to existing files
 * 4. Scores in valid range (0–5) or null
 * 5. No pending TSVs in tracker-additions/
 * 6. states.yml IDs for cross-system consistency
 *
 * Run: node verify-pipeline.mjs
 */

import { readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { openDb, initSchema, listApplications } from './lib/db.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const ADDITIONS_DIR = join(CAREER_OPS, 'batch/tracker-additions');
const REPORTS_DIR = join(CAREER_OPS, 'reports');

mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });

const CANONICAL_STATUSES = [
  'evaluated', 'applied', 'responded', 'interview',
  'offer', 'rejected', 'discarded', 'skip',
];

let errors = 0;
let warnings = 0;

function error(msg) { console.log(`❌ ${msg}`); errors++; }
function warn(msg)  { console.log(`⚠️  ${msg}`); warnings++; }
function ok(msg)    { console.log(`✅ ${msg}`); }

const db = openDb();
initSchema(db);

const entries = listApplications(db, {});

if (entries.length === 0) {
  console.log('\n📊 No applications in DB. This is normal for a fresh setup.\n');
  process.exit(0);
}

console.log(`\n📊 Checking ${entries.length} entries in SQLite DB\n`);

// --- Check 1: Canonical statuses ---
let badStatuses = 0;
for (const e of entries) {
  const lower = (e.status || '').toLowerCase();
  if (!CANONICAL_STATUSES.includes(lower)) {
    error(`#${e.num}: Non-canonical status "${e.status}"`);
    badStatuses++;
  }
  if (/\d{4}-\d{2}-\d{2}/.test(e.status)) {
    error(`#${e.num}: Status contains date: "${e.status}" — dates go in date column`);
    badStatuses++;
  }
}
if (badStatuses === 0) ok('All statuses are canonical');

// --- Check 2: Duplicates (company+role within same cycle_id) ---
const companyRoleMap = new Map();
let dupes = 0;
for (const e of entries) {
  const key = `${e.company.toLowerCase().replace(/[^a-z0-9]/g, '')}::${e.role.toLowerCase().replace(/[^a-z0-9 ]/g, '')}::${e.cycle_id}`;
  if (!companyRoleMap.has(key)) companyRoleMap.set(key, []);
  companyRoleMap.get(key).push(e);
}
for (const [, group] of companyRoleMap) {
  if (group.length > 1) {
    warn(`Possible duplicates: ${group.map(e => `#${e.num}`).join(', ')} (${group[0].company} — ${group[0].role})`);
    dupes++;
  }
}
if (dupes === 0) ok('No exact duplicates found');

// --- Check 3: Report links ---
let brokenReports = 0;
for (const e of entries) {
  if (!e.report_path) continue;
  const reportPath = join(CAREER_OPS, e.report_path);
  if (!existsSync(reportPath)) {
    error(`#${e.num}: Report not found: ${e.report_path}`);
    brokenReports++;
  }
}
if (brokenReports === 0) ok('All report links valid');

// --- Check 4: Score range ---
let badScores = 0;
for (const e of entries) {
  if (e.score == null) continue;
  if (e.score < 0 || e.score > 5) {
    error(`#${e.num}: Score out of range: ${e.score}`);
    badScores++;
  }
}
if (badScores === 0) ok('All scores valid');

// --- Check 5: Pending TSVs ---
let pendingTsvs = 0;
if (existsSync(ADDITIONS_DIR)) {
  const files = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
  pendingTsvs = files.length;
  if (pendingTsvs > 0) {
    warn(`${pendingTsvs} pending TSVs in tracker-additions/ (not merged)`);
  }
}
if (pendingTsvs === 0) ok('No pending TSVs');

// --- Check 6: DB integrity stats ---
const nullDateCount = entries.filter(e => !e.date).length;
if (nullDateCount > 0) warn(`${nullDateCount} entries with null date`);
else ok('All entries have dates');

// --- Summary ---
console.log('\n' + '='.repeat(50));
console.log(`📊 Pipeline Health: ${errors} errors, ${warnings} warnings`);
if (errors === 0 && warnings === 0) {
  console.log('🟢 Pipeline is clean!');
} else if (errors === 0) {
  console.log('🟡 Pipeline OK with warnings');
} else {
  console.log('🔴 Pipeline has errors — fix before proceeding');
}

process.exit(errors > 0 ? 1 : 0);
