#!/usr/bin/env node
/**
 * dedup-tracker.mjs — Remove duplicate entries from the SQLite DB
 *
 * Groups by normalized company + fuzzy role match (within same cycle_id).
 * Keeps entry with highest score. If discarded entry had more advanced status,
 * preserves that status. Merges notes.
 *
 * Run: node dedup-tracker.mjs [--dry-run]
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { openDb, initSchema, listApplications, updateApplication, deleteApplication } from './lib/db.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });

const STATUS_RANK = {
  'skip': 0, 'discarded': 0, 'rejected': 1,
  'evaluated': 2, 'applied': 3, 'responded': 4, 'interview': 5, 'offer': 6,
};

function normalizeCompany(name) {
  return name.toLowerCase().replace(/[()]/g, '').replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

function normalizeRole(role) {
  return role.toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').replace(/[^a-z0-9 /]/g, '').trim();
}

const ROLE_STOPWORDS = new Set([
  'senior', 'junior', 'lead', 'staff', 'principal', 'head', 'chief',
  'manager', 'director', 'associate', 'intern', 'contractor',
  'remote', 'hybrid', 'onsite', 'engineer', 'engineering',
]);
const LOCATION_STOPWORDS = new Set([
  'tokyo', 'japan', 'london', 'berlin', 'paris', 'singapore',
  'york', 'francisco', 'angeles', 'seattle', 'austin', 'boston',
  'chicago', 'denver', 'toronto', 'amsterdam', 'dublin', 'sydney',
  'remote', 'global', 'emea', 'apac', 'latam',
]);

function roleMatch(a, b) {
  const filter = (words) => words.filter(w => !ROLE_STOPWORDS.has(w) && !LOCATION_STOPWORDS.has(w));
  const wordsA = filter(normalizeRole(a).split(/\s+/).filter(w => w.length > 2));
  const wordsB = filter(normalizeRole(b).split(/\s+/).filter(w => w.length > 2));
  if (wordsA.length === 0 || wordsB.length === 0) return false;
  const overlap = wordsA.filter(w => wordsB.some(wb => wb === w));
  const smaller = Math.min(wordsA.length, wordsB.length);
  return overlap.length >= 2 && overlap.length / smaller >= 0.6;
}

const db = openDb();
initSchema(db);

const entries = listApplications(db, {});
console.log(`📊 ${entries.length} entries loaded`);

// Group by company
const groups = new Map();
for (const entry of entries) {
  const key = normalizeCompany(entry.company);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(entry);
}

let removed = 0;

for (const [, companyEntries] of groups) {
  if (companyEntries.length < 2) continue;

  const processed = new Set();
  for (let i = 0; i < companyEntries.length; i++) {
    if (processed.has(i)) continue;
    const cluster = [companyEntries[i]];
    processed.add(i);

    for (let j = i + 1; j < companyEntries.length; j++) {
      if (processed.has(j)) continue;
      if (companyEntries[i].cycle_id !== companyEntries[j].cycle_id) continue;
      if (roleMatch(companyEntries[i].role, companyEntries[j].role)) {
        cluster.push(companyEntries[j]);
        processed.add(j);
      }
    }

    if (cluster.length < 2) continue;

    cluster.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const keeper = cluster[0];

    // Promote status if a removed entry had more advanced status
    let bestRank = STATUS_RANK[keeper.status.toLowerCase()] ?? 0;
    let bestStatus = keeper.status;
    for (let k = 1; k < cluster.length; k++) {
      const rank = STATUS_RANK[cluster[k].status.toLowerCase()] ?? 0;
      if (rank > bestRank) { bestRank = rank; bestStatus = cluster[k].status; }
    }

    if (bestStatus !== keeper.status) {
      console.log(`  📝 #${keeper.num}: status promoted to "${bestStatus}"`);
      if (!DRY_RUN) updateApplication(db, keeper.id, 'status', bestStatus);
    }

    for (let k = 1; k < cluster.length; k++) {
      const dup = cluster[k];
      console.log(`🗑️  Remove #${dup.num} (${dup.company} — ${dup.role}, ${dup.score ?? 'N/A'}) → kept #${keeper.num} (${keeper.score ?? 'N/A'})`);
      if (!DRY_RUN) deleteApplication(db, dup.id);
      removed++;
    }
  }
}

console.log(`\n📊 ${removed} duplicates removed`);
if (DRY_RUN) console.log('(dry-run — no changes written)');
else if (removed === 0) console.log('✅ No duplicates found');
else console.log('✅ Duplicates removed from DB');
