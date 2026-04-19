# Data Model: SQLite Storage for Pipeline and Applications

**Branch**: `001-sqlite-storage` | **Date**: 2026-04-18

## Overview

Four tables. `applications` and `pipeline_entries` replace the markdown files.
`llm_content` stores per-record generated artifacts. `scan_history` replaces
`data/scan-history.tsv`. All DDL lives in `lib/db.mjs` and is run once on first
`db.mjs init` (or auto-applied if the DB file does not exist).

---

## Table: `applications`

Replaces `data/applications.md`.

```sql
CREATE TABLE IF NOT EXISTS applications (
  id           INTEGER PRIMARY KEY,
  num          INTEGER NOT NULL,           -- user-visible sequential number
  date         TEXT    NOT NULL,           -- YYYY-MM-DD
  company      TEXT    NOT NULL,
  role         TEXT    NOT NULL,
  cycle_id     INTEGER NOT NULL DEFAULT 1, -- re-application discriminator
  status       TEXT    NOT NULL,           -- canonical (enforced by app layer)
  score        REAL,                       -- 0.0–5.0, NULL if not scored
  pdf          INTEGER NOT NULL DEFAULT 0, -- 0 = false, 1 = true
  report_path  TEXT,                       -- relative path, e.g. reports/001-…md
  url          TEXT,
  legitimacy   TEXT,                       -- e.g. "Tier 1 – Legitimate"
  notes        TEXT,
  UNIQUE(company, role, cycle_id)
);
CREATE INDEX IF NOT EXISTS idx_applications_status   ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_date     ON applications(date);
CREATE INDEX IF NOT EXISTS idx_applications_company  ON applications(company);
CREATE INDEX IF NOT EXISTS idx_applications_num      ON applications(num);
```

### Status validation

Enforced in `lib/db.mjs` at write time by comparing against
`templates/states.yml` at startup. The DB does not use a SQL CHECK constraint
because `states.yml` is the agreed source of truth (easier to extend
without a schema migration).

### Uniqueness rule

`UNIQUE(company, role, cycle_id)` — see Clarification Q1. Default `cycle_id=1`.
The agent surfaces a clear error on conflict: "Application for {company} +
{role} (cycle {cycle_id}) already exists. Use a different cycle_id to
re-apply."

### `num` assignment

`num` is set by the caller (`db.mjs insert application`) as `MAX(num) + 1`
within a transaction. It is not auto-incremented by the DB so it stays
consistent with the user-visible 3-digit numbering convention.

---

## Table: `pipeline_entries`

Replaces `data/pipeline.md`.

```sql
CREATE TABLE IF NOT EXISTS pipeline_entries (
  id              INTEGER PRIMARY KEY,
  url             TEXT    NOT NULL UNIQUE,
  source          TEXT,                     -- portal name or 'manual'
  state           TEXT    NOT NULL DEFAULT 'pending',  -- conventional (not enforced)
  title           TEXT,
  company         TEXT,
  local_jd        TEXT,                     -- path to local JD file, e.g. jds/foo.md
  discovered_at   TEXT    NOT NULL,         -- ISO date YYYY-MM-DD
  application_id  INTEGER REFERENCES applications(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pipeline_state   ON pipeline_entries(state);
CREATE INDEX IF NOT EXISTS idx_pipeline_company ON pipeline_entries(company);
```

### Conventional pipeline states

Not DB-enforced. Documented values: `pending`, `evaluated`, `skipped`,
`applied`, `expired`. Any string is accepted (per Clarification Q4).

### Relationship to `applications`

`pipeline_entries.application_id` links an evaluated pipeline URL to its
resulting application row. `NULL` means the URL was seen but not yet evaluated
or was skipped.

---

## Table: `llm_content`

Stores free-form machine-generated artifacts per application or pipeline entry.

