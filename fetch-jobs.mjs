#!/usr/bin/env node
/**
 * fetch-jobs.mjs — On-demand "company names → matching jobs" fetcher. ZERO Claude tokens.
 *
 * You hand it company names; it resolves each company's ATS (Ashby / Greenhouse /
 * Lever) by probing slug variants, pulls their open roles, filters them through
 * your portals.yml profile (title / location / salary / content), and writes a
 * ranked markdown doc. With --score, each surviving role is also fit-scored by the
 * free prescreen model (prescreen.mjs) — still zero Claude tokens.
 *
 * This is a thin wrapper over the existing scan provider layer; it does NOT
 * duplicate fetch/filter logic. The difference vs scan.mjs: input is ad-hoc
 * company NAMES (no portals.yml entry required), not the tracked_companies list.
 *
 * Usage:
 *   node fetch-jobs.mjs Stripe Figma Notion
 *   node fetch-jobs.mjs --file companies.txt          # one name per line (# = comment)
 *   node fetch-jobs.mjs Stripe --score                # add free-model fit score + rank
 *   node fetch-jobs.mjs Stripe --no-filter            # show all roles, skip title/loc filters
 *   node fetch-jobs.mjs Stripe --json                 # machine-readable JSON to stdout
 *   node fetch-jobs.mjs Stripe --out data/foo.md      # custom output path
 *
 * Output: data/companies-YYYY-MM-DD.md (ranked) unless --out / --json.
 * Exit 0 on success; 1 on fatal config error.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import yaml from 'js-yaml';

import { makeHttpCtx } from './providers/_http.mjs';
import ashby from './providers/ashby.mjs';
import greenhouse from './providers/greenhouse.mjs';
import lever from './providers/lever.mjs';
import {
  buildTitleFilter,
  buildLocationFilter,
  buildSalaryFilter,
  buildContentFilter,
} from './scan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(ROOT, 'portals.yml');

// ── Args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flagVal(name, def) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}
const wantHelp = argv.includes('--help') || argv.includes('-h');
const score = argv.includes('--score');
const scrape = argv.includes('--scrape');
const noFilter = argv.includes('--no-filter');
const asJson = argv.includes('--json');
const fileArg = flagVal('--file', null);
const outArg = flagVal('--out', null);

if (wantHelp) {
  process.stdout.write(`fetch-jobs.mjs — company names → matching jobs (zero Claude tokens)

  node fetch-jobs.mjs <Company> [<Company> ...] [--score] [--no-filter] [--json]
  node fetch-jobs.mjs --file companies.txt [--score]

  --score      fit-score each role with the free prescreen model + rank
  --scrape     fallback: when no ATS API resolves, scrape the careers page with
               Playwright (slower, best-effort, lower confidence)
  --no-filter  skip title/location/salary/content filters (show everything)
  --file PATH  read company names from a file (one per line, # comments ok)
  --out PATH   write the markdown doc to PATH
  --json       print JSON to stdout instead of writing a doc

Resolves Ashby / Greenhouse / Lever by probing slug variants from the name.
Companies on other ATS (Workday, BambooHR, custom) won't resolve here — add
them to portals.yml tracked_companies and use scan.mjs instead.
`);
  process.exit(0);
}

// Company names = positional args that aren't flags or flag-values.
const FLAGS_WITH_VALUE = new Set(['--file', '--out']);
const names = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (FLAGS_WITH_VALUE.has(a)) i++; // skip its value
    continue;
  }
  names.push(a);
}
if (fileArg) {
  if (!existsSync(fileArg)) {
    console.error(`Error: --file not found: ${fileArg}`);
    process.exit(1);
  }
  for (const line of readFileSync(fileArg, 'utf-8').split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) names.push(t);
  }
}
if (names.length === 0) {
  console.error('Error: no company names given. Try: node fetch-jobs.mjs Stripe Figma  (or --help)');
  process.exit(1);
}

// ── Slug + ATS resolution ─────────────────────────────────────────────────────
// A company name maps to an ATS slug in a few predictable shapes. We try the
// likely variants against each provider and keep the first that returns roles.
function slugVariants(name) {
  const lower = name.toLowerCase().trim();
  const collapsed = lower.replace(/[^a-z0-9]+/g, '');        // "Scale AI" → "scaleai"
  const hyphen = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); // "scale-ai"
  const noSuffix = lower
    .replace(/\b(ai|labs?|inc|llc|technologies|technology|software|the)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');                              // "scale"
  // Dedup while preserving order.
  return [...new Set([collapsed, hyphen, noSuffix].filter(Boolean))];
}

const PROVIDERS = [
  { p: ashby, url: (s) => `https://jobs.ashbyhq.com/${s}` },
  { p: greenhouse, url: (s) => `https://job-boards.greenhouse.io/${s}` },
  { p: lever, url: (s) => `https://jobs.lever.co/${s}` },
];

// Try every (provider × slug) combo for one company; return the first hit's jobs.
async function resolveCompany(name) {
  const ctx = makeHttpCtx();
  for (const slug of slugVariants(name)) {
    for (const { p, url } of PROVIDERS) {
      const entry = { name, careers_url: url(slug) };
      // Only ask a provider that actually claims this URL shape.
      let claims = false;
      try { claims = Boolean(p.detect?.(entry)); } catch { claims = false; }
      if (!claims) continue;
      try {
        const jobs = await p.fetch(entry, ctx);
        if (Array.isArray(jobs) && jobs.length > 0) {
          return { jobs, ats: p.id, slug, careers_url: entry.careers_url };
        }
      } catch {
        /* try next combo */
      }
    }
  }
  return { jobs: [], ats: null, slug: null, careers_url: null };
}

