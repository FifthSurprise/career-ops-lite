#!/usr/bin/env node
import fs from 'fs';
import readline from 'readline';
import path from 'path';

const pipelineFile = 'data/pipeline.md';

async function getInput(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function addJobToPipeline(url, company, role, location, source) {
  const content = fs.readFileSync(pipelineFile, 'utf-8');
  const lines = content.split('\n');

  // Find the line after "## Pending"
  const pendingIndex = lines.findIndex((line) => line === '## Pending');
  if (pendingIndex === -1) {
    console.error('Error: Could not find "## Pending" section in pipeline.md');
    process.exit(1);
  }

  // Insert after "## Pending" and blank line if present
  let insertIndex = pendingIndex + 1;
  if (lines[insertIndex] === '') {
    insertIndex = pendingIndex + 2;
  }

  // Format: - [ ] {url} | {company} | {role} | {location} | {source}
  const newEntry = `- [ ] ${url} | ${company} | ${role} | ${location} | ${source}`;

  lines.splice(insertIndex, 0, newEntry);

  fs.writeFileSync(pipelineFile, lines.join('\n'), 'utf-8');
  console.log('✅ Job added to pipeline');
  console.log(`   ${company} — ${role}`);
}

async function main() {
  if (process.argv.length >= 7) {
    // Command-line args: node add-pipeline.mjs <url> <company> <role> <location> <source>
    const [, , url, company, role, location, source] = process.argv;
    addJobToPipeline(url, company, role, location, source);
  } else {
    // Interactive mode
    console.log('Add job to pipeline\n');
    const url = await getInput('URL: ');
    const company = await getInput('Company: ');
    const role = await getInput('Role: ');
    const location = await getInput('Location: ');
    const source = await getInput('Source: ');

    if (!url || !company || !role) {
      console.error('Error: URL, Company, and Role are required');
      process.exit(1);
    }

    addJobToPipeline(url, company, role, location || 'N/A', source || 'manual');
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
