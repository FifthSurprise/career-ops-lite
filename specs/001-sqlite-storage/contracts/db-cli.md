# Contract: db.mjs CLI

**Branch**: `001-sqlite-storage` | **Date**: 2026-04-18

## Overview

`db.mjs` is the canonical interface between all scripts, the AI agent, and the
SQLite database. Every read and write to `data/career-ops.db` goes through
this script. No script (including the agent) may open the DB file directly.

All subcommands accept `--json` for machine-readable output. Without `--json`,
output is human-readable (table or summary). Exit code `0` = success,
`1` = error (message on stderr).

---

## Global Options

```
--json        Output JSON instead of human-readable text
--db <path>   Override DB path (default: data/career-ops.db)
--dry-run     Print what would happen without writing
```

---

## Subcommand: `init`

Initialize the database schema. Safe to re-run (CREATE TABLE IF NOT EXISTS).

```
node db.mjs init
```

Output (--json):
```json
{ "status": "ok", "tables_created": ["applications", "pipeline_entries", "llm_content", "scan_history"] }
```

---

## Subcommand: `stats`

Return counts grouped by status and pipeline state.

```
node db.mjs stats [--json]
```

Output (--json):
```json
{
  "applications": {
    "total": 42,
    "by_status": { "Evaluated": 10, "Applied": 15, "Rejected": 12, "Offer": 1, "Discarded": 4 }
  },
  "pipeline": {
    "total": 18,
    "by_state": { "pending": 5, "evaluated": 10, "skipped": 3 }
  }
}
```

---

## Subcommand: `list applications`

```
node db.mjs list applications [options] [--json]

Options:
  --status <s>         Filter by canonical status (case-insensitive)
  --status-in <a,b,c>  Filter by multiple statuses (comma-separated)
  --company <s>        Filter by company name (case-insensitive LIKE %s%)
  --role <s>           Filter by role (case-insensitive LIKE %s%)
  --score-min <n>      Filter by score >= n
  --score-max <n>      Filter by score <= n
  --days <n>           Filter to records where date >= today - n days
  --cycle-id <n>       Filter by cycle_id (default: all)
  --limit <n>          Limit results (default: 100)
  --offset <n>         Pagination offset
```

Output (--json):
```json
[
  {
    "id": 1, "num": 1, "date": "2026-01-15", "company": "Acme",
    "role": "Head of AI", "cycle_id": 1, "status": "Applied",
    "score": 4.2, "pdf": true, "report_path": "reports/001-acme-2026-01-15.md",
    "url": "https://...", "legitimacy": "Tier 1 – Legitimate", "notes": ""
  }
]
```

---

## Subcommand: `get application`

```
node db.mjs get application <id|num> [--json]
```

`id` = internal DB id, `num` = user-visible sequential number. If the value
is ≤ 9999 and matches both, `num` takes precedence. Use `--id` flag to force
internal id lookup.

Output: single application object (same shape as `list`), or error JSON if not found.

---

## Subcommand: `insert application`

```
node db.mjs insert application --data '<json>'
```

`--data` accepts a JSON object with any subset of application fields. Required
fields: `date`, `company`, `role`, `status`. `num` auto-assigned if omitted.

Output (--json):
```json
{ "status": "ok", "id": 43, "num": 43 }
```

Error on duplicate `(company, role, cycle_id)`:
```json
{ "status": "error", "code": "DUPLICATE", "message": "Application for Acme + Head of AI (cycle 1) already exists. Use a different cycle_id to re-apply." }
```

---

## Subcommand: `update application`

```
node db.mjs update application <id> --field <name> --value <value> [--json]
```

Updates a single field on an existing application. `status` updates are
validated against `templates/states.yml`.

Output:
```json
{ "status": "ok", "id": 43, "field": "status", "value": "Applied" }
```

---

## Subcommand: `delete application`

```
node db.mjs delete application <id> [--json]
```

