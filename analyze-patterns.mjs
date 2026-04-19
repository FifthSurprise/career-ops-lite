#!/usr/bin/env node
/**
 * analyze-patterns.mjs — Rejection Pattern Detector for career-ops
 *
 * Reads from SQLite DB + linked report files, extracts dimensions
 * (archetype, seniority, remote, gaps, scores), classifies outcomes,
 * and outputs structured JSON with actionable patterns.
 *
 * Run: node analyze-patterns.mjs          (JSON to stdout)
 *      node analyze-patterns.mjs --summary (human-readable table)
 *      node analyze-patterns.mjs --min-threshold 3
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { openDb, initSchema, listApplications } from './lib/db.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(CAREER_OPS, 'reports');

const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const minThresholdIdx = args.indexOf('--min-threshold');
const MIN_THRESHOLD = minThresholdIdx !== -1 && args[minThresholdIdx + 1] !== undefined
  ? (Number.isNaN(parseInt(args[minThresholdIdx + 1])) ? 5 : parseInt(args[minThresholdIdx + 1]))
  : 5;

const ALIASES = {
  'evaluada': 'evaluated', 'condicional': 'evaluated', 'hold': 'evaluated',
  'evaluar': 'evaluated', 'verificar': 'evaluated',
  'aplicado': 'applied', 'enviada': 'applied', 'aplicada': 'applied',
  'applied': 'applied', 'sent': 'applied',
  'respondido': 'responded',
  'entrevista': 'interview',
  'oferta': 'offer',
  'rechazado': 'rejected', 'rechazada': 'rejected',
  'descartado': 'discarded', 'descartada': 'discarded',
  'cerrada': 'discarded', 'cancelada': 'discarded',
  'no aplicar': 'skip', 'no_aplicar': 'skip', 'monitor': 'skip', 'geo blocker': 'skip',
};

function normalizeStatus(raw) {
  const clean = (raw || '').replace(/\*\*/g, '').trim().toLowerCase()
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  return ALIASES[clean] || clean;
}

function classifyOutcome(status) {
  const s = normalizeStatus(status);
  if (['interview', 'offer', 'responded', 'applied'].includes(s)) return 'positive';
  if (['rejected', 'discarded'].includes(s)) return 'negative';
  if (['skip'].includes(s)) return 'self_filtered';
  return 'pending';
}

