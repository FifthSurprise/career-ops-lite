# Feature Specification: SQLite Storage for Pipeline and Applications

**Feature Branch**: `001-sqlite-storage`
**Created**: 2026-04-18
**Status**: Draft
**Input**: User description: "Implement use of sqlite3 database and corresponding API.  This database should store the pipeline and application contents instead of storing the values in markdown.  It should have some way for Claude to access its contents.  There should be a database field to store whatever content an llm wants to generate.  But otherwise, it will prevent excessive token usage and allow database features such as filtering out jds that have been applied or not."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Replace markdown tracker and pipeline with a queryable datastore (Priority: P1)

Today the job pipeline lives in `data/pipeline.md` and the application tracker
lives in `data/applications.md`. These files grow unbounded, consume large
numbers of tokens on every read, and cannot be filtered without scanning the
whole file. The user wants every pipeline entry and every application record
persisted in a structured datastore so the system can be queried by status,
score, date, company, or role without loading the entire history into the
agent's context.

**Why this priority**: This is the core reason for the feature. Without
structured persistence, every other benefit (filtering, token savings,
machine-to-machine access) is impossible. Shipping just this story already
delivers a viable MVP: a database that holds the data plus the ingestion
path that puts data into it.

**Independent Test**: Ingest an existing `pipeline.md` and `applications.md`
into the datastore, then retrieve one pipeline URL and one application record
by primary key. Values round-trip without loss.

**Acceptance Scenarios**:

1. **Given** the existing `data/applications.md` with N rows, **When** the
   migration is run, **Then** the datastore contains exactly N application
   records with every canonical column (number, date, company, role, status,
   score, pdf flag, report path, notes, URL, legitimacy) preserved.
2. **Given** the existing `data/pipeline.md` with M URLs and states, **When**
   the migration is run, **Then** the datastore contains M pipeline entries
   with URL, source, state, and any reference to a local JD file preserved.
3. **Given** a fresh install with no prior markdown, **When** the datastore
   is initialized, **Then** empty but schema-valid tables exist and the
   system functions with no data.

---

### User Story 2 - Filter and dedup job postings via structured queries (Priority: P1)

The user wants to answer questions like "what offers have I evaluated but not
yet applied to?", "which applications are older than 14 days with no
response?", "have I already applied to company X for role Y?", and "show me
everything rejected in the last month" without reading the whole tracker file.
The datastore must support these as cheap queries that return only the
matching rows.

