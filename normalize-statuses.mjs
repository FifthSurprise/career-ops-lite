#!/usr/bin/env node
/**
 * normalize-statuses.mjs — Clean non-canonical statuses in the SQLite DB
 *
 * Maps all non-canonical statuses to canonical ones per states.yml.
 * Strips markdown bold (**) and dates from the status field.
 *
 * Run: node normalize-statuses.mjs [--dry-run]
 */

import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { openDb, initSchema, listApplications, updateApplication } from './lib/db.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });

function normalizeStatus(raw) {
  let s = raw.replace(/\*\*/g, '').trim();
  const lower = s.toLowerCase();

  if (/^duplicado/i.test(s) || /^dup\b/i.test(s)) return { status: 'Discarded' };
  if (/^(cerrada|cancelada|descartada|descartado)$/i.test(s)) return { status: 'Discarded' };
  if (/^rechazada?$/i.test(s) || /^rechazado\s+\d{4}/i.test(s)) return { status: 'Rejected' };
  if (/^aplicado\s+\d{4}/i.test(s)) return { status: 'Applied' };
  if (/^(condicional|hold|evaluar|verificar)$/i.test(s)) return { status: 'Evaluated' };
  if (/^monitor$/i.test(s) || /geo.?blocker/i.test(lower)) return { status: 'SKIP' };
  if (/^repost/i.test(s)) return { status: 'Discarded' };
  if (s === '—' || s === '-' || s === '') return { status: 'Discarded' };

  const canonical = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'];
  for (const c of canonical) {
    if (lower === c.toLowerCase()) return { status: c };
  }

  const aliases = {
    'evaluada': 'Evaluated',
    'aplicado': 'Applied', 'enviada': 'Applied', 'aplicada': 'Applied', 'sent': 'Applied',
    'respondido': 'Responded',
    'entrevista': 'Interview',
    'oferta': 'Offer',
    'no aplicar': 'SKIP', 'no_aplicar': 'SKIP', 'skip': 'SKIP',
  };
  if (aliases[lower]) return { status: aliases[lower] };

  return { status: null, unknown: true };
}

const db = openDb();
initSchema(db);

const entries = listApplications(db, {});

if (entries.length === 0) {
  console.log('No applications in DB. Nothing to normalize.');
  process.exit(0);
}

let changes = 0;
const unknowns = [];

for (const e of entries) {
  const result = normalizeStatus(e.status);

  if (result.unknown) {
    unknowns.push({ num: e.num, id: e.id, rawStatus: e.status });
    continue;
  }

  if (result.status === e.status) continue;

  console.log(`#${e.num}: "${e.status}" → "${result.status}"`);
  if (!DRY_RUN) updateApplication(db, e.id, 'status', result.status);
  changes++;
}

if (unknowns.length > 0) {
  console.log(`\n⚠️  ${unknowns.length} unknown statuses:`);
  for (const u of unknowns) console.log(`  #${u.num}: "${u.rawStatus}"`);
}

console.log(`\n📊 ${changes} statuses normalized`);
if (DRY_RUN) console.log('(dry-run — no changes written)');
else if (changes === 0) console.log('✅ No changes needed');
else console.log('✅ Statuses updated in DB');
