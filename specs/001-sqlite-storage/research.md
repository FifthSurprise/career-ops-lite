# Research: SQLite Storage for Pipeline and Applications

**Branch**: `001-sqlite-storage` | **Date**: 2026-04-18

## Decision 1: Node.js SQLite Driver

**Decision**: `better-sqlite3`

**Rationale**: All existing `.mjs` scripts are synchronous (they use
`readFileSync`, `writeFileSync`, never `await`). `better-sqlite3` exposes a
fully synchronous API (`.prepare().get()`, `.run()`, `.all()`) that plugs in
with zero async/await refactoring. It is the fastest Node.js SQLite binding,
widely maintained, and ships prebuilt binaries for macOS and Linux.

`node:sqlite` (built-in, Node v22.5+) would avoid a dependency but its API
is still async-first in v25 and it lacks the `.prepare()` statement caching
that `better-sqlite3` provides. `sql.js` is WASM-based (larger binary,
slower, no persistence). `node-sqlite3` (the original `sqlite3` package) is
callback-based — requires promisification everywhere.

**Alternatives considered**:

| Driver | Verdict | Reason rejected |
|--------|---------|----------------|
| `node:sqlite` (built-in) | Rejected | Async API conflicts with sync script style |
| `node-sqlite3` | Rejected | Callback-based; requires full async refactor |
| `sql.js` | Rejected | WASM; no persistent file; large binary |

---

## Decision 2: Go SQLite Driver for Dashboard

**Decision**: `modernc.org/sqlite`

**Rationale**: `modernc.org/sqlite` is a pure-Go port of SQLite — no CGO
required. The existing dashboard compiles cleanly on CI without a C toolchain.
Adding `mattn/go-sqlite3` (the most popular CGO binding) would require `CGO_ENABLED=1`
and a C compiler in every build environment (GitHub Actions, contributor
machines). `modernc.org/sqlite` avoids this friction while providing full SQL
compatibility with the same DB file.

**Alternatives considered**:

| Driver | Verdict | Reason rejected |
|--------|---------|----------------|
| `mattn/go-sqlite3` | Rejected | Requires CGO + C compiler in all build envs |
| `zombiezen.com/go/sqlite` | Deferred | Newer API; less ecosystem documentation; would work if modernc has issues |

---

## Decision 3: Scan History — Fold into DB

**Decision**: Migrate `data/scan-history.tsv` into a `scan_history` table.

**Rationale**: `scan.mjs` already reads both `scan-history.tsv` and
`pipeline.md`/`applications.md` for dedup. Once pipeline and applications
are in the DB, keeping a separate TSV for scan history is an inconsistency:
the DB and the TSV can drift. A `scan_history` table gives the same O(1)
URL lookup (`WHERE url = ?`), eliminates the separate file, and lets the DB
be the single store for all job-search data.

**Alternatives considered**:

| Option | Verdict | Reason rejected |
|--------|---------|----------------|
| Keep TSV as-is | Rejected | Creates two stores to keep in sync; drift risk |
| Remove scan history entirely (rely on DB tables) | Rejected | Scan history records entries that were seen but not added to pipeline (e.g., filtered); these need their own table |

---

## Decision 4: SQLite Journal Mode

**Decision**: WAL (Write-Ahead Logging), set at DB open time.

**Rationale**: Batch workers run as parallel `claude -p` processes. Under the
default DELETE journal mode, a write lock on the DB blocks all other readers
and writers — concurrent batch inserts get `SQLITE_BUSY` errors. WAL mode
allows one writer and unlimited concurrent readers simultaneously. The tradeoff
(two extra files: `-wal` and `-shm`) is acceptable for a local project DB.

**Applied at**: `lib/db.mjs` `PRAGMA journal_mode=WAL` on every connection open.

---

## Decision 5: DB File Location and Name

**Decision**: `db/career-ops.db`

**Rationale**: The `data/` directory is already established as the User Layer
data directory. Placing the DB there (a) keeps it alongside existing user files,
(b) makes `git`-ignore or backup coverage easy, and (c) is consistent with
`data/applications.md` and `data/pipeline.md` which it replaces.

The file is not gitignored by default — same policy as `data/applications.md`
(users may choose to commit it). A note in `quickstart.md` explains the tradeoff.

---

## Decision 6: `DATA_CONTRACT.md` Update Required

**Finding**: `DATA_CONTRACT.md` currently lists `data/*` as User Layer but does
not name `career-ops.db` explicitly. The update-system script needs to know not
to delete or reset anything in `data/`. The existing `data/*` glob already covers
this, so no change to `update-system.mjs` logic is needed — only a clarifying line
added to `DATA_CONTRACT.md`.

---

## Deferred Decisions (to planning phase — now resolved)

- `scan-history.tsv`: fold into DB. Resolved above.
- DB driver choices: resolved above.
- WAL mode: resolved above.