**Why this priority**: Filtering is the user's explicit second motivation
("allow database features such as filtering out jds that have been applied
or not"). It is what converts a dumb store into a useful tool and is the
direct unlock for follow-up cadence, pattern analysis, and dedup on scan.

**Independent Test**: Seed the datastore with a known mix of statuses, then
query for a specific status + age window. Verify that the returned rows match
the seeded expectation and that rows outside the filter are excluded.

**Acceptance Scenarios**:

1. **Given** a pipeline entry whose `company + role` already exists as an
   application, **When** the scanner considers adding it, **Then** it can
   detect the duplicate without scanning any markdown and skip the entry.
2. **Given** 20 applications with mixed statuses, **When** the user asks
   for "Evaluated but not Applied", **Then** only rows where status equals
   `Evaluated` are returned and none with status `Applied`, `Rejected`, or
   `Discarded` appear.
3. **Given** applications spanning many dates, **When** the user asks for
   the last 7 days' activity, **Then** only rows whose date falls in that
   window are returned.

---

### User Story 3 - Agent and scripts access the datastore through a defined interface (Priority: P1)

Both the AI agent and the existing `.mjs` scripts (scan, batch, merge,
liveness, followup, patterns, dashboard) need to read and write records
without opening raw markdown. The agent specifically needs a lightweight way
to query small result sets (counts, single rows, narrow filters) instead of
reading `applications.md` in full on every session — that is where the token
savings come from.

**Why this priority**: Without a defined access path, the data is stranded.
The agent must be able to pull exactly what it needs, and scripts must have
a stable contract to read and write against.

**Independent Test**: From a fresh agent session, run a single query for
"applications with status = Offer" and confirm only that narrow result set
is returned — not the entire tracker. Separately, run a script that inserts
a new pipeline URL and another session sees it without reloading any file.

**Acceptance Scenarios**:

1. **Given** the datastore has 500 applications, **When** the agent asks for
   the count of applications with status `Rejected`, **Then** it receives a
   single number back without having to load every row into context.
2. **Given** the scanner discovers a new URL, **When** it calls the write
   interface to enqueue the URL, **Then** the record is persisted atomically
   and a subsequent read returns it.
3. **Given** concurrent batch workers, **When** they each insert evaluation
   results, **Then** no inserts are lost and no writer corrupts another's
   row.

---

### User Story 4 - Free-form LLM-generated content per record (Priority: P2)

For any given application or pipeline entry, the agent sometimes generates
material that is not a report: scratch notes, drafted outreach messages,
research snippets, interview prep one-liners, negotiation angles. Today these
either bloat the tracker row's `notes` column or get written to ad-hoc files.
The user wants a designated place per record to attach arbitrary
LLM-generated content, so the agent can stash things like "cached summary of
this JD" or "draft cover letter" and retrieve them later by tag without
re-paying the token cost to regenerate.

**Why this priority**: Nice-to-have for MVP — the system works without it —
but it directly supports the token-economy goal by letting the agent reuse
its own prior work across sessions. Higher than P3 because the user called
it out explicitly.

**Independent Test**: Attach a generated summary to one application record,
close the session, reopen, and retrieve the same summary by record ID.

**Acceptance Scenarios**:

1. **Given** an application record, **When** the agent writes a tagged
   piece of content (e.g., `tag=summary`, body = free text) against that
   record, **Then** the content is retrievable by `(record, tag)` on a
   later session.
2. **Given** multiple pieces of generated content for one record, **When**
   the agent lists them, **Then** it sees each one with its tag, creation
   timestamp, and body.
3. **Given** a record is removed, **When** the record is deleted, **Then**
   its attached LLM content is removed with it (no orphans).

---

### User Story 5 - One-way migration from existing markdown files (Priority: P2)

Users upgrading to this feature already have months of data in
`data/pipeline.md` and `data/applications.md`. A migration routine must read
those files and load every row into the datastore without loss or
duplication, and without the user having to hand-edit their data.

**Why this priority**: Every existing user hits this on first upgrade. If
migration is broken, adoption is blocked. Lower than P1 only because the
datastore itself (US1) must exist first.

**Independent Test**: Take a copy of a real `applications.md` and
`pipeline.md`, run the migration against an empty datastore, then diff the
datastore's exported view against the originals. Row counts match; column
values match.

**Acceptance Scenarios**:

1. **Given** a user with existing markdown data, **When** migration is run,
   **Then** every row is imported and the original markdown files are left
   untouched (or backed up to a clearly named sidecar).
2. **Given** migration is run a second time, **When** the datastore already
   has content, **Then** the migration either skips or reconciles without
   producing duplicate rows.
3. **Given** a malformed row in the source markdown, **When** migration
   encounters it, **Then** the error is surfaced clearly with file + line
   reference and the remaining rows still import.

---

### Edge Cases

- Multiple applications for the same `company + role` over different periods
  (e.g., reapplying after a year): uniqueness is per `(company, role, cycle_id)`.
  The user provides a new `cycle_id` to open a fresh application cycle. The
  scanner's dedup check MUST check active cycles only (same cycle_id as default
  or current) to avoid false positives against old cycles.
- Pipeline URLs that were never evaluated (aged out, scored SKIP, removed):
  state transitions must be first-class so the scanner's dedup-history and
  the tracker's application rows stay consistent.
- Two processes writing at once (batch worker + interactive agent): writes
  must not corrupt each other. The store must tolerate concurrent inserts.
- An LLM content field accidentally filled with megabytes of text: there
  must be a practical size cap and a clear error when exceeded, rather than
  silent truncation.
- A user running the system offline: the datastore must be local-first with
  no network dependency.
- Downstream scripts that currently parse markdown (`merge-tracker.mjs`,
  `verify-pipeline.mjs`, `dedup-tracker.mjs`, `analyze-patterns.mjs`,
  `followup-cadence.mjs`, `check-liveness.mjs`, dashboard) are ALL
  in-scope for this feature and MUST be migrated to read and write the
  datastore directly. After migration, none of these scripts may parse
  `applications.md` or `pipeline.md` as a source of truth.

## Clarifications

### Session 2026-04-18

