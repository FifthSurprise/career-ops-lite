---
description: "Task list for SQLite Storage for Pipeline and Applications"
---

# Tasks: SQLite Storage for Pipeline and Applications

**Input**: Design documents from `/specs/001-sqlite-storage/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/db-cli.md ✅

**Tests**: Not explicitly requested — no TDD tasks generated. DB correctness checked via `test-all.mjs` extensions in the Polish phase.

**Organization**: Tasks grouped by user story. US1→US2→US3 form a natural dependency chain (schema → queries → script migrations). US4 and US5 can start after US1.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no shared dependencies on incomplete tasks)
- **[Story]**: Maps to user stories US1–US5 from spec.md

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependencies installed, directory structure created, documentation updated.

- [ ] T001 Add `better-sqlite3` to `package.json` dependencies and run `npm install` to confirm it builds (binaries pre-built for macOS/Linux)
- [ ] T002 [P] Add `modernc.org/sqlite` to `dashboard/go.mod` via `go get modernc.org/sqlite` from `dashboard/` directory
- [ ] T003 [P] Create `lib/` directory at repo root (holds shared `lib/db.mjs` module)
- [ ] T004 [P] Update `DATA_CONTRACT.md` — add `data/career-ops.db` explicitly to the User Layer list alongside `data/*`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: `lib/db.mjs` shared module — everything else imports from here. MUST be complete before any user story phase.

- [ ] T005 Create `lib/db.mjs` — export `openDb()` function that opens `data/career-ops.db`, sets `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, and `PRAGMA busy_timeout=5000`; returns the `better-sqlite3` Database instance
- [ ] T006 Add `initSchema(db)` to `lib/db.mjs` — run `CREATE TABLE IF NOT EXISTS` for all four tables: `applications` (id, num, date, company, role, cycle_id, status, score, pdf, report_path, url, legitimacy, notes; UNIQUE on company+role+cycle_id), `pipeline_entries` (id, url UNIQUE, source, state, title, company, local_jd, discovered_at, application_id), `llm_content` (id, owner_type, owner_id, tag, body, created_at; UNIQUE on owner_type+owner_id+tag), `scan_history` (url PRIMARY KEY, first_seen, portal, title, company, status); create all indexes from `data-model.md`
- [ ] T007 Add `loadCanonicalStatuses()` to `lib/db.mjs` — read `templates/states.yml` with `js-yaml`, extract all canonical `label` values (case-insensitive); export `validateStatus(s)` that throws a clear error if the value is not in the list
- [ ] T008 [P] Add application read helpers to `lib/db.mjs` — `getApplicationById(db, id)`, `getApplicationByNum(db, num)`, `listApplications(db, filters)` where filters accepts `{status, statusIn, company, role, scoreMin, scoreMax, days, cycleId, limit, offset}`; all return plain JS objects
- [ ] T009 [P] Add application write helpers to `lib/db.mjs` — `insertApplication(db, data)` (validates status, auto-assigns num as MAX(num)+1 in transaction, returns `{id, num}`; rejects duplicate company+role+cycle_id with message from FR-004), `updateApplication(db, id, field, value)` (validates status if field=status), `deleteApplication(db, id)` (deletes llm_content rows first in same transaction)
- [ ] T010 [P] Add pipeline read/write helpers to `lib/db.mjs` — `getPipelineEntryById(db, id)`, `getPipelineEntryByUrl(db, url)`, `listPipeline(db, filters)`, `insertPipelineEntry(db, data)` (rejects duplicate URL with clear error), `updatePipelineEntry(db, id, field, value)`, `deletePipelineEntry(db, id)` (deletes llm_content first)
- [ ] T011 [P] Add scan history helpers to `lib/db.mjs` — `upsertScanHistory(db, entry)` (INSERT OR REPLACE), `isUrlSeen(db, url)` (returns bool), `isCompanyRoleSeen(db, company, role)` (queries scan_history + applications for active cycle_id)

---

## Phase 3: User Story 1 — DB entry point + basic data storage

**Story goal**: A working `db.mjs init`, plus insert/get for applications and pipeline entries. Round-trip test: migrate any row from markdown, retrieve by ID, values match.

**Independent test**: `node db.mjs init && node db.mjs insert application --data '{"date":"2026-01-01","company":"Acme","role":"Engineer","status":"Evaluated"}' --json` → returns `{status:"ok", id:1, num:1}`; `node db.mjs get application 1 --json` → returns same record.

- [ ] T012 [US1] Create `db.mjs` CLI entry point — parse `process.argv`, dispatch to subcommand handlers (use a simple `switch` on `argv[2]`), print help/usage when no subcommand given; import `openDb` + `initSchema` from `lib/db.mjs`; auto-init schema on first run if DB file does not exist
- [ ] T013 [US1] Implement `db.mjs init` subcommand — call `initSchema(db)`, output `{status:"ok", tables_created:[...]}` with `--json` or confirmation text without it
- [ ] T014 [US1] [P] Implement `db.mjs insert application` subcommand in `db.mjs` — parse `--data <json-string>`, call `insertApplication()` from `lib/db.mjs`, output `{status, id, num}` or `{status:"error", code, message}` for duplicate/invalid
- [ ] T015 [US1] [P] Implement `db.mjs get application <id|num>` subcommand in `db.mjs` — detect whether arg is a known num or id, call appropriate lib helper, output single record JSON or `{status:"error",code:"NOT_FOUND"}`
- [ ] T016 [US1] [P] Implement `db.mjs insert pipeline` subcommand in `db.mjs` — parse `--url`, `--source`, `--state`, `--company`, `--title` flags; call `insertPipelineEntry()`, return `{status, id}`
- [ ] T017 [US1] [P] Implement `db.mjs get pipeline <id|url>` subcommand in `db.mjs` — auto-detect id vs URL (starts with `http`), call lib helper, return record JSON
- [ ] T018 [US1] Implement `db.mjs stats` subcommand in `db.mjs` — run two GROUP BY queries (`applications` by status, `pipeline_entries` by state), return `{applications:{total, by_status:{...}}, pipeline:{total, by_state:{...}}}` JSON

---

## Phase 4: User Story 2 — Filtering and dedup queries

**Story goal**: Full filter support on `list applications` and `list pipeline`; dedup lookup for scanner; `update` and `delete` subcommands.

**Independent test**: Seed DB with 5 applications of mixed statuses via `db.mjs insert`, run `db.mjs list applications --status Evaluated --json`, confirm only Evaluated rows returned.

- [ ] T019 [US2] Implement `db.mjs list applications` subcommand in `db.mjs` — wire all filter flags (`--status`, `--status-in`, `--company`, `--role`, `--score-min`, `--score-max`, `--days`, `--cycle-id`, `--limit`, `--offset`) to `listApplications()` in `lib/db.mjs`; output JSON array
- [ ] T020 [US2] Implement `db.mjs list pipeline` subcommand in `db.mjs` — wire `--state`, `--company`, `--days` to `listPipeline()`; output JSON array
- [ ] T021 [US2] [P] Implement `db.mjs update application <id> --field <name> --value <value>` in `db.mjs` — call `updateApplication()`, return `{status, id, field, value}`
- [ ] T022 [US2] [P] Implement `db.mjs update pipeline <id|url> --field <name> --value <value>` in `db.mjs` — call `updatePipelineEntry()`, return `{status, id, field, value}`
- [ ] T023 [US2] [P] Implement `db.mjs delete application <id>` in `db.mjs` — prompt confirmation unless `--force`; call `deleteApplication()` (which handles llm_content cascade); return `{status, deleted_id}`
- [ ] T024 [US2] [P] Implement `db.mjs delete pipeline <id|url>` in `db.mjs` — prompt unless `--force`; call `deletePipelineEntry()`; return `{status, deleted_id}`
- [ ] T025 [US2] Add `isDuplicate(db, {url, company, role})` dedup helper to `lib/db.mjs` — checks `scan_history` by URL, `pipeline_entries` by URL, and `applications` by company+role (any cycle_id); returns `{found: bool, source: 'scan_history'|'pipeline'|'application'|null}`; expose as `db.mjs dedup --url <url> [--company <c> --role <r>] --json`

---

## Phase 5: User Story 3 — Script and dashboard migrations

**Story goal**: All downstream scripts read/write DB; no script parses `applications.md` or `pipeline.md` as input.

**Independent test**: Run `node scan.mjs --dry-run` → completes without reading `pipeline.md`. Run `node verify-pipeline.mjs` → outputs health report sourced from DB. Run `node analyze-patterns.mjs` → JSON output matches pre-migration output on same dataset.

> Note: T025 (dedup helper) from US2 is a prerequisite for T026 (scan.mjs migration). All other migration tasks in this phase depend only on Phase 2 (lib/db.mjs) and Phase 3 (db.mjs init).

- [ ] T026 [US3] Migrate `scan.mjs` — replace `loadSeen()` with `isUrlSeen()` + `isCompanyRoleSeen()` from `lib/db.mjs`; replace `appendToPipeline()` with `insertPipelineEntry()`; replace `appendToScanHistory()` with `upsertScanHistory()`; remove all `readFileSync`/`writeFileSync` calls against `pipeline.md` and `scan-history.tsv`
- [ ] T027 [US3] [P] Migrate `merge-tracker.mjs` — replace markdown table parse and `writeFileSync(APPS_FILE)` with `insertApplication()` / `updateApplication()` from `lib/db.mjs`; TSV row parsing logic stays; processed TSV files still move to `merged/`; remove all markdown read/write of `applications.md`
- [ ] T028 [US3] [P] Migrate `verify-pipeline.mjs` — replace `readFileSync(APPS_FILE)` + markdown regex parsing with `listApplications(db, {})` from `lib/db.mjs`; re-implement all 7 checks (canonical status, duplicates, report link existence, score format, row format, pending TSVs, states.yml IDs) against DB rows; remove TSV pending-check or redirect to scan `batch/tracker-additions/`
- [ ] T029 [US3] [P] Migrate `dedup-tracker.mjs` — replace markdown parse with `listApplications(db, {})` from `lib/db.mjs`; apply same company-normalize + fuzzy-role dedup logic; update surviving row via `updateApplication()`; delete duplicates via `deleteApplication()`; remove all markdown file writes
- [ ] T030 [US3] [P] Migrate `normalize-statuses.mjs` — replace markdown parse with `listApplications(db, {})` from `lib/db.mjs`; apply alias → canonical mapping from states.yml; persist each normalized status via `updateApplication(db, id, 'status', canonical)`; remove all markdown file read/writes
- [ ] T031 [US3] [P] Migrate `analyze-patterns.mjs` — replace `readFileSync(APPS_FILE)` + markdown table parse with `listApplications(db, {})` from `lib/db.mjs`; all pattern analysis logic unchanged; JSON stdout output unchanged
- [ ] T032 [US3] [P] Migrate `followup-cadence.mjs` — replace `readFileSync(APPS_FILE)` + markdown parse with `listApplications(db, {statusIn: ['Applied','Responded','Interview']})` from `lib/db.mjs`; cadence logic unchanged; JSON/summary stdout unchanged; `data/follow-ups.md` remains markdown (out of scope)
- [ ] T033 [US3] [P] Migrate `check-liveness.mjs` — no structural change to Playwright logic; add `--update-db` flag: when set, after checking each URL call `updatePipelineEntry(db, url, 'state', result)` from `lib/db.mjs` to write `expired`/`active`/`uncertain` back to `pipeline_entries`
- [ ] T034 [US3] Migrate Go dashboard `dashboard/internal/data/career.go` — replace `ParseApplications()` (markdown regex) with a SQLite query via `modernc.org/sqlite`; open `data/career-ops.db`, run `SELECT * FROM applications ORDER BY num`, map rows to `model.CareerApplication`; remove all markdown regex vars (`reReportLink`, `reScoreValue`, etc.); also update `ParsePipeline()` if it exists or add it using `pipeline_entries` table
- [ ] T035 [US3] Add npm script aliases to `package.json` — add `"db": "node db.mjs"`, `"migrate": "node migrate-to-db.mjs"`, `"db:export": "node db.mjs export"` to `scripts` section

---

## Phase 6: User Story 4 — LLM-generated content store

**Story goal**: Agent can attach and retrieve free-form content per application/pipeline entry using a `tag` string. Cascade delete works.

**Independent test**: `node db.mjs content set application 1 summary --body "Test summary"` → ok; `node db.mjs content get application 1 summary --json` → returns body; delete app 1 → `db.mjs content list application 1` → empty array.

- [ ] T036 [US4] Add `llm_content` CRUD helpers to `lib/db.mjs` — `getLlmContent(db, ownerType, ownerId, tag)`, `listLlmContent(db, ownerType, ownerId)` (returns array with body_preview = first 100 chars), `setLlmContent(db, ownerType, ownerId, tag, body)` (INSERT OR REPLACE; enforce 64 KB cap — throw `BODY_TOO_LARGE` error if `body.length > 65536`), `deleteLlmContent(db, ownerType, ownerId, tag)` (single entry), `deleteLlmContentForOwner(db, ownerType, ownerId)` (all entries — used in cascade delete in T009/T010)
- [ ] T037 [US4] Wire cascade delete into `deleteApplication()` and `deletePipelineEntry()` in `lib/db.mjs` — call `deleteLlmContentForOwner()` before deleting the parent row, in the same transaction; confirm this is idempotent (no error if no content exists)
- [ ] T038 [US4] [P] Implement `db.mjs content list <owner-type> <owner-id>` in `db.mjs` — call `listLlmContent()`, return `[{id, tag, created_at, body_preview}]` JSON
- [ ] T039 [US4] [P] Implement `db.mjs content get <owner-type> <owner-id> <tag>` in `db.mjs` — call `getLlmContent()`, return full `{id, owner_type, owner_id, tag, body, created_at}` JSON; `NOT_FOUND` error if missing
- [ ] T040 [US4] [P] Implement `db.mjs content set <owner-type> <owner-id> <tag> --body <text>` (and `--file <path>`) in `db.mjs` — read body from flag or file, call `setLlmContent()`, return `{status, id, action:"created"|"updated"}`
- [ ] T041 [US4] [P] Implement `db.mjs content delete <owner-type> <owner-id> <tag>` in `db.mjs` — call `deleteLlmContent()`, return `{status, deleted: true|false}`

---

## Phase 7: User Story 5 — One-way migration from markdown

**Story goal**: Existing users can run `node migrate-to-db.mjs` once and have all historical data imported with zero loss. `db.mjs export` regenerates markdown snapshots.

**Independent test**: Copy real `data/applications.md` + `data/pipeline.md` to a temp location; run migration; run `node db.mjs export`; diff exported files against originals — row counts match, column values match.

- [ ] T042 [US5] Create `migrate-to-db.mjs` — entry point with `--dry-run` and `--json` flags; call `openDb()` + `initSchema()` from `lib/db.mjs`; orchestrate parsers below; print summary `{applications_imported, pipeline_imported, scan_history_imported, tsv_batches_imported, errors:[]}`
- [ ] T043 [US5] Implement `applications.md` parser in `migrate-to-db.mjs` — extract row parsing logic from existing `merge-tracker.mjs` (pipe-delimited markdown table rows); map columns to `applications` schema fields; set `cycle_id=1` for all migrated rows; call `insertApplication()` for each row; collect parse errors with `{source, line, message}` without aborting
- [ ] T044 [US5] Implement `pipeline.md` parser in `migrate-to-db.mjs` — parse checkbox lines `- [ ] url | company | title` (and `- [x] ...` for evaluated); map to `pipeline_entries` fields (`state='pending'` for `[ ]`, `state='evaluated'` for `[x]`); call `insertPipelineEntry()` for each
- [ ] T045 [US5] [P] Implement `scan-history.tsv` parser in `migrate-to-db.mjs` — read `data/scan-history.tsv` (if exists), skip header row, map tab-separated columns `url/first_seen/portal/title/company/status` to `scan_history` schema; call `upsertScanHistory()` for each row
- [ ] T046 [US5] [P] Implement pending TSV batch ingest in `migrate-to-db.mjs` — scan `batch/tracker-additions/` for `.tsv` files not in `merged/`; run same TSV-parse path as T043 against each; call `insertApplication()` or `updateApplication()` (if company+role+cycle_id exists); move each processed file to `batch/tracker-additions/merged/`
- [ ] T047 [US5] Add idempotency guard to `migrate-to-db.mjs` — on startup, if `applications` table has rows: print counts and exit with message "DB already contains data. Pass --force to re-run migration (will skip existing rows)"; with `--force`, run import but skip any row that already exists (INSERT OR IGNORE semantics)
- [ ] T048 [US5] Implement `db.mjs export` subcommand in `db.mjs` — query all rows from `applications` ORDER BY num; render as markdown table matching existing `data/applications.md` column format (prepend header comment `<!-- Auto-generated by db.mjs export — do not edit -->`); write to `data/applications.md`; query all pipeline rows; render as checkbox list; write to `data/pipeline.md`; return `{status, files:["data/applications.md","data/pipeline.md"]}`

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Test coverage, documentation, final consistency pass.

- [ ] T049 Extend `test-all.mjs` with DB integration tests — add section "8. SQLite DB checks": (a) `node db.mjs init` exits 0 and creates `data/career-ops.db`; (b) insert application → get by num → fields match; (c) insert duplicate company+role+cycle_id → returns DUPLICATE error; (d) insert with invalid status → returns INVALID_STATUS error; (e) list with `--status Evaluated` → only Evaluated rows returned; (f) `node db.mjs stats --json` → parseable JSON with `applications` key
- [ ] T050 [P] Update `CLAUDE.md` "Main Files" table — add row for `data/career-ops.db` (SQLite database, source of truth for pipeline and applications), add row for `db.mjs` (CLI for agent/script DB access), update `data/applications.md` and `data/pipeline.md` rows to note "(read-only snapshot; regenerated by `db.mjs export`)"
- [ ] T051 [P] Update `CLAUDE.md` "Stack and Conventions" section — add `better-sqlite3` (sync Node.js SQLite driver) and `modernc.org/sqlite` (Go SQLite driver) to the Active Technologies list; add `data/career-ops.db` as user-layer file
- [ ] T052 [P] Verify `update-system.mjs` — confirm the update logic does NOT delete or overwrite anything under `data/`; if it has an explicit file list, add `career-ops.db` to the exclusion list; no change needed if it uses `data/*` glob already

---

## Dependencies

```
Phase 1 (Setup)
  └── Phase 2 (Foundational: lib/db.mjs)
        ├── Phase 3 (US1: db.mjs init + basic CRUD)
        │     ├── Phase 4 (US2: filtering + dedup)   ← T025 needed by T026
        │     │     └── Phase 5 (US3: script migrations)
        │     ├── Phase 6 (US4: llm_content)          ← parallel with US2/US3
        │     └── Phase 7 (US5: migration + export)   ← parallel with US2/US3
        └── Phase 8 (Polish)                          ← after all stories
```

## Parallel Execution Examples

**Within Phase 2 (Foundational)**:
T005 (connection) → T006 (schema) → T007 (status validation) → T008, T009, T010, T011 in parallel

**Within Phase 3 (US1)**:
T012+T013 (init) → T014, T015, T016, T017, T018 in parallel

**Within Phase 5 (US3 — script migrations)**:
T027, T028, T029, T030, T031, T032, T033 all in parallel (different files)
T026 (scan.mjs) must wait for T025 (dedup helper in US2)

**US4 + US5 parallel**:
After Phase 3 completes, Phase 6 (US4) and Phase 7 (US5) can run fully in parallel.

---

## Implementation Strategy

**MVP (minimum viable product)**: Phases 1–3 + T047+T048 from Phase 7.
Delivers: DB initialized, basic insert/get working, migration from markdown, markdown snapshots regenerated. Enough to verify data survives the switch.

**Full delivery order**: Phase 1 → 2 → 3 → 4 → 5 → 6 & 7 (parallel) → 8.

**Suggested starting task**: T001 (install `better-sqlite3`) → T005 (open DB) → T006 (schema). These three unblock everything else.