```sql
CREATE TABLE IF NOT EXISTS llm_content (
  id          INTEGER PRIMARY KEY,
  owner_type  TEXT    NOT NULL CHECK(owner_type IN ('application', 'pipeline_entry')),
  owner_id    INTEGER NOT NULL,
  tag         TEXT    NOT NULL,   -- open free-form string (per Clarification Q5)
  body        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,   -- ISO datetime YYYY-MM-DDTHH:MM:SSZ
  UNIQUE(owner_type, owner_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_llm_content_owner ON llm_content(owner_type, owner_id);
```

### Tag semantics

`tag` is a free-form string. Well-known values (not enforced):
`summary`, `cover_letter_draft`, `outreach_first_touch`, `negotiation_angle`,
`interview_prep_notes`, `jd_cache`. Callers choose their own tags freely.

### Size cap

The `db.mjs content set` command enforces a 64 KB body limit at the
application layer (not in SQL). Exceeds limit → clear error, no write.

### Cascade delete

`ON DELETE CASCADE` is not declared in SQL because SQLite requires
`PRAGMA foreign_keys = ON` per connection. Instead, `lib/db.mjs` deletes
`llm_content` rows in a transaction before deleting the parent row. This is
explicit and auditable.

### UNIQUE(owner_type, owner_id, tag)

Upsert semantics: `db.mjs content set` replaces the body if the
`(owner_type, owner_id, tag)` key already exists (INSERT OR REPLACE).

---

## Table: `scan_history`

Replaces `data/scan-history.tsv`. Records every URL the scanner has ever seen,
including those filtered out before reaching the pipeline.

```sql
CREATE TABLE IF NOT EXISTS scan_history (
  url          TEXT    NOT NULL PRIMARY KEY,
  first_seen   TEXT    NOT NULL,   -- ISO date YYYY-MM-DD
  portal       TEXT,               -- Greenhouse, Ashby, Lever, manual
  title        TEXT,
  company      TEXT,
  status       TEXT    NOT NULL DEFAULT 'added'  -- 'added', 'filtered', 'duplicate'
);
```

### Scanner dedup

`scan.mjs` checks `WHERE url = ?` across `scan_history`, `pipeline_entries`,
and `applications` (by URL). Finding any match means "already seen". Adding a
new URL = INSERT into both `scan_history` and `pipeline_entries`.

---

## State Transitions

### Pipeline Entry states (conventional)

```
[discovered] → pending
pending      → evaluated   (agent ran evaluation, created application row)
pending      → skipped     (agent decided not worth evaluating)
pending      → expired     (check-liveness found posting closed)
evaluated    → applied     (application submitted)
```

### Application statuses (canonical, from states.yml)

```
Evaluated → Applied → Responded → Interview → Offer
Evaluated → SKIP
Applied   → Rejected
Applied   → Discarded
Responded → Rejected
Interview → Offer
Interview → Rejected
```

---

## Entity Relationships

```
pipeline_entries ─────────────── applications
  (0 or 1 pipeline_entries        (one application may link back
   may produce 1 application)      to its originating pipeline entry)

applications ──────┐
                   ├── llm_content (owner_type='application')
pipeline_entries ──┘
                      (owner_type='pipeline_entry')
```

---

## Migration Mapping

| Old source | Old format | New table | Notes |
|------------|------------|-----------|-------|
| `data/applications.md` | Markdown table rows | `applications` | `cycle_id=1` for all migrated rows |
| `data/pipeline.md` | `- [ ] url \| company \| title` checkboxes | `pipeline_entries` | state inferred from checkbox (`[ ]`=pending, `[x]`=evaluated) |
| `data/scan-history.tsv` | TSV: url, first_seen, portal, title, company, status | `scan_history` | Direct column mapping |
| `batch/tracker-additions/*.tsv` | 9-column TSV | `applications` (via insert) | Migration runs merge logic before importing; TSV files moved to `batch/tracker-additions/merged/` after import |
