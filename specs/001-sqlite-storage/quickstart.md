# Quickstart: SQLite Storage Migration

**Branch**: `001-sqlite-storage` | **Date**: 2026-04-18

## What changed

`data/applications.md` and `data/pipeline.md` are no longer the source of
truth. All job-search data now lives in `db/career-ops.db` (SQLite3). The
markdown files are regenerated on demand by `db.mjs export` and should be
treated as read-only.

---

## Fresh install (no prior data)

```bash
# Install new dependency
npm install

# Initialize the database (creates db/career-ops.db)
node db.mjs init
```

The system is ready. Subsequent scans, evaluations, and batch jobs will write
to the DB automatically.

---

## Upgrade (existing data in markdown)

Run the one-shot migration. Your original markdown files are untouched; the DB
is populated from them.

```bash
npm install

# Preview what will be imported (no writes)
node migrate-to-db.mjs --dry-run

# Import
node migrate-to-db.mjs
```

After migration, verify the DB state:

```bash
node db.mjs stats
node verify-pipeline.mjs   # now reads from DB; check for warnings
```

---

## Using the agent after migration

The agent no longer needs to read `applications.md` or `pipeline.md` directly.
Use `db.mjs` queries instead:

```bash
# How many applications by status?
node db.mjs stats --json

# What is Applied but not yet Responded?
node db.mjs list applications --status Applied --json

# Show everything from the last 30 days
node db.mjs list applications --days 30 --json

# Look up a specific application
node db.mjs get application 42 --json

# Check if a company+role is already tracked
node db.mjs list applications --company Acme --role "Head of AI" --json
```

---

## Attaching LLM-generated content

```bash
# Store a JD summary on application id=42
node db.mjs content set application 42 summary --body "This role focuses on..."

# Retrieve it later
node db.mjs content get application 42 summary --json

# List all content for an application
node db.mjs content list application 42 --json
```

---

## Regenerating markdown snapshots

```bash
node db.mjs export
# Writes data/applications.md and data/pipeline.md as read-only snapshots
```

Run this if you need to inspect data as markdown or share a snapshot. Do
not edit the generated files — changes will be overwritten on the next export.

---

## Backup and git

`db/career-ops.db` is user-layer data — treat it like `data/applications.md`
was. Options:

- **Commit it**: convenient, but binary diffs are not human-readable. Suitable
  for personal repos. Add `.gitattributes` entry: `db/career-ops.db binary`.
- **Gitignore it + backup separately**: add to `.gitignore` and rely on
  filesystem backup. Regenerate markdown snapshots before any commit for a
  human-readable history.

Recommended: commit `db/career-ops.db` and also run `node db.mjs export`
before each commit so `data/applications.md` provides a readable diff.

---

## Rollback

If something goes wrong, your original markdown files were not deleted during
migration (only the DB was created). To revert to markdown:

1. Delete `db/career-ops.db`
2. Roll back this branch (`git checkout main`)
3. Your `data/applications.md` and `data/pipeline.md` are intact

---

## Dashboard

The Go dashboard reads from `db/career-ops.db` automatically after this
migration. Rebuild it once:

```bash
cd dashboard && go build -o career-ops-dashboard .
```

No config change needed — it discovers the DB at the same relative path it
previously used for `applications.md`.