Deletes application and all its `llm_content` rows (in a transaction).
Asks for confirmation unless `--force` is passed.

Output:
```json
{ "status": "ok", "deleted_id": 43 }
```

---

## Subcommand: `list pipeline`

```
node db.mjs list pipeline [--state <s>] [--company <s>] [--days <n>] [--json]
```

Output (--json): array of pipeline entry objects.

---

## Subcommand: `get pipeline`

```
node db.mjs get pipeline <id|url> [--json]
```

---

## Subcommand: `insert pipeline`

```
node db.mjs insert pipeline --url <url> [--source <s>] [--state <s>] [--company <s>] [--title <s>] [--json]
```

Output:
```json
{ "status": "ok", "id": 18 }
```

Duplicate URL returns:
```json
{ "status": "error", "code": "DUPLICATE_URL", "message": "URL already exists in pipeline (id=12, state=pending)." }
```

---

## Subcommand: `update pipeline`

```
node db.mjs update pipeline <id|url> --field <name> --value <value> [--json]
```

---

## Subcommand: `delete pipeline`

```
node db.mjs delete pipeline <id|url> [--force] [--json]
```

Deletes pipeline entry and its `llm_content` rows.

---

## Subcommand: `content list`

```
node db.mjs content list <owner-type> <owner-id> [--json]
```

`owner-type`: `application` or `pipeline_entry`.

Output (--json):
```json
[
  { "id": 5, "tag": "summary", "created_at": "2026-01-15T10:00:00Z", "body_preview": "This role is..." },
  { "id": 6, "tag": "cover_letter_draft", "created_at": "2026-01-16T08:30:00Z", "body_preview": "Dear Hiring..." }
]
```

---

## Subcommand: `content get`

```
node db.mjs content get <owner-type> <owner-id> <tag> [--json]
```

Returns full body. Error if not found.

Output (--json):
```json
{ "id": 5, "owner_type": "application", "owner_id": 43, "tag": "summary", "body": "...", "created_at": "..." }
```

---

## Subcommand: `content set`

```
node db.mjs content set <owner-type> <owner-id> <tag> --body '<text>' [--json]
node db.mjs content set <owner-type> <owner-id> <tag> --file <path> [--json]
```

Upsert semantics: creates or replaces. Body capped at 64 KB.

Output:
```json
{ "status": "ok", "id": 5, "action": "created|updated" }
```

---

## Subcommand: `content delete`

```
node db.mjs content delete <owner-type> <owner-id> <tag> [--json]
```

---

## Subcommand: `export`

```
node db.mjs export [--applications] [--pipeline] [--json]
```

Regenerates `data/applications.md` and/or `data/pipeline.md` as read-only
markdown snapshots from the DB. Default: both. These files are never written
by any other script after migration.

Output:
```json
{ "status": "ok", "files": ["data/applications.md", "data/pipeline.md"] }
```

---

## Subcommand: `migrate`

```
node db.mjs migrate [--dry-run] [--json]
```

One-shot import from `data/applications.md`, `data/pipeline.md`, and
`data/scan-history.tsv`. Also processes any pending
`batch/tracker-additions/*.tsv` files. Idempotent: re-running on a
non-empty DB prints counts and exits without duplicating rows.

Output:
```json
{
  "status": "ok",
  "applications_imported": 42,
  "pipeline_imported": 18,
  "scan_history_imported": 310,
  "tsv_batches_imported": 2,
  "errors": []
}
```

Malformed rows are logged under `"errors"` with `{ "source": "...", "line": N, "message": "..." }` but do not abort the migration.

---

## Error Response Shape

All errors return JSON (when `--json`) with:

```json
{ "status": "error", "code": "ERROR_CODE", "message": "Human-readable description." }
```

Common error codes: `DUPLICATE`, `DUPLICATE_URL`, `INVALID_STATUS`,
`INVALID_SCORE`, `BODY_TOO_LARGE`, `NOT_FOUND`, `DB_ERROR`.
