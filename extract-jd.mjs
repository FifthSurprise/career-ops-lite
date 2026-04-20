#!/usr/bin/env node

/**
 * extract-jd.mjs — Playwright job description extractor
 *
 * Navigates to a job posting URL, finds the JD body, outputs clean Markdown.
 * Zero Claude API tokens — pure Playwright.
 *
 * Usage:
 *   node extract-jd.mjs <url>
 *
 * Output: clean Markdown on stdout
 * Errors: stderr + exit 1
 */

import { chromium } from 'playwright';

const url = process.argv[2];

if (!url) {
  console.error('Usage: node extract-jd.mjs <url>');
  process.exit(1);
}

// Ordered by specificity — ATS-specific selectors win over generic semantic ones
const JD_SELECTORS = [
  '[data-testid*="job-description"]',
  '[data-automation*="job-description"]',
  '.job-description',
  '.posting-description',
  '.job-desc',
  '.job-details-description',
  '#job-description',
  '#jobDescription',
  '#job-details',
  '[class*="jobDescription"]',
  '[class*="job-description"]',
  'article',
  '[role="main"]',
  'main',
];

function htmlToMarkdown(html) {
  return html
    // Strip unwanted blocks entirely
    .replace(/<(script|style|nav|header|footer|aside|form|button|svg|img|iframe)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*(class|id)="[^"]*(?:apply|cta|social|share|footer|nav|sidebar)[^"]*"[^>]*>[\s\S]*?<\/\w+>/gi, '')
    // Headings
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n')
    .replace(/<h[456][^>]*>([\s\S]*?)<\/h[456]>/gi, '\n\n#### $1\n\n')
    // Inline formatting
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '_$2_')
    // Links — keep text only
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    // List items
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    // Block elements → blank line separators
    .replace(/<\/(p|div|section|ul|ol|blockquote)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Clean up list items (remove nested HTML noise)
    .replace(/^- +\*\*([\s\S]*?)\*\*$/gm, '- **$1**')
    // Normalize whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Give SPAs (Ashby, Lever, Workday) time to hydrate
    await page.waitForTimeout(2500);

    // Find the first selector that returns a sizeable element
    let html = null;
    for (const selector of JD_SELECTORS) {
      try {
        const el = page.locator(selector).first();
        const count = await el.count();
        if (!count) continue;
        const text = await el.innerText().catch(() => '');
        if (text.trim().length < 100) continue;
        html = await el.innerHTML();
        break;
      } catch (_) {
        continue;
      }
    }

    if (!html) {
      console.error('ERROR: no job description found');
      process.exit(1);
    }

    console.log(htmlToMarkdown(html));

  } catch (err) {
    if (err.message.includes('Timeout') || err.message.includes('timeout')) {
      console.error('ERROR: page load timeout');
    } else {
      console.error(`ERROR: ${err.message.split('\n')[0]}`);
    }
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
