# Mode: pipeline — URL Inbox (Second Brain)

Processes offer URLs accumulated in the database's pipeline. The user adds URLs whenever they want (or via `node scan.mjs`) and then runs `/career-ops pipeline` to process them all.

## Workflow

1. **Read** pipeline using `node db.mjs list pipeline --state pending --json`
2. **For each pending URL**:
   a. Get next sequential `REPORT_NUM` with `node db.mjs next-num --json` (returns `{"next": N}`)
   b. **Extract JD** using Playwright (browser_navigate + browser_snapshot) → WebFetch → WebSearch
   c. If the URL is not accessible → set state to skipped via `node db.mjs update pipeline <id> --field state --value skipped --quiet` with a note and continue
   d. **Run complete auto-pipeline**: Evaluation A-F → Report .md → PDF (if score >= 3.0) → Tracker (via `node db.mjs insert application --data '...' --quiet`)
   e. **Update pipeline state**: `node db.mjs update pipeline <id> --field state --value evaluated --quiet` and `node db.mjs update pipeline <id> --field application_id --value <app_id> --quiet` (if relevant)
3. **If 3+ pending URLs**, launch agents in parallel (Agent tool with `run_in_background`) to maximize speed.
4. **When done**, show summary table:

```
| # | Company | Role | Score | PDF | Recommended action |
```

## Pipeline States

- **pending**: Ready to be processed
- **evaluated**: Successfully evaluated and added to applications
- **skipped**: Could not be processed (login required, error, etc)
- **applied**: Manually updated after applying

## Intelligent JD detection from URL

1. **Playwright (preferred):** `browser_navigate` to load, then `browser_evaluate` to extract main content:
   ```js
   const main = document.querySelector('[role="main"], main, article, .job-description');
   return (main ?? document.body)?.innerText ?? '';
   ```
   Scoping to `[role="main"]` avoids nav/footer boilerplate and reduces snapshot size ~10×. For SPAs that need an accessibility-tree view, use `browser_snapshot` instead.
2. **WebFetch (fallback):** For static pages or when Playwright is not available.
3. **WebSearch (last resort):** Search on secondary portals that index the JD.

**Special cases:**
- **LinkedIn**: May require login → mark `[!]` and ask user to paste the text
- **PDF**: If URL points to a PDF, read it directly with Read tool
- **`local:` prefix**: Read the local file. Example: `local:jds/linkedin-pm-ai.md` → read `jds/linkedin-pm-ai.md`

## Automatic numbering

Run `node db.mjs next-num --json` — it returns `{"next": N}` based on `MAX(num)+1` in the applications table. Do NOT list the `reports/` directory manually.

## Source synchronization

Before processing any URL, verify sync:
```bash
node cv-sync-check.mjs
```
If out of sync, warn the user before continuing.
