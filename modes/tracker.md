# Mode: tracker — Application Tracker

## Workflow

Run:

```bash
node db.mjs stats --json
```

This returns all aggregate numbers without loading the tracker into context:

```json
{
  "applications": {
    "total": N,
    "by_status": { "Evaluated": N, "Applied": N, ... },
    "avg_score": 4.12,
    "with_pdf": N,
    "with_pdf_pct": N,
    "with_report": N,
    "with_report_pct": N,
    "next_num": N
  },
  "pipeline": { "total": N, "by_state": { ... } }
}
```

Display the numbers as a compact dashboard to the user. Only run `node db.mjs list applications --json` if the user asks for a specific row, filter, or range — never load the full list just to show totals.

## Updating status

If the user asks to change a status (e.g. "mark #14 as Applied"), use:

```bash
node db.mjs update application <id> --field status --value Applied --json
```

Use the `id` (not `num`) — `list applications` returns both. Valid statuses: `Evaluated`, `Applied`, `Responded`, `Interview`, `Offer`, `Rejected`, `Discarded`, `SKIP`.

- `Applied` — candidate sent application
- `Responded` — recruiter reached out, candidate responded
- `Interview` / `Offer` — downstream stages