function parseReport(reportPath) {
  if (!existsSync(reportPath)) return null;
  const content = readFileSync(reportPath, 'utf-8');
  const report = { archetype: null, seniority: null, remote: null, teamSize: null, comp: null, domain: null, scores: {}, gaps: [] };
  const plain = content.replace(/\*\*/g, '');

  const m = (re) => { const x = plain.match(re); return x ? x[1].trim() : null; };

  report.archetype = m(/\|\s*(?:Archetype|Arquetipo)\s*\|\s*(.*?)\s*\|/i);
  report.seniority = m(/\|\s*(?:Seniority|Nivel|Level)\s*\|\s*(.*?)\s*\|/i);
  report.remote = m(/\|\s*(?:Remote|Remoto|Location)\s*\|\s*(.*?)\s*\|/i);
  report.teamSize = m(/\|\s*(?:Team|Team size|Equipo)\s*\|\s*(.*?)\s*\|/i);
  report.comp = m(/\|\s*(?:Comp|Salary|Salario|Listed salary)\s*\|\s*(.*?)\s*\|/i);
  report.domain = m(/\|\s*(?:Domain|Dominio|Industry)\s*\|\s*(.*?)\s*\|/i);

  const s = (re, key) => { const x = plain.match(re); if (x) report.scores[key] = parseFloat(x[1]); };
  s(/\|\s*(?:CV Match|Match con CV)\s*\|\s*([\d.]+)\/5\s*\|/i, 'cvMatch');
  s(/\|\s*(?:North Star)\s*\|\s*([\d.]+)\/5\s*\|/i, 'northStar');
  s(/\|\s*(?:Comp)\s*\|\s*([\d.]+)\/5\s*\|/i, 'comp');
  s(/\|\s*(?:Cultural signals|Cultural)\s*\|\s*([\d.]+)\/5\s*\|/i, 'cultural');
  s(/\|\s*(?:Red flags)\s*\|\s*([-+]?[\d.]+)\s*\|/i, 'redFlags');
  s(/\|\s*(?:Global)\s*\|\s*([\d.]+)\/5\s*\|/i, 'global');

  const gapMatch = content.match(/\|\s*Gap\s*\|\s*Severity\s*\|.*?\n\|[-|\s]+\n([\s\S]*?)(?:\n\n|\n##|\n\*\*|$)/i);
  if (gapMatch) {
    for (const row of gapMatch[1].split('\n').filter(r => r.startsWith('|'))) {
      const cols = row.split('|').map(s => s.trim()).filter(Boolean);
      if (cols.length >= 2) report.gaps.push({ description: cols[0], severity: cols[1].toLowerCase(), mitigation: cols[2] || '' });
    }
  }

  return report;
}

function classifyRemote(raw) {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase();
  if (/\b(us[- ]?only|canada[- ]?only|residents only|usa only|us residents|canada residents)\b/.test(lower)) return 'geo-restricted';
  if (/\bargentina\s+remote\s+only\b/.test(lower)) return 'geo-restricted';
  if (/\b(hybrid|on-?site|office|columbus|cape town|relocat)\b/.test(lower)) return 'hybrid/onsite';
  if (/\b(global|anywhere|worldwide|no restrict|70\+|work from anywhere)\b/.test(lower)) return 'global remote';
  if (/\b(remote|latam|americas|brazil|fully remote)\b/.test(lower)) return 'regional remote';
  return 'unknown';
}

function classifyCompanySize(teamSize) {
  if (!teamSize) return 'unknown';
  const lower = teamSize.toLowerCase();
  const nums = lower.match(/[\d,]+/g);
  if (nums) {
    const max = Math.max(...nums.map(n => parseInt(n.replace(/,/g, ''))));
    if (max <= 50) return 'startup';
    if (max <= 500) return 'scaleup';
    return 'enterprise';
  }
  if (/\b(small|elite|tiny|founding)\b/.test(lower)) return 'startup';
  if (/\b(large|enterprise|global)\b/.test(lower)) return 'enterprise';
  return 'unknown';
}

function extractBlockerType(gap) {
  const desc = gap.description.toLowerCase();
  const sev = gap.severity.toLowerCase();
  if (sev.includes('nice') || sev.includes('soft')) return null;
  if (/\b(residency|us[- ]only|canada|location|visa|geo|country|region)\b/.test(desc)) return 'geo-restriction';
  if (/\b(javascript|typescript|python|ruby|java|go|rust|node|react|angular|vue|django|flask|rails)\b/.test(desc)) return 'stack-mismatch';
  if (/\b(senior|staff|lead|principal|director|manager|head)\b/.test(desc)) return 'seniority-mismatch';
  if (/\b(hybrid|on-?site|office|relocat)\b/.test(desc)) return 'onsite-requirement';
  return 'other';
}

function analyze() {
  const db = openDb();
  initSchema(db);
  const entries = listApplications(db, {});

  if (entries.length === 0) return { error: 'No applications found in DB.' };

  const enriched = entries.map(e => {
    const reportPath = e.report_path ? join(CAREER_OPS, e.report_path) : null;
    const reportData = reportPath ? parseReport(reportPath) : null;
    const outcome = classifyOutcome(e.status);
    const score = e.score ?? 0;
    const remoteSource = reportData?.remote || e.notes || '';
    const teamSource = reportData?.teamSize || '';

    return {
      ...e,
      normalizedStatus: normalizeStatus(e.status),
      outcome,
      score,
      report: reportData,
      remoteBucket: classifyRemote(remoteSource),
      companySize: classifyCompanySize(teamSource),
    };
  });

  const beyondEvaluated = enriched.filter(e => e.normalizedStatus !== 'evaluated');
  if (beyondEvaluated.length < MIN_THRESHOLD) {
    return {
      error: `Not enough data: ${beyondEvaluated.length}/${MIN_THRESHOLD} applications beyond "Evaluated". Keep applying and come back later.`,
      current: beyondEvaluated.length,
      threshold: MIN_THRESHOLD,
    };
  }

  const funnel = {};
  for (const e of enriched) { const s = e.normalizedStatus; funnel[s] = (funnel[s] || 0) + 1; }

  const scoresByOutcome = { positive: [], negative: [], self_filtered: [], pending: [] };
  for (const e of enriched) { if (e.score > 0) scoresByOutcome[e.outcome].push(e.score); }

  const scoreStats = (arr) => {
    if (arr.length === 0) return { avg: 0, min: 0, max: 0, count: 0 };
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    return { avg: Math.round(avg * 100) / 100, min: Math.min(...arr), max: Math.max(...arr), count: arr.length };
  };

  const scoreComparison = {
    positive: scoreStats(scoresByOutcome.positive),
    negative: scoreStats(scoresByOutcome.negative),
    self_filtered: scoreStats(scoresByOutcome.self_filtered),
    pending: scoreStats(scoresByOutcome.pending),
  };

  const archetypeMap = new Map();
  for (const e of enriched) {
    const arch = e.report?.archetype || 'Unknown';
    if (!archetypeMap.has(arch)) archetypeMap.set(arch, { total: 0, positive: 0, negative: 0, self_filtered: 0, pending: 0 });
    const entry = archetypeMap.get(arch);
    entry.total++; entry[e.outcome]++;
  }
  const archetypeBreakdown = [...archetypeMap.entries()].map(([archetype, data]) => ({
    archetype, ...data, conversionRate: data.total > 0 ? Math.round((data.positive / data.total) * 100) : 0,
  })).sort((a, b) => b.total - a.total);

  const blockerCounts = new Map();
  for (const e of enriched) {
    if (!e.report?.gaps) continue;
    for (const gap of e.report.gaps) {
      const type = extractBlockerType(gap);
      if (!type) continue;
      blockerCounts.set(type, (blockerCounts.get(type) || 0) + 1);
    }
  }
  const blockerAnalysis = [...blockerCounts.entries()]
    .map(([blocker, frequency]) => ({ blocker, frequency, percentage: Math.round((frequency / enriched.length) * 100) }))
    .sort((a, b) => b.frequency - a.frequency);

  const remoteMap = new Map();
  for (const e of enriched) {
    const policy = e.remoteBucket;
    if (!remoteMap.has(policy)) remoteMap.set(policy, { total: 0, positive: 0, negative: 0, self_filtered: 0, pending: 0 });
    const entry = remoteMap.get(policy); entry.total++; entry[e.outcome]++;
  }
  const remotePolicy = [...remoteMap.entries()].map(([policy, data]) => ({
    policy, ...data, conversionRate: data.total > 0 ? Math.round((data.positive / data.total) * 100) : 0,
  })).sort((a, b) => b.total - a.total);

  const sizeMap = new Map();
  for (const e of enriched) {
    const size = e.companySize;
    if (!sizeMap.has(size)) sizeMap.set(size, { total: 0, positive: 0, negative: 0, self_filtered: 0, pending: 0 });
    const entry = sizeMap.get(size); entry.total++; entry[e.outcome]++;
  }
  const companySizeBreakdown = [...sizeMap.entries()].map(([size, data]) => ({
    size, ...data, conversionRate: data.total > 0 ? Math.round((data.positive / data.total) * 100) : 0,
  })).sort((a, b) => b.total - a.total);

  const positiveScores = scoresByOutcome.positive.filter(s => s > 0);
  const minPositiveScore = positiveScores.length > 0 ? Math.min(...positiveScores) : 0;
  const scoreThreshold = {
    recommended: minPositiveScore > 0 ? Math.floor(minPositiveScore * 10) / 10 : 3.5,
    reasoning: positiveScores.length > 0
      ? `Lowest score among positive outcomes is ${minPositiveScore}.`
      : 'Not enough positive outcome data to determine threshold.',
    positiveRange: positiveScores.length > 0 ? `${Math.min(...positiveScores)} - ${Math.max(...positiveScores)}` : 'N/A',
  };

  const stackGapCounts = new Map();
  for (const e of enriched) {
    if (e.outcome !== 'negative' && e.outcome !== 'self_filtered') continue;
    if (!e.report?.gaps) continue;
    for (const gap of e.report.gaps) {
      const techs = gap.description.match(/\b(JavaScript|TypeScript|Python|Ruby|Java|Go|Rust|Node\.?js|React|Angular|Vue\.?js|Django|Flask|Rails|PHP|Laravel|Symfony|Kotlin|Swift|C\+\+|C#|\.NET|MongoDB|MySQL|PostgreSQL|Redis|GraphQL|REST|AWS|GCP|Azure|Docker|Kubernetes|Terraform|Supabase|Inngest|React Native)\b/gi);
      if (techs) for (const tech of techs) {
        const t = tech.charAt(0).toUpperCase() + tech.slice(1);
        stackGapCounts.set(t, (stackGapCounts.get(t) || 0) + 1);
      }
    }
  }
  const techStackGaps = [...stackGapCounts.entries()]
    .map(([skill, frequency]) => ({ skill, frequency }))
    .sort((a, b) => b.frequency - a.frequency).slice(0, 15);

  const recommendations = [];
  const geoBlocker = blockerAnalysis.find(b => b.blocker === 'geo-restriction');
  if (geoBlocker && geoBlocker.percentage >= 20) {
    recommendations.push({ action: `Tighten location filters in portals.yml -- ${geoBlocker.percentage}% geo-restriction`, reasoning: `${geoBlocker.frequency} of ${enriched.length} offers are location-restricted.`, impact: 'high' });
  }
  const stackBlocker = blockerAnalysis.find(b => b.blocker === 'stack-mismatch');
  if (stackBlocker && stackBlocker.percentage >= 15) {
    const topGaps = techStackGaps.slice(0, 3).map(g => g.skill).join(', ');
    recommendations.push({ action: `Filter out roles requiring ${topGaps} -- ${stackBlocker.percentage}% stack mismatch`, reasoning: `Core stack gaps (${topGaps}) are the most common blockers.`, impact: 'high' });
  }
  if (minPositiveScore > 3.0) {
    recommendations.push({ action: `Set minimum score threshold at ${scoreThreshold.recommended}/5`, reasoning: `No positive outcomes below ${minPositiveScore}/5.`, impact: 'medium' });
  }
  const bestArchetype = archetypeBreakdown.filter(a => a.total >= 2).sort((a, b) => b.conversionRate - a.conversionRate)[0];
  if (bestArchetype && bestArchetype.conversionRate > 0) {
    recommendations.push({ action: `Double down on "${bestArchetype.archetype}" roles (${bestArchetype.conversionRate}% conversion)`, reasoning: `${bestArchetype.positive} of ${bestArchetype.total} in this archetype led to positive outcomes.`, impact: 'medium' });
  }
  const worstRemote = remotePolicy.filter(r => r.total >= 2 && r.conversionRate === 0)[0];
  if (worstRemote) {
    recommendations.push({ action: `Avoid "${worstRemote.policy}" roles (0% conversion across ${worstRemote.total})`, reasoning: `None of the ${worstRemote.total} applications with this policy led to progress.`, impact: 'medium' });
  }

  const dates = enriched.map(e => e.date).filter(Boolean).sort();

  return {
    metadata: {
      total: enriched.length,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      analysisDate: new Date().toISOString().split('T')[0],
      byOutcome: {
        positive: enriched.filter(e => e.outcome === 'positive').length,
        negative: enriched.filter(e => e.outcome === 'negative').length,
        self_filtered: enriched.filter(e => e.outcome === 'self_filtered').length,
        pending: enriched.filter(e => e.outcome === 'pending').length,
      },
    },
    funnel, scoreComparison, archetypeBreakdown, blockerAnalysis, remotePolicy,
    companySizeBreakdown, scoreThreshold, techStackGaps, recommendations,
  };
}

function printSummary(result) {
  if (result.error) { console.log(`\n${result.error}\n`); return; }
  const { metadata, funnel, scoreComparison, archetypeBreakdown, blockerAnalysis, remotePolicy, scoreThreshold, techStackGaps, recommendations } = result;
  console.log(`\n${'='.repeat(60)}\n  Pattern Analysis — ${metadata.analysisDate}\n  ${metadata.total} applications\n${'='.repeat(60)}\n`);
  console.log('CONVERSION FUNNEL\n' + '-'.repeat(40));
  for (const s of ['evaluated', 'applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'skip']) {
    if (funnel[s]) { const pct = Math.round((funnel[s] / metadata.total) * 100); console.log(`  ${s.padEnd(15)} ${String(funnel[s]).padStart(3)} (${pct}%)`); }
  }
  console.log('\nSCORE BY OUTCOME\n' + '-'.repeat(40));
  for (const [group, stats] of Object.entries(scoreComparison)) {
    if (stats.count > 0) console.log(`  ${group.padEnd(15)} avg ${stats.avg}/5  (${stats.count} entries)`);
  }
  if (blockerAnalysis.length > 0) {
    console.log('\nTOP BLOCKERS\n' + '-'.repeat(40));
    for (const b of blockerAnalysis) console.log(`  ${b.blocker.padEnd(20)} ${String(b.frequency).padStart(2)}x (${b.percentage}%)`);
  }
  console.log('\nREMOTE POLICY\n' + '-'.repeat(40));
  for (const r of remotePolicy) console.log(`  ${r.policy.padEnd(20)} ${String(r.total).padStart(2)} total, ${r.positive} positive (${r.conversionRate}%)`);
  if (techStackGaps.length > 0) {
    console.log('\nTOP TECH STACK GAPS\n' + '-'.repeat(40));
    for (const g of techStackGaps.slice(0, 10)) console.log(`  ${g.skill.padEnd(20)} ${g.frequency}x`);
  }
  console.log(`\nSCORE THRESHOLD: ${scoreThreshold.recommended}/5\n  ${scoreThreshold.reasoning}`);
  if (recommendations.length > 0) {
    console.log('\nRECOMMENDATIONS\n' + '='.repeat(60));
    recommendations.forEach((r, i) => { console.log(`  ${i + 1}. [${r.impact.toUpperCase()}] ${r.action}\n     ${r.reasoning}`); });
  }
  console.log('');
}

const result = analyze();
if (summaryMode) printSummary(result);
else console.log(JSON.stringify(result, null, 2));
if (result.error) process.exit(1);
