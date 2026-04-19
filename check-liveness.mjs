#!/usr/bin/env node

/**
 * check-liveness.mjs — Playwright job link liveness checker
 *
 * Tests whether job posting URLs are still active or have expired.
 * Uses the same detection logic as scan.md step 7.5.
 * Zero Claude API tokens — pure Playwright.
 *
 * Usage:
 *   node check-liveness.mjs <url1> [url2] ...
 *   node check-liveness.mjs --file urls.txt
 *
 * Exit code: 0 if all active, 1 if any expired or uncertain
 */

import { chromium } from 'playwright';
import { readFile } from 'fs/promises';
import { classifyLiveness } from './liveness-core.mjs';
import { openDb, initSchema, getPipelineEntryByUrl, updatePipelineEntry } from './lib/db.mjs';

async function checkUrl(page, url) {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const status = response?.status() ?? 0;

    // Give SPAs (Ashby, Lever, Workday) time to hydrate
    await page.waitForTimeout(2000);

    const finalUrl = page.url();

    // Grab main content only — avoids nav/footer noise and reduces payload ~10×
    const bodyText = await page.evaluate(() => {
      const main = document.querySelector('[role="main"], main, article, #content, .job-description, .job-posting');
      return (main ?? document.body)?.innerText ?? '';
    });

    // Scan for apply controls within main content only
    const applyControls = await page.evaluate(() => {
      const scope = document.querySelector('[role="main"], main, article, .job-description') ?? document.body;
      return Array.from(scope.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]'))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !el.closest('[aria-hidden="true"]');
        })
        .map((el) => [el.innerText, el.value, el.getAttribute('aria-label'), el.getAttribute('title')]
          .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 20);
    });

    return classifyLiveness({ status, finalUrl, bodyText, applyControls });

  } catch (err) {
    return { result: 'expired', reason: `navigation error: ${err.message.split('\n')[0]}` };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const updateDb = args.includes('--update-db');
  const filteredArgs = args.filter(a => a !== '--update-db');

  if (filteredArgs.length === 0) {
    console.error('Usage: node check-liveness.mjs <url1> [url2] ...');
    console.error('       node check-liveness.mjs --file urls.txt');
    console.error('       node check-liveness.mjs --update-db <url1> ...  # write result to DB pipeline_entries');
    process.exit(1);
  }

  let urls;
  if (filteredArgs[0] === '--file') {
    const text = await readFile(filteredArgs[1], 'utf-8');
    urls = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } else {
    urls = filteredArgs;
  }

  let db = null;
  if (updateDb) {
    db = openDb();
    initSchema(db);
  }

  console.log(`Checking ${urls.length} URL(s)...\n`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let active = 0, expired = 0, uncertain = 0;

  // Sequential — project rule: never Playwright in parallel
  for (const url of urls) {
    const { result, reason } = await checkUrl(page, url);
    const icon = { active: '✅', expired: '❌', uncertain: '⚠️' }[result];
    console.log(`${icon} ${result.padEnd(10)} ${url}`);
    if (result !== 'active') console.log(`           ${reason}`);
    if (result === 'active') active++;
    else if (result === 'expired') expired++;
    else uncertain++;

    if (db) {
      const entry = getPipelineEntryByUrl(db, url);
      if (entry) {
        const newState = result === 'active' ? 'active' : result === 'expired' ? 'expired' : 'uncertain';
        updatePipelineEntry(db, entry.id, 'state', newState);
      }
    }
  }

  await browser.close();

  console.log(`\nResults: ${active} active  ${expired} expired  ${uncertain} uncertain`);
  if (expired > 0 || uncertain > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