- Q: How should the datastore detect a duplicate application vs allow a legitimate re-application? → A: Explicit `cycle_id` column; uniqueness enforced on `(company, role, cycle_id)`. A new application to the same company+role requires the user to set a different cycle_id. The agent MUST surface a warning when inserting a duplicate within the same cycle rather than silently overwriting.
- Q: What form should the agent-facing API surface take? → A: Set of `.mjs` CLI scripts with subcommands (e.g., `db.mjs list --status Evaluated --json`, `db.mjs get --id 42`). Consistent with existing project tooling pattern.
- Q: What happens to `applications.md` and `pipeline.md` after cutover? → A: Both retained as auto-regenerated, read-only snapshots. A `db.mjs export` command regenerates them on demand. Neither is a source of truth; no script writes to or parses them as input after migration.
- Q: Should pipeline entry states be a canonical DB-enforced enum or convention only? → A: Convention only — documented but not DB-enforced. Any string accepted; canonical values (`pending`, `evaluated`, `skipped`, `applied`, `expired`) are documented in spec and code comments.
- Q: Should the LLM content discriminator field be an enum or free-form, and what should it be called? → A: Open free-form string (any value accepted, no validation). Field name is `tag` (not `kind`, `type`, or `category`).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST persist every pipeline entry (URL, source
  portal, state, local JD reference if any, discovery timestamp) in a
  structured, queryable datastore.
- **FR-002**: The system MUST persist every application record with all
  canonical tracker columns (sequential number, date, company, role,
  status, score, pdf flag, report path, notes, URL, legitimacy tier).
- **FR-003**: The system MUST enforce canonical status values matching
  `templates/states.yml` (`Evaluated`, `Applied`, `Responded`,
  `Interview`, `Offer`, `Rejected`, `Discarded`, `SKIP`). Inserts or
  updates with a non-canonical status MUST be rejected.
- **FR-004**: The system MUST enforce a uniqueness constraint on
  `(company, role, cycle_id)`. Inserting a second application with the
  same `(company, role, cycle_id)` MUST be rejected with a clear error.
  To re-apply to the same company+role, the user MUST provide a different
  `cycle_id`. The agent MUST warn the user when a duplicate within the
  same cycle is attempted. `cycle_id` defaults to `1` for new records
  and MUST be surfaced in the read interface so users can see which cycle
  each application belongs to.
- **FR-005**: The system MUST support filtering applications by status,
  score range, date range, company, and role through a defined interface
  that returns only matching rows.
- **FR-006**: The system MUST let the scanner test "does any application
  already exist for this company+role" as a single lookup, without loading
  unrelated records.
- **FR-007**: The system MUST expose a read interface usable by the AI
  agent that returns narrow result sets (single rows, counts, filtered
  lists) so the agent does not need to load `applications.md` or
  `pipeline.md` in full for routine questions.
- **FR-008**: The system MUST expose a write interface usable by scripts
  and the agent for creating, updating, and deleting pipeline entries and
  application records.
- **FR-009**: The system MUST provide a dedicated, per-record collection
  for free-form LLM-generated content. Each entry carries a `tag`
  (open free-form string, any value accepted), a body, and a creation
  timestamp.
- **FR-010**: The system MUST allow multiple pieces of LLM content per
  record (e.g., `summary`, `draft_cover_letter`, `outreach_first_touch`
  side by side) and MUST let the agent retrieve them selectively by `tag`.
- **FR-011**: The system MUST cascade deletion: removing a pipeline entry
  or application record MUST remove its attached LLM content.
- **FR-012**: The system MUST be local-first, require no network, and
  store the datastore file inside the project so it can be backed up
  with normal file tools.
- **FR-013**: The system MUST provide a one-time migration that imports
  existing `data/pipeline.md` and `data/applications.md` into the
  datastore without loss, and MUST be safe to re-run (idempotent or
  clearly blocked on non-empty store).
- **FR-014**: The system MUST preserve the User-Layer guarantee: the
  datastore file is treated as user data and MUST NOT be overwritten by
  system updates. (See project DATA_CONTRACT.)
- **FR-015**: The system MUST surface errors on malformed input
  (bad status, bad score format, missing URL) with a clear message
  identifying the offending record, rather than writing partial data.
- **FR-016**: The system MUST tolerate concurrent writes from multiple
  processes (e.g., batch workers) without data loss or corruption.
- **FR-017**: The system MUST provide a way to enumerate "applications
  where status is in {X, Y, Z}" so the follow-up, patterns, and
  dashboard workflows can be rebuilt on top of it.
- **FR-018**: The system MUST expose a `db.mjs` CLI script with
  named subcommands (e.g., `list`, `get`, `query`, `insert`, `update`,
  `delete`) that return JSON on stdout and accept filter parameters
  on argv. This is the canonical interface for both the AI agent and
  internal scripts. All subcommands MUST support a `--json` flag for
  machine-readable output. The agent accesses the datastore exclusively
  through this script — no raw SQL or direct file access.
- **FR-019**: All existing downstream scripts MUST be migrated to
  read and write the datastore instead of parsing
  `applications.md` or `pipeline.md`. In scope:
  `merge-tracker.mjs`, `verify-pipeline.mjs`, `dedup-tracker.mjs`,
  `normalize-statuses.mjs`, `analyze-patterns.mjs`,
  `followup-cadence.mjs`, `check-liveness.mjs`, `scan.mjs`,
  the batch ingest path (`batch/tracker-additions/*.tsv` +
  `merge-tracker.mjs`), and the dashboard.
