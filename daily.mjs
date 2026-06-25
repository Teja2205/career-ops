#!/usr/bin/env node
/**
 * daily.mjs — One-command daily job-search driver. ZERO Claude tokens.
 *
 * Your morning routine in a single command:
 *   1. scan      → node scan.mjs (zero-token ATS/board discovery → pipeline.md)
 *   2. prescreen → free model (Qwen/OpenRouter/Ollama) scores each NEW pending
 *                  URL via prescreen.mjs (zero Claude tokens)
 *   3. report    → writes data/daily-YYYY-MM-DD.md: a ranked doc of today's
 *                  matches with score + 1-line reason, so you read ONE doc and
 *                  decide where to spend your scarce Claude quota.
 *
 * The expensive Claude full-evaluation only happens later, on the handful you
 * pick from the daily doc (via /career-ops pipeline or oferta).
 *
 * Usage:
 *   node daily.mjs                 # scan + prescreen new offers + write daily doc
 *   node daily.mjs --no-scan       # skip scanning; just prescreen current pending URLs
 *   node daily.mjs --no-verify     # skip Playwright liveness check (verify is ON by default)
 *   node daily.mjs --scan-verify   # explicit alias for the default verify behavior
 *   node daily.mjs --limit 40      # cap how many new URLs to prescreen (default 50)
 *   node daily.mjs --min 4.0       # "apply" threshold highlighted in the doc (default 4.0)
 *   node daily.mjs --concurrency 3 # parallel prescreen workers (default 3)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');

// ── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const noScan = args.includes('--no-scan');
// Liveness verification is ON by default for the daily run — a daily doc full of
// dead postings wastes the reader's time. `--scan-verify` is kept as an explicit
// alias; `--no-verify` opts out (e.g. unattended runs with no display for Chromium).
const scanVerify = !args.includes('--no-verify');
function flagVal(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
const limit = parseInt(flagVal('--limit', '50'), 10);
const minScore = parseFloat(flagVal('--min', '4.0'));
const concurrency = Math.max(1, parseInt(flagVal('--concurrency', '3'), 10));

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`daily.mjs — one-command zero-Claude-token daily job driver

  node daily.mjs [--no-scan] [--no-verify] [--limit N] [--min X.X] [--concurrency N]

Steps: scan (free) → prescreen new URLs with free model (free) → write data/daily-DATE.md
Configure the free model in config/profile.yml under models.prescreen.
`);
  process.exit(0);
}

// ── Subprocess helper ─────────────────────────────────────────────────────────
function run(cmd, cmdArgs, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: ROOT,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let out = '';
    let err = '';
    if (capture) {
      child.stdout.on('data', d => (out += d));
      child.stderr.on('data', d => (err += d));
    }
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', (e) => resolve({ code: 1, out, err: e.message }));
  });
}

// ── Parse pending URLs from pipeline.md ────────────────────────────────────────
// Returns [{ url, company, role }] for unchecked `- [ ]` lines.
function parsePending() {
  if (!existsSync(PIPELINE_PATH)) return [];
  const text = readFileSync(PIPELINE_PATH, 'utf8');
  const pending = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^- \[ \]\s+(https?:\/\/\S+)(?:\s*\|\s*(.+))?$/);
    if (!m) continue;
    const url = m[1];
    let company = '';
    let role = '';
    if (m[2]) {
      const parts = m[2].split('|').map(s => s.trim());
      company = parts[0] || '';
      role = parts[1] || '';
    }
    pending.push({ url, company, role });
  }
  return pending;
}

// ── Bounded-concurrency prescreen ──────────────────────────────────────────────
async function prescreenAll(items) {
  const results = [];
  let idx = 0;
  let done = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const item = items[i];
      const { out } = await run(process.execPath, [join(ROOT, 'prescreen.mjs'), item.url, '--json'], { capture: true });
      let parsed = null;
      const lastLine = out.trim().split('\n').filter(Boolean).pop();
      try { parsed = lastLine ? JSON.parse(lastLine) : null; } catch { parsed = null; }
      results.push({
        ...item,
        score: parsed?.score ?? null,
        archetype: parsed?.archetype ?? 'unknown',
        reason: parsed?.reason ?? 'prescreen failed',
        hard_blocks: parsed?.hard_blocks ?? [],
        company: item.company || parsed?.company || 'Unknown',
        role: item.role || parsed?.role || '',
        fetch_failed: Boolean(parsed?.fetch_failed),
      });
      done++;
      process.stderr.write(`\r  prescreened ${done}/${items.length}   `);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  process.stderr.write('\n');
  return results;
}

// ── Daily doc writer ──────────────────────────────────────────────────────────
function scoreEmoji(s) {
  if (s == null) return '❓';
  if (s >= minScore) return '🟢';
  if (s >= 3.0) return '🟡';
  return '🔴';
}

function writeDailyDoc(date, results) {
  const ranked = [...results].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const apply = ranked.filter(r => r.score != null && r.score >= minScore);
  const maybe = ranked.filter(r => r.score != null && r.score >= 3.0 && r.score < minScore);
  const skip = ranked.filter(r => r.score == null || r.score < 3.0);

  const row = (r) =>
    `| ${scoreEmoji(r.score)} ${r.score != null ? r.score.toFixed(1) : '—'} | ${r.company} | ${r.role || '—'} | ${(r.reason || '').replace(/\|/g, '/')} | [link](${r.url}) |`;

  const section = (title, rows) =>
    rows.length
      ? `\n## ${title} (${rows.length})\n\n| Score | Company | Role | Why | URL |\n|-------|---------|------|-----|-----|\n${rows.map(row).join('\n')}\n`
      : `\n## ${title} (0)\n\n_None today._\n`;

  const doc = `# Daily Job Digest — ${date}

> Zero-Claude-token prescreen. Spend your Claude quota only on the **Apply** list below.
> Next step: \`/career-ops pipeline\` (evaluate picks) or \`/career-ops oferta {url}\`.

**Scanned & prescreened:** ${results.length} new offer(s) · **Apply (≥ ${minScore.toFixed(1)}):** ${apply.length} · **Maybe:** ${maybe.length} · **Skip:** ${skip.length}
${section(`✅ APPLY — worth your Claude tokens (≥ ${minScore.toFixed(1)})`, apply)}${section('🟡 MAYBE — borderline, review manually (3.0–' + (minScore - 0.1).toFixed(1) + ')', maybe)}${section('🔴 SKIP — below 3.0 or unscreenable', skip)}
---
_Generated by \`node daily.mjs\`. Prescreen model configured in config/profile.yml → models.prescreen._
`;

  const outPath = join(ROOT, 'data', `daily-${date}.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, doc, 'utf8');
  return { outPath, apply: apply.length, maybe: maybe.length, skip: skip.length };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const date = new Date().toISOString().slice(0, 10);
  console.log(`\n🗓️  career-ops daily — ${date}\n`);

  // Snapshot pending BEFORE scan so we can prescreen only the NEW ones.
  const before = new Set(parsePending().map(p => p.url));

  if (!noScan) {
    console.log('① Scanning portals (zero tokens)...\n');
    const scanArgs = [join(ROOT, 'scan.mjs')];
    if (scanVerify) scanArgs.push('--verify');
    const { code } = await run(process.execPath, scanArgs);
    if (code !== 0) console.log('\n⚠️  scan exited non-zero — continuing with whatever is in pipeline.md');
  } else {
    console.log('① Skipping scan (--no-scan)\n');
  }

  const allPending = parsePending();
  const fresh = noScan ? allPending : allPending.filter(p => !before.has(p.url));
  const toScreen = fresh.slice(0, limit);

  if (toScreen.length === 0) {
    console.log('\n✓ No new offers to prescreen today. You\'re all caught up.\n');
    // Still write an (empty) daily doc for a consistent paper trail.
    const { outPath } = writeDailyDoc(date, []);
    console.log(`   Wrote ${outPath}`);
    return;
  }

  console.log(`② Prescreening ${toScreen.length} new offer(s) with the free model (zero Claude tokens)...`);
  if (fresh.length > limit) console.log(`   (capped at --limit ${limit}; ${fresh.length - limit} more will appear next run)`);
  const results = await prescreenAll(toScreen);

  console.log('③ Writing daily digest...');
  const { outPath, apply, maybe, skip } = writeDailyDoc(date, results);

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`Daily digest: ${outPath}`);
  console.log(`  ✅ Apply (≥ ${minScore.toFixed(1)}): ${apply}   🟡 Maybe: ${maybe}   🔴 Skip: ${skip}`);
  console.log(`${'━'.repeat(50)}`);
  console.log(`\n→ Read data/daily-${date}.md, then spend Claude only on the Apply list:`);
  console.log(`  /career-ops pipeline   (evaluates pending URLs)\n`);
}

main().catch(e => {
  console.error('daily.mjs fatal:', e.message);
  process.exit(1);
});