// ── Playwright scrape fallback (opt-in, --scrape) ─────────────────────────────
// Only runs when no Ashby/Greenhouse/Lever API resolved a company. Best-effort:
// find the careers page via a DuckDuckGo search, then harvest job links from the
// DOM. Fragile by nature (every site differs) — results are lower confidence and
// tagged source:'scrape'. Sequential only (project rule: never parallel Playwright).

const ROLE_HINT = /\b(engineer|developer|scientist|architect|designer|manager|analyst|lead|programmer|sre|devops|specialist|consultant)\b/i;
const JOB_HREF_HINT = /\/(jobs?|careers?|positions?|openings?|vacanc|gh_jid|opportunit)/i;
const SCRAPE_TIMEOUT_MS = 15_000;

// Unwrap DuckDuckGo's /l/?uddg= redirect to the real destination.
function unwrapDdg(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    if ((u.hostname === 'duckduckgo.com' || u.hostname.endsWith('.duckduckgo.com')) && u.pathname === '/l/') {
      const t = u.searchParams.get('uddg');
      if (t) return t;
    }
  } catch { /* fall through */ }
  return href;
}

// Probe a URL: returns it if the page loads with a 2xx/3xx and some content.
async function urlLoads(page, url) {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SCRAPE_TIMEOUT_MS });
    if (resp && resp.status() < 400) return true;
  } catch { /* dead */ }
  return false;
}

// Find a careers-page URL for a company name.
// 1. If the name IS a URL, use it directly (most reliable).
// 2. Guess common careers paths on the company's likely domain.
// 3. Fall back to a DuckDuckGo search (often rate-limited — best effort).
async function discoverCareersUrl(page, name) {
  // (1) direct URL
  if (/^https?:\/\//i.test(name.trim())) return name.trim();

  // (2) domain + common careers paths
  const slug = name.toLowerCase().replace(/\b(ai|labs?|inc|llc|technologies|technology|the)\b/g, '').replace(/[^a-z0-9]+/g, '');
  if (slug) {
    const hosts = [`https://www.${slug}.com`, `https://${slug}.com`, `https://www.${slug}.ai`, `https://${slug}.io`];
    const paths = ['/careers', '/jobs', '/careers/jobs', '/company/careers', '/about/careers'];
    for (const h of hosts) {
      for (const pth of paths) {
        const cand = h + pth;
        if (await urlLoads(page, cand)) return cand;
      }
    }
  }

  // (3) DuckDuckGo fallback (markup varies; try a couple of selectors)
  try {
    await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"${name}" careers jobs`)}`,
      { waitUntil: 'domcontentloaded', timeout: SCRAPE_TIMEOUT_MS });
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a.result__a, .result__title a, a[href*="uddg="]'))
        .map(a => a.getAttribute('href')).filter(Boolean));
    for (const raw of hrefs) {
      const url = unwrapDdg(raw);
      try {
        const host = new URL(url).hostname;
        if (/duckduckgo|linkedin|indeed|glassdoor|wikipedia|youtube|facebook/i.test(host)) continue;
        return url;
      } catch { continue; }
    }
  } catch { /* no result */ }
  return null;
}

