---
name: jd-extract
description: Navigate to a job posting URL with Playwright and return the job description as clean Markdown. Use this whenever you need the raw JD content from a URL before evaluation, pipeline processing, or PDF generation.
user_invocable: false
args: url
argument-hint: "https://boards.greenhouse.io/company/jobs/123"
---

# JD Extractor

Extract the job description body from `{{url}}` using Playwright.

## Steps

1. Run:
   ```bash
   node extract-jd.mjs {{url}}
   ```

2. If exit code is 0: the stdout is the job description in clean Markdown. Return it as-is.

3. If exit code is 1: read stderr. Surface the error message to the caller exactly as written. Do not attempt to recover — let the caller decide the fallback strategy (WebFetch, manual paste, etc.).

## Output Contract

- stdout: clean Markdown text, no frontmatter, no metadata — just the JD body
- stderr: `ERROR: <reason>` on failure (page load timeout / no job description found / network error)