- **FR-020**: After this feature ships, `data/applications.md` and
  `data/pipeline.md` MUST NOT be treated as a source of truth by
  any script or the agent. Both MUST be retained as auto-generated,
  read-only snapshots regenerated by `db.mjs export`. They MUST NOT
  be written to or parsed as input by any script or agent after
  migration.

### Key Entities

- **Pipeline Entry**: A candidate URL under consideration. Attributes
  include source (portal or manual), URL, discovery timestamp, current
  state (free-form string; conventional values: `pending`, `evaluated`,
  `skipped`, `applied`, `expired`), optional local JD file reference,
  and link to its resulting Application record if one was created.
  Pipeline states are not DB-enforced; the conventional values are
  documented in code but any string is accepted.
- **Application**: A tracked job application. Attributes include
  sequential number (monotonic within the user's history), date,
  company, role, status (canonical), score (decimal, 0.0–5.0),
  URL, report path, legitimacy tier, pdf-generated flag, notes,
  and `cycle_id` (positive integer, default 1). Uniqueness is
  enforced on `(company, role, cycle_id)`. One Application MAY
  originate from one Pipeline Entry.
- **LLM Content**: Free-form machine-generated material attached to
  either a Pipeline Entry or an Application. Attributes include owner
  reference, `tag` (open free-form string, e.g., `summary`,
  `cover_letter_draft`, `negotiation_angle`), body (text), and
  created-at timestamp. Deleted when its owner is deleted.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Answering routine pipeline questions ("have I applied to
  X?", "show me Evaluated-not-Applied", "count of Rejected last month")
  uses less than 5% of the input tokens that the equivalent question
  against the current full-markdown files uses.
- **SC-002**: The scanner can check "is this URL or `company+role`
  already known?" in under 100 ms on a dataset of 10,000 records,
  without reading `applications.md` or `pipeline.md` in whole.
- **SC-003**: 100% of rows from an existing `applications.md` and
  `pipeline.md` migrate into the datastore on first upgrade with
  zero data loss (verified by a round-trip diff).
- **SC-004**: From the moment the datastore is the source of truth,
  zero new entries are written directly into `applications.md` or
  `pipeline.md` by scripts or the agent. Both files are only ever
  produced by `db.mjs export`.
- **SC-007**: Every listed downstream script (`merge-tracker`,
  `verify-pipeline`, `dedup-tracker`, `normalize-statuses`,
  `analyze-patterns`, `followup-cadence`, `check-liveness`,
  `scan`, batch ingest, dashboard) runs against the datastore and
  produces outputs functionally equivalent to its pre-migration
  behavior, verified by a before/after comparison on the same
  dataset.
- **SC-005**: The agent can retrieve any previously generated piece
  of LLM content for a record in a later session without regenerating
  it, eliminating duplicate generation cost for the same artifact.
- **SC-006**: A fresh install (no prior data) reaches a working,
  queryable datastore in under 60 seconds from running setup.

## Assumptions

- The user explicitly named SQLite3 as the storage technology. The
  functional behavior above is technology-agnostic, but the chosen
  implementation is SQLite for its local-first, zero-admin, file-based
  properties.
- The agent-facing API is a `db.mjs` CLI script with subcommands,
  returning JSON on stdout. MCP server surface is out of scope for
  this feature.
- The datastore file lives under the existing `data/` directory and
  is treated as User Layer data (not auto-updated by system
  upgrades; backed up by the user's normal git or filesystem
  workflow).
- Existing reports in `reports/*.md` remain markdown. Only
  `applications.md` and `pipeline.md` are in scope for migration.
- `templates/states.yml` remains the source of truth for canonical
  statuses; the datastore enforces what that file declares.
- The `data/scan-history.tsv` dedup store for the scanner MAY remain
  as-is or be folded into the datastore; this decision is left to
  the planning phase.
- Concurrent writers are expected (batch workers + interactive
  agent), but write volume is low (dozens per minute at peak), so
  a single-writer-at-a-time serialization is acceptable.
- The LLM content field has a practical per-entry size cap (e.g.,
  on the order of 64 KB) enforced at the interface layer.

## Dependencies

- Existing User Layer contract in `DATA_CONTRACT.md` (the datastore
  file must be covered by it).
- Canonical state list in `templates/states.yml`.
- Existing `.mjs` script conventions for any new CLI/API surface.