// Harvest plausible job postings from a careers page's anchors.
async function scrapeCareersPage(page, careersUrl, name) {
  try {
    await page.goto(careersUrl, { waitUntil: 'domcontentloaded', timeout: SCRAPE_TIMEOUT_MS });
    // Give SPA boards a moment to render their listing.
    await page.waitForTimeout(2500);
    const raw = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => ({
        text: (a.textContent || '').replace(/\s+/g, ' ').trim(),
        href: a.getAttribute('href') || '',
      })));
    const seen = new Set();
    const jobs = [];
    for (const { text, href } of raw) {
      if (text.length < 5 || text.length > 90) continue;
      const looksJob = ROLE_HINT.test(text) || JOB_HREF_HINT.test(href);
      if (!looksJob) continue;
      let abs;
      try { abs = new URL(href, careersUrl).href; } catch { continue; }
      if (seen.has(abs)) continue;
      seen.add(abs);
      jobs.push({ title: text, url: abs, company: name, location: '' });
    }
    return jobs;
  } catch {
    return [];
  }
}

// Scrape one company end-to-end (discover → harvest). Reuses one page.
async function scrapeCompany(page, name) {
  const careersUrl = await discoverCareersUrl(page, name);
  if (!careersUrl) return { jobs: [], careers_url: null };
  const jobs = await scrapeCareersPage(page, careersUrl, name);
  return { jobs, careers_url: careersUrl };
}

