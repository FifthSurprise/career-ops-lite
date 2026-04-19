#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import {
  openDb, initSchema,
  getApplicationById, getApplicationByNum, listApplications,
  insertApplication, updateApplication, deleteApplication,
  getPipelineEntryById, getPipelineEntryByUrl, listPipeline,
  insertPipelineEntry, updatePipelineEntry, deletePipelineEntry,
  isDuplicate,
  getLlmContent, listLlmContent, setLlmContent,
  deleteLlmContent, deleteLlmContentForOwner,
  nextApplicationNum, repostCheck, slugify,
} from './lib/db.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = join(__dir, 'db', 'career-ops.db');

// ── Arg parser ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// ── Output helpers ────────────────────────────────────────────────────────────

function out(json, data) {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else if (typeof data === 'string') {
    process.stdout.write(data + '\n');
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  }
}

function errOut(json, code, message, exitCode = 1) {
  const payload = { status: 'error', code, message };
  if (json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    process.stderr.write(`Error [${code}]: ${message}\n`);
  }
  process.exit(exitCode);
}

function notFound(json, label) {
  errOut(json, 'NOT_FOUND', `${label} not found.`);
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtApp(row) {
  return { ...row, pdf: !!row.pdf };
}

function fmtScore(score) {
  return score != null ? `${Number(score).toFixed(1)}/5` : 'N/A';
}

// ── Subcommand: init ──────────────────────────────────────────────────────────

function cmdInit(db, { flags }) {
  const tables = initSchema(db);
  if (flags.json) {
    out(true, { status: 'ok', tables_created: tables });
  } else {
    console.log('Database initialized. Tables:', tables.join(', '));
  }
}

// ── Subcommand: stats ─────────────────────────────────────────────────────────

function cmdStats(db, { flags }) {
  const appRows = db.prepare('SELECT status, COUNT(*) AS cnt FROM applications GROUP BY status').all();
  const appTotal = db.prepare('SELECT COUNT(*) AS cnt FROM applications').get().cnt;
  const by_status = Object.fromEntries(appRows.map(r => [r.status, r.cnt]));

  const agg = db.prepare(`
    SELECT
      AVG(score)                                    AS avg_score,
      SUM(CASE WHEN pdf = 1 THEN 1 ELSE 0 END)      AS with_pdf,
      SUM(CASE WHEN report_path IS NOT NULL AND report_path != '' THEN 1 ELSE 0 END) AS with_report,
      MAX(num)                                      AS max_num
    FROM applications
  `).get();
  const pctPdf    = appTotal ? Math.round(100 * (agg.with_pdf ?? 0) / appTotal) : 0;
  const pctReport = appTotal ? Math.round(100 * (agg.with_report ?? 0) / appTotal) : 0;

  const pipeRows = db.prepare('SELECT state, COUNT(*) AS cnt FROM pipeline_entries GROUP BY state').all();
  const pipeTotal = db.prepare('SELECT COUNT(*) AS cnt FROM pipeline_entries').get().cnt;
  const by_state = Object.fromEntries(pipeRows.map(r => [r.state, r.cnt]));

  const data = {
    applications: {
      total: appTotal,
      by_status,
      avg_score: agg.avg_score != null ? Number(agg.avg_score.toFixed(2)) : null,
      with_pdf: agg.with_pdf ?? 0,
      with_pdf_pct: pctPdf,
      with_report: agg.with_report ?? 0,
      with_report_pct: pctReport,
      next_num: (agg.max_num ?? 0) + 1,
    },
    pipeline: { total: pipeTotal, by_state },
  };

  if (flags.json) {
    out(true, data);
  } else {
    console.log(`Applications: ${appTotal}`);
    for (const [s, n] of Object.entries(by_status)) console.log(`  ${s}: ${n}`);
    if (data.applications.avg_score != null) console.log(`  avg score: ${data.applications.avg_score}/5`);
    console.log(`  with PDF: ${agg.with_pdf ?? 0} (${pctPdf}%)`);
    console.log(`  with report: ${agg.with_report ?? 0} (${pctReport}%)`);
    console.log(`  next num: ${data.applications.next_num}`);
    console.log(`Pipeline: ${pipeTotal}`);
    for (const [s, n] of Object.entries(by_state)) console.log(`  ${s}: ${n}`);
  }
}

// ── Subcommand: list applications (T019) ──────────────────────────────────────

function cmdListApplications(db, { flags }) {
  const filters = {};
  if (flags.status) filters.status = flags.status;
  if (flags['status-in']) filters.statusIn = flags['status-in'].split(',');
  if (flags.company) filters.company = flags.company;
  if (flags.role) filters.role = flags.role;
  if (flags['score-min']) filters.scoreMin = parseFloat(flags['score-min']);
  if (flags['score-max']) filters.scoreMax = parseFloat(flags['score-max']);
  if (flags.days) filters.days = parseInt(flags.days);
  if (flags['cycle-id']) filters.cycleId = parseInt(flags['cycle-id']);
  if (flags.limit) filters.limit = parseInt(flags.limit);
  if (flags.offset) filters.offset = parseInt(flags.offset);

  const rows = listApplications(db, filters).map(fmtApp);
  out(flags.json, rows);
  if (!flags.json) console.log(`${rows.length} application(s) found.`);
}

// ── Subcommand: list pipeline (T020) ──────────────────────────────────────────

function cmdListPipeline(db, { flags }) {
  const filters = {};
  if (flags.state) filters.state = flags.state;
  if (flags.company) filters.company = flags.company;
  if (flags.days) filters.days = parseInt(flags.days);

  const rows = listPipeline(db, filters);
  out(flags.json, rows);
  if (!flags.json) console.log(`${rows.length} pipeline entry(s) found.`);
}

// ── Subcommand: insert application ────────────────────────────────────────────

function cmdInsertApplication(db, { flags }) {
  if (!flags.data) errOut(flags.json, 'MISSING_ARG', '--data <json> is required');
  let data;
  try { data = JSON.parse(flags.data); } catch {
    errOut(flags.json, 'INVALID_JSON', '--data must be valid JSON');
  }
  try {
    const { id, num } = insertApplication(db, data);
    out(flags.json, { status: 'ok', id, num });
    if (!flags.json) console.log(`Inserted application #${num} (id=${id})`);
  } catch (e) {
    errOut(flags.json, e.code ?? 'DB_ERROR', e.message);
  }
}

// ── Subcommand: get application ────────────────────────────────────────────────

function cmdGetApplication(db, { flags, positional }) {
  const arg = positional[0];
  if (!arg) errOut(flags.json, 'MISSING_ARG', 'Usage: get application <id|num>');

  let row;
  if (flags.id) {
    row = getApplicationById(db, Number(arg));
  } else {
    row = getApplicationByNum(db, Number(arg)) ?? getApplicationById(db, Number(arg));
  }
  if (!row) notFound(flags.json, `Application ${arg}`);
  out(flags.json, fmtApp(row));
}

// ── Subcommand: update application (T021) ────────────────────────────────────

function cmdUpdateApplication(db, { flags, positional }) {
  const id = Number(positional[0]);
  if (!id) errOut(flags.json, 'MISSING_ARG', 'Usage: update application <id> --field <name> --value <value>');
  if (!flags.field) errOut(flags.json, 'MISSING_ARG', '--field is required');
  if (flags.value === undefined) errOut(flags.json, 'MISSING_ARG', '--value is required');
  try {
    updateApplication(db, id, flags.field, flags.value);
    out(flags.json, { status: 'ok', id, field: flags.field, value: flags.value });
    if (!flags.json) console.log(`Updated application ${id}: ${flags.field} = ${flags.value}`);
  } catch (e) {
    errOut(flags.json, e.code ?? 'DB_ERROR', e.message);
  }
}

// ── Subcommand: delete application (T023) ────────────────────────────────────

function cmdDeleteApplication(db, { flags, positional }) {
  const id = Number(positional[0]);
  if (!id) errOut(flags.json, 'MISSING_ARG', 'Usage: delete application <id>');
  if (!flags.force) {
    errOut(flags.json, 'CONFIRMATION_REQUIRED', `Pass --force to delete application ${id} and all its llm_content.`);
  }
  deleteApplication(db, id);
  out(flags.json, { status: 'ok', deleted_id: id });
  if (!flags.json) console.log(`Deleted application ${id}`);
}

// ── Subcommand: insert pipeline ────────────────────────────────────────────────

function cmdInsertPipeline(db, { flags }) {
  if (!flags.url) errOut(flags.json, 'MISSING_ARG', '--url is required');
  try {
    const { id } = insertPipelineEntry(db, {
      url: flags.url,
      source: flags.source,
      state: flags.state,
      company: flags.company,
      title: flags.title,
    });
    out(flags.json, { status: 'ok', id });
    if (!flags.json) console.log(`Inserted pipeline entry id=${id}`);
  } catch (e) {
    const code = e.code === 'DUPLICATE' ? 'DUPLICATE_URL' : (e.code ?? 'DB_ERROR');
    errOut(flags.json, code, e.message);
  }
}

// ── Subcommand: get pipeline ───────────────────────────────────────────────────

function cmdGetPipeline(db, { flags, positional }) {
  const arg = positional[0];
  if (!arg) errOut(flags.json, 'MISSING_ARG', 'Usage: get pipeline <id|url>');

  const row = arg.startsWith('http')
    ? getPipelineEntryByUrl(db, arg)
    : getPipelineEntryById(db, Number(arg));
  if (!row) notFound(flags.json, `Pipeline entry ${arg}`);
  out(flags.json, row);
}

// ── Subcommand: update pipeline (T022) ───────────────────────────────────────

function cmdUpdatePipeline(db, { flags, positional }) {
  const arg = positional[0];
  if (!arg) errOut(flags.json, 'MISSING_ARG', 'Usage: update pipeline <id|url> --field <name> --value <value>');
  if (!flags.field) errOut(flags.json, 'MISSING_ARG', '--field is required');
  if (flags.value === undefined) errOut(flags.json, 'MISSING_ARG', '--value is required');

  const entry = arg.startsWith('http') ? getPipelineEntryByUrl(db, arg) : getPipelineEntryById(db, Number(arg));
  if (!entry) notFound(flags.json, `Pipeline entry ${arg}`);

  try {
    updatePipelineEntry(db, entry.id, flags.field, flags.value);
    out(flags.json, { status: 'ok', id: entry.id, field: flags.field, value: flags.value });
    if (!flags.json) console.log(`Updated pipeline entry ${entry.id}: ${flags.field} = ${flags.value}`);
  } catch (e) {
    errOut(flags.json, e.code ?? 'DB_ERROR', e.message);
  }
}

// ── Subcommand: delete pipeline (T024) ───────────────────────────────────────

function cmdDeletePipeline(db, { flags, positional }) {
  const arg = positional[0];
  if (!arg) errOut(flags.json, 'MISSING_ARG', 'Usage: delete pipeline <id|url>');
  if (!flags.force) {
    errOut(flags.json, 'CONFIRMATION_REQUIRED', `Pass --force to delete pipeline entry "${arg}" and all its llm_content.`);
  }

  const entry = arg.startsWith('http') ? getPipelineEntryByUrl(db, arg) : getPipelineEntryById(db, Number(arg));
  if (!entry) notFound(flags.json, `Pipeline entry ${arg}`);

  deletePipelineEntry(db, entry.id);
  out(flags.json, { status: 'ok', deleted_id: entry.id });
  if (!flags.json) console.log(`Deleted pipeline entry ${entry.id}`);
}

// ── Subcommand: next-num ─────────────────────────────────────────────────────

function cmdNextNum(db, { flags }) {
  const next = nextApplicationNum(db);
  if (flags.json) out(true, { next });
  else console.log(next);
}

// ── Subcommand: repost-check ─────────────────────────────────────────────────

function cmdRepostCheck(db, { flags }) {
  if (!flags.company) errOut(flags.json, 'MISSING_ARG', '--company is required');
  const result = repostCheck(db, { company: flags.company, role: flags.role });
  out(flags.json, result);
  if (!flags.json) {
    if (result.count === 0) console.log(`No prior scan_history matches for ${flags.company}.`);
    else console.log(`${result.count} prior posting(s): first ${result.first_seen}, last ${result.last_seen}`);
  }
}

// ── Subcommand: slug ──────────────────────────────────────────────────────────

function cmdSlug({ flags, positional }) {
  const text = positional.join(' ');
  if (!text) errOut(flags.json, 'MISSING_ARG', 'Usage: slug <text>');
  const s = slugify(text);
  if (flags.json) out(true, { slug: s });
  else console.log(s);
}

// ── Subcommand: dedup (T025) ──────────────────────────────────────────────────

function cmdDedup(db, { flags }) {
  const result = isDuplicate(db, {
    url: flags.url,
    company: flags.company,
    role: flags.role,
  });
  out(flags.json, result);
  if (!flags.json) {
    if (result.found) {
      console.log(`Duplicate found in: ${result.source}`);
    } else {
      console.log('No duplicate found.');
    }
  }
}

// ── Subcommand: content list (T038) ──────────────────────────────────────────

function cmdContentList(db, { flags, positional }) {
  const [ownerType, ownerIdStr] = positional;
  if (!ownerType || !ownerIdStr) errOut(flags.json, 'MISSING_ARG', 'Usage: content list <owner-type> <owner-id>');
  const rows = listLlmContent(db, ownerType, Number(ownerIdStr));
  out(flags.json, rows);
}

// ── Subcommand: content get (T039) ───────────────────────────────────────────

function cmdContentGet(db, { flags, positional }) {
  const [ownerType, ownerIdStr, tag] = positional;
  if (!ownerType || !ownerIdStr || !tag) errOut(flags.json, 'MISSING_ARG', 'Usage: content get <owner-type> <owner-id> <tag>');
  const row = getLlmContent(db, ownerType, Number(ownerIdStr), tag);
  if (!row) notFound(flags.json, `llm_content ${ownerType}/${ownerIdStr}/${tag}`);
  out(flags.json, row);
}

// ── Subcommand: content set (T040) ───────────────────────────────────────────

function cmdContentSet(db, { flags, positional }) {
  const [ownerType, ownerIdStr, tag] = positional;
  if (!ownerType || !ownerIdStr || !tag) errOut(flags.json, 'MISSING_ARG', 'Usage: content set <owner-type> <owner-id> <tag> --body <text>|--file <path>');

  let body;
  if (flags.body) {
    body = String(flags.body);
  } else if (flags.file) {
    try { body = readFileSync(flags.file, 'utf-8'); } catch {
      errOut(flags.json, 'FILE_NOT_FOUND', `Cannot read file: ${flags.file}`);
    }
  } else {
    errOut(flags.json, 'MISSING_ARG', '--body <text> or --file <path> is required');
  }

  try {
    const { id, action } = setLlmContent(db, ownerType, Number(ownerIdStr), tag, body);
    out(flags.json, { status: 'ok', id, action });
    if (!flags.json) console.log(`${action}: ${ownerType}/${ownerIdStr}/${tag}`);
  } catch (e) {
    errOut(flags.json, e.code ?? 'DB_ERROR', e.message);
  }
}

// ── Subcommand: content delete (T041) ────────────────────────────────────────

function cmdContentDelete(db, { flags, positional }) {
  const [ownerType, ownerIdStr, tag] = positional;
  if (!ownerType || !ownerIdStr || !tag) errOut(flags.json, 'MISSING_ARG', 'Usage: content delete <owner-type> <owner-id> <tag>');
  const deleted = deleteLlmContent(db, ownerType, Number(ownerIdStr), tag);
  out(flags.json, { status: 'ok', deleted });
  if (!flags.json) console.log(deleted ? 'Deleted.' : 'Not found (nothing deleted).');
}

// ── Subcommand: export (T048) ─────────────────────────────────────────────────

function cmdExport(db, { flags }) {
  const doApps = !flags.pipeline || flags.applications;
  const doPipe = !flags.applications || flags.pipeline;
  const files = [];

  mkdirSync(join(__dir, 'data'), { recursive: true });

  if (doApps) {
    const rows = listApplications(db, {});
    const header = [
      '<!-- Auto-generated by db.mjs export — do not edit -->',
      '# Applications Tracker',
      '',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|--------|-------|',
    ];
    const dataLines = rows.map(r => {
      const score = r.score != null ? `${Number(r.score).toFixed(1)}/5` : 'N/A';
      const pdf = r.pdf ? '✅' : '❌';
      const report = r.report_path ? `[${r.num}](${r.report_path})` : '';
      return `| ${r.num} | ${r.date} | ${r.company} | ${r.role} | ${score} | ${r.status} | ${pdf} | ${report} | ${r.notes ?? ''} |`;
    });
    const appsPath = join(__dir, 'data', 'applications.md');
    writeFileSync(appsPath, [...header, ...dataLines, ''].join('\n'));
    files.push('data/applications.md');
  }

  if (doPipe) {
    const rows = listPipeline(db, {});
    const header = [
      '<!-- Auto-generated by db.mjs export — do not edit -->',
      '# Pipeline',
      '',
    ];
    const dataLines = rows.map(r => {
      const check = ['evaluated', 'applied', 'expired'].includes(r.state) ? '[x]' : '[ ]';
      const parts = [r.url, r.company, r.title].filter(Boolean);
      return `- ${check} ${parts.join(' | ')}`;
    });
    const pipePath = join(__dir, 'data', 'pipeline.md');
    writeFileSync(pipePath, [...header, ...dataLines, ''].join('\n'));
    files.push('data/pipeline.md');
  }

  out(flags.json, { status: 'ok', files });
  if (!flags.json) console.log('Exported:', files.join(', '));
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const USAGE = `
Usage: node db.mjs <subcommand> [options]

Subcommands:
  init                          Initialize database schema
  stats [--json]                Show counts by status/state
  list   applications [filters] Filter and list applications
  list   pipeline [--state] [--company] [--days]
  get    application <id|num>
  get    pipeline <id|url>
  insert application --data <json>
  insert pipeline --url <url> [--source] [--state] [--company] [--title]
  update application <id> --field <name> --value <value>
  update pipeline <id|url> --field <name> --value <value>
  delete application <id> --force
  delete pipeline <id|url> --force
  dedup  --url <url> [--company <c> --role <r>]
  next-num                      Next sequential application num
  repost-check --company <c> [--role <r>]   Scan-history repost lookup
  slug <text>                   kebab-case slugify helper
  content list <owner-type> <owner-id>
  content get  <owner-type> <owner-id> <tag>
  content set  <owner-type> <owner-id> <tag> --body <text>|--file <path>
  content delete <owner-type> <owner-id> <tag>
  export [--applications] [--pipeline]
  migrate [--dry-run] [--force]

Global options:
  --json        Machine-readable JSON output
  --db <path>   Override DB path (default: data/career-ops.db)
`.trim();

const raw = process.argv.slice(2);
const { flags: globalFlags, positional: globalPos } = parseArgs(raw);

const dbPath = globalFlags.db ?? DEFAULT_DB;
const isNew = !existsSync(dbPath);
const db = openDb(dbPath);
if (isNew) initSchema(db);

const sub = globalPos[0];
const rest = { flags: globalFlags, positional: globalPos.slice(1) };

switch (sub) {
  case 'init':
    cmdInit(db, rest);
    break;

  case 'stats':
    cmdStats(db, rest);
    break;

  case 'list': {
    const type = globalPos[1];
    const r = { flags: globalFlags, positional: globalPos.slice(2) };
    if (type === 'applications') cmdListApplications(db, r);
    else if (type === 'pipeline') cmdListPipeline(db, r);
    else errOut(globalFlags.json, 'UNKNOWN_TYPE', `Unknown type "${type}". Use: applications, pipeline`);
    break;
  }

  case 'get': {
    const type = globalPos[1];
    const r = { flags: globalFlags, positional: globalPos.slice(2) };
    if (type === 'application') cmdGetApplication(db, r);
    else if (type === 'pipeline') cmdGetPipeline(db, r);
    else errOut(globalFlags.json, 'UNKNOWN_TYPE', `Unknown type "${type}". Use: application, pipeline`);
    break;
  }

  case 'insert': {
    const type = globalPos[1];
    const r = { flags: globalFlags, positional: globalPos.slice(2) };
    if (type === 'application') cmdInsertApplication(db, r);
    else if (type === 'pipeline') cmdInsertPipeline(db, r);
    else errOut(globalFlags.json, 'UNKNOWN_TYPE', `Unknown type "${type}". Use: application, pipeline`);
    break;
  }

  case 'update': {
    const type = globalPos[1];
    const r = { flags: globalFlags, positional: globalPos.slice(2) };
    if (type === 'application') cmdUpdateApplication(db, r);
    else if (type === 'pipeline') cmdUpdatePipeline(db, r);
    else errOut(globalFlags.json, 'UNKNOWN_TYPE', `Unknown type "${type}". Use: application, pipeline`);
    break;
  }

  case 'delete': {
    const type = globalPos[1];
    const r = { flags: globalFlags, positional: globalPos.slice(2) };
    if (type === 'application') cmdDeleteApplication(db, r);
    else if (type === 'pipeline') cmdDeletePipeline(db, r);
    else errOut(globalFlags.json, 'UNKNOWN_TYPE', `Unknown type "${type}". Use: application, pipeline`);
    break;
  }

  case 'dedup':
    cmdDedup(db, rest);
    break;

  case 'next-num':
    cmdNextNum(db, rest);
    break;

  case 'repost-check':
    cmdRepostCheck(db, rest);
    break;

  case 'slug':
    cmdSlug(rest);
    break;

  case 'content': {
    const action = globalPos[1];
    const r = { flags: globalFlags, positional: globalPos.slice(2) };
    if (action === 'list') cmdContentList(db, r);
    else if (action === 'get') cmdContentGet(db, r);
    else if (action === 'set') cmdContentSet(db, r);
    else if (action === 'delete') cmdContentDelete(db, r);
    else errOut(globalFlags.json, 'UNKNOWN_ACTION', `Unknown content action "${action}". Use: list, get, set, delete`);
    break;
  }

  case 'export':
    cmdExport(db, rest);
    break;

  case 'migrate':
    // delegate to migrate-to-db.mjs
    errOut(globalFlags.json, 'USE_MIGRATE_SCRIPT', 'Run: node migrate-to-db.mjs [--dry-run] [--force]');
    break;

  default:
    process.stdout.write(USAGE + '\n');
    if (sub) process.exit(1);
}