// ── Free-model fit scoring (opt-in) ───────────────────────────────────────────
function prescreen(url) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'prescreen.mjs'), url, '--json'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      // prescreen prints JSON on the last non-empty line.
      const line = out.trim().split('\n').filter(Boolean).pop() || '';
      try { resolve(JSON.parse(line)); } catch { resolve(null); }
    });
    child.on('error', () => resolve(null));
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Load portals.yml filters (best-effort — missing file just means no filtering).
  let cfg = {};
  if (existsSync(PORTALS_PATH)) {
    try { cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {}; }
    catch (e) { console.error(`Warning: could not parse portals.yml — filtering disabled (${e.message})`); }
  }
  const titleFilter = noFilter ? () => true : buildTitleFilter(cfg.title_filter);
  const locationFilter = noFilter ? () => true : buildLocationFilter(cfg.location_filter);
  const salaryFilter = noFilter ? () => true : buildSalaryFilter(cfg.salary_filter);
  const contentFilter = noFilter ? () => true : buildContentFilter(cfg.content_filter);

  // Lazily spin up one Playwright page, shared across companies, only if --scrape
  // is set AND at least one company misses the API path. Sequential reuse.
  let browser = null;
  let scrapePage = null;
  async function getScrapePage() {
    if (scrapePage) return scrapePage;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    scrapePage = await browser.newPage();
    return scrapePage;
  }

  const report = [];   // { name, ats, careers_url, matched:[job], totalFound, error }
  for (const name of names) {
    if (!asJson) process.stderr.write(`→ ${name} … `);
    let { jobs, ats, careers_url } = await resolveCompany(name);
    if (!ats && scrape) {
      if (!asJson) process.stderr.write('no API, scraping… ');
      try {
        const page = await getScrapePage();
        const res = await scrapeCompany(page, name);
        if (res.jobs.length > 0) { jobs = res.jobs; ats = 'scrape'; careers_url = res.careers_url; }
      } catch (e) {
        if (!asJson) process.stderr.write(`scrape failed (${e.message}) `);
      }
    }
    if (!ats) {
      const why = scrape ? 'no API + scrape found nothing' : 'no Ashby/Greenhouse/Lever board found';
      report.push({ name, ats: null, careers_url: null, matched: [], totalFound: 0, error: why });
      if (!asJson) process.stderr.write(`not found${scrape ? '' : ' (Ashby/GH/Lever)'}\n`);
      continue;
    }
    const matched = jobs.filter((j) =>
      titleFilter(j.title) &&
      locationFilter(j.location) &&
      salaryFilter(j.salary) &&
      contentFilter(j.description),
    );
    report.push({ name, ats, careers_url, matched, totalFound: jobs.length, error: null });
    if (!asJson) process.stderr.write(`${ats}: ${matched.length}/${jobs.length} match\n`);
  }

  // Scrape browser is no longer needed once harvesting is done.
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }

  // Optional fit scoring (sequential — free model, but be polite to the endpoint).
  if (score) {
    if (!asJson) process.stderr.write('\nScoring matches with free prescreen model…\n');
    for (const co of report) {
      for (const job of co.matched) {
        const res = await prescreen(job.url);
        job.fit = res && typeof res.score === 'number' ? res.score : null;
        job.fitReason = res?.reason || '';
        job.hardBlocks = res?.hard_blocks || [];
        if (!asJson) process.stderr.write(`  ${job.fit ?? '—'}  ${co.name} | ${job.title}\n`);
      }
      // Rank this company's matches by fit (unscored sink to the bottom).
      co.matched.sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1));
    }
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  // ── Write ranked markdown doc ────────────────────────────────────────────────
  const date = new Date().toISOString().slice(0, 10);
  const outPath = outArg || join(ROOT, 'data', `companies-${date}.md`);
  mkdirSync(dirname(outPath), { recursive: true });

  const totalMatched = report.reduce((n, c) => n + c.matched.length, 0);
  const lines = [];
  lines.push(`# Company Job Match — ${date}`);
  lines.push('');
  lines.push(`Companies: ${report.length} · Matches: ${totalMatched}${score ? ' · ranked by fit' : ''}`);
  lines.push('');

  for (const co of report) {
    lines.push(`## ${co.name}`);
    if (co.error) { lines.push(`_${co.error}_`); lines.push(''); continue; }
    lines.push(`ATS: ${co.ats} · ${co.matched.length}/${co.totalFound} roles match · [board](${co.careers_url})`);
    lines.push('');
    if (co.matched.length === 0) { lines.push('_No matching roles._'); lines.push(''); continue; }
    if (score) {
      lines.push('| Fit | Role | Location | Link |');
      lines.push('|-----|------|----------|------|');
      for (const j of co.matched) {
        const fit = j.fit != null ? j.fit.toFixed(1) : '—';
        const blocks = j.hardBlocks?.length ? ` ⚠️ ${j.hardBlocks.join(', ')}` : '';
        lines.push(`| ${fit} | ${mdCell(j.title)}${blocks} | ${mdCell(j.location || '—')} | [open](${j.url}) |`);
      }
    } else {
      for (const j of co.matched) {
        lines.push(`- [ ] ${j.url} | ${co.name} | ${j.title}${j.location ? ` | ${j.location}` : ''}`);
      }
    }
    lines.push('');
  }
  lines.push('---');
  lines.push(`_Generated by \`node fetch-jobs.mjs\`. Tip: paste a URL into /career-ops pipeline to run the full Claude evaluation on a finalist._`);

  writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
  process.stderr.write(`\n✅ ${totalMatched} match(es) → ${outPath}\n`);
}

function mdCell(s) {
  return String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ').trim();
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
