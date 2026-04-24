#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const PROFILE_PATH = 'config/profile.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });
mkdirSync('config', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── Location filter (reads from config/profile.yml) ─────────────────

// US state abbreviations — matches ", CA" / ", NY" / "CA, US" etc.
const US_STATE_ABBREVS = new Set([
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia',
  'ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
  'nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt',
  'va','wa','wv','wi','wy','dc',
]);

function looksLikeUS(location) {
  const lower = location.toLowerCase();
  // "United States" / "USA" / "US" as standalone word
  if (/\busa?\b/.test(lower) || lower.includes('united states')) return true;
  // ", XX" or "XX, " where XX is a US state abbreviation
  const stateMatch = lower.match(/(?:,\s*([a-z]{2})\b|\b([a-z]{2})\s*,)/g);
  if (stateMatch) {
    for (const m of stateMatch) {
      const abbr = m.replace(/[^a-z]/g, '');
      if (US_STATE_ABBREVS.has(abbr)) return true;
    }
  }
  return false;
}

function buildLocationFilter(profile) {
  const loc = profile?.location || {};

  // Normalise to lowercase tokens
  const preferredRaw = (loc.preferred_regions || []).map(r => r.toLowerCase().trim());
  const excludeRaw   = (loc.exclude_regions   || []).map(r => r.toLowerCase().trim());

  // Does the user want US/remote at all? Detect from preferred list.
  const wantsUS     = preferredRaw.some(r => r.includes('united states') || r === 'us' || r === 'usa');
  const wantsRemote = preferredRaw.some(r => r.includes('remote'));

  // If no location config defined, allow all
  if (preferredRaw.length === 0 && excludeRaw.length === 0) {
    return () => true;
  }

  return (location) => {
    const lower = (location || '').toLowerCase().trim();

    // Empty / unspecified location — allow (could be remote, can't tell)
    if (!lower) return true;

    // Exclude check — highest priority
    if (excludeRaw.some(ex => lower.includes(ex))) return false;

    // Remote always passes if user listed any remote preference
    if (wantsRemote && lower.includes('remote')) return true;

    // US location detection (handles "Salem, OR", "San Francisco, CA", "New York, NY, US")
    if (wantsUS && looksLikeUS(lower)) return true;

    // Fallback: substring match against any preferred token
    if (preferredRaw.some(pr => lower.includes(pr))) return true;

    return false;
  };
}

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

const RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_500;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    const isRetryable =
      err.name === 'AbortError' ||
      err.message.includes('aborted') ||
      err.message.includes('ECONNRESET') ||
      err.message.includes('ETIMEDOUT');
    if (isRetryable && attempt <= RETRY_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS * attempt);
      return fetchJson(url, attempt + 1);
    }
    if (err.name === 'AbortError') throw new Error(`Timeout after ${FETCH_TIMEOUT_MS}ms (${RETRY_ATTEMPTS} retries)`);
    throw err;
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter, profileExcludeKeywords = []) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  // Merge portals.yml negative list with profile.yml exclude_keywords
  const negative = [
    ...(titleFilter?.negative || []),
    ...profileExcludeKeywords,
  ].map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();

  // Helper: extract company::role pairs from a markdown table line
  // Handles both:  | Company | Role Title | ...
  //          and:  | Date | Company | Role | ...  (shifted columns)
  function extractFromTableLine(line) {
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 2) return;
    // Try every adjacent pair as (company, role) — we'll add all combos and
    // let URL-based dedup do the heavy lifting for false positives.
    for (let i = 0; i < cols.length - 1; i++) {
      const a = cols[i].toLowerCase();
      const b = cols[i + 1].toLowerCase();
      if (a && b && a !== 'company' && b !== 'role' && b !== 'title' && !a.startsWith('http') && !b.startsWith('http')) {
        seen.add(`${a}::${b}`);
      }
    }
  }

  if (existsSync(APPLICATIONS_PATH)) {
    const lines = readFileSync(APPLICATIONS_PATH, 'utf-8').split('\n');
    for (const line of lines) {
      if (line.includes('|')) extractFromTableLine(line);
    }
  }

  // Also pull company+role from pipeline.md entries already in Procesadas
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    // Format: - [x] <url> | <company> | <title>
    for (const match of text.matchAll(/- \[[x ]\] https?:\/\/\S+\s*\|\s*([^|]+?)\s*\|\s*(.+)$/gm)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role) seen.add(`${company}::${role}`);
    }
  }

  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function ensurePipelineExists() {
  if (!existsSync(PIPELINE_PATH)) {
    writeFileSync(
      PIPELINE_PATH,
      `# Job Pipeline\n\n## Pendientes\n\n## Procesadas\n`,
      'utf-8'
    );
  }
}

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  ensurePipelineExists();
  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Stats helpers ────────────────────────────────────────────────────

/** Group new offers by portal type for the summary breakdown */
function groupBySource(offers) {
  const map = {};
  for (const o of offers) {
    map[o.source] = (map[o.source] || 0) + 1;
  }
  return map;
}

/** Group new offers by company for the verbose listing */
function groupByCompany(offers) {
  const map = {};
  for (const o of offers) {
    if (!map[o.company]) map[o.company] = [];
    map[o.company].push(o);
  }
  return map;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const fixPortals = args.includes('--fix-portals'); // auto-disable 404 companies in portals.yml
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // --help
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
scan.mjs — Zero-token portal scanner

Usage:
  node scan.mjs                          Scan all enabled companies
  node scan.mjs --dry-run                Preview without writing files
  node scan.mjs --company <name>         Scan a single company (partial match)
  node scan.mjs --verbose                Show full offer list grouped by company
  node scan.mjs --dry-run --verbose      Combine flags freely
  node scan.mjs --fix-portals            Auto-disable companies returning HTTP 404

Output files:
  data/pipeline.md       New offers appended under ## Pendientes
  data/scan-history.tsv  Running log of every seen offer (URL + date + metadata)

Config files:
  portals.yml            Company list with careers_url / api + title_filter
  config/profile.yml     Location preferences (preferred_regions, exclude_regions)
    `);
    process.exit(0);
  }

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Create it first (see --help).');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];

  if (companies.length === 0) {
    console.error('Error: portals.yml has no tracked_companies entries.');
    process.exit(1);
  }

  // 2. Load profile.yml — location filter + profile-level keyword exclusions
  let locationFilter = () => true;
  let profileExcludeKeywords = [];
  if (existsSync(PROFILE_PATH)) {
    const profile = parseYaml(readFileSync(PROFILE_PATH, 'utf-8'));
    locationFilter = buildLocationFilter(profile);
    profileExcludeKeywords = (profile?.exclude_keywords || []);

    const loc = profile?.location || {};
    const preferred = (loc.preferred_regions || []).join(', ') || '(none)';
    const excluded  = (loc.exclude_regions  || []).join(', ') || '(none)';
    console.log(`Profile loaded — preferred: [${preferred}]`);
    console.log(`               excluded:  [${excluded}]`);
    if (profileExcludeKeywords.length > 0) {
      console.log(`               +${profileExcludeKeywords.length} title exclusion keyword(s) from profile`);
    }
  } else {
    console.log('No config/profile.yml found — location + keyword filtering disabled.');
  }

  // Build title filter (portals.yml title_filter merged with profile exclude_keywords)
  const titleFilter = buildTitleFilter(config.title_filter, profileExcludeKeywords);

  // 3. Filter to enabled companies with detectable APIs
  const enabledCompanies = companies.filter(c => c.enabled !== false);
  const targets = enabledCompanies
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const noApiCompanies = enabledCompanies
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .filter(c => detectApi(c) === null);

  const skippedCount = noApiCompanies.length;

  if (targets.length === 0) {
    console.error(
      filterCompany
        ? `No companies matching "${filterCompany}" with a detectable API.`
        : 'No companies with a detectable Greenhouse / Ashby / Lever API found.'
    );
    process.exit(1);
  }

  console.log(`\nScanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (skippedCount > 0 && verbose) {
    console.log('  Skipped (no API):');
    for (const c of noApiCompanies) {
      console.log(`    - ${c.name}  (${c.careers_url || 'no URL'})`);
    }
  }
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 4. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  console.log(`Dedup baseline: ${seenUrls.size} known URLs, ${seenCompanyRoles.size} known company+role pairs`);

  // 5. Fetch all APIs in parallel
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalLocationFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  process.stdout.write('\nFetching');

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        // Title filter
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        // Location filter
        if (!locationFilter(job.location)) {
          totalLocationFiltered++;
          continue;
        }
        // Dedup by URL
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        // Dedup by company+role
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }

      process.stdout.write('.');
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
      process.stdout.write('✗');
    }
  });

  await parallelFetch(tasks, CONCURRENCY);
  console.log(' done\n');

  // 6b. Auto-disable 404 companies in portals.yml if --fix-portals
  const notFoundCompanies = errors.filter(e => e.error.includes('HTTP 404')).map(e => e.company);
  if (fixPortals && notFoundCompanies.length > 0) {
    let raw = readFileSync(PORTALS_PATH, 'utf-8');
    let disabledCount = 0;
    for (const name of notFoundCompanies) {
      // Find the name: "<name>" line and inject enabled: false on the next line if not already there
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(  - name:\\s*${escapedName}\\b[^\n]*)(\n(?!\\s*enabled:))`, 'm');
      if (pattern.test(raw)) {
        raw = raw.replace(pattern, `$1\n    enabled: false`);
        disabledCount++;
      }
    }
    if (!dryRun) {
      writeFileSync(PORTALS_PATH, raw, 'utf-8');
      console.log(`\n--fix-portals: disabled ${disabledCount} companies returning 404 in portals.yml`);
      console.log(`  ${notFoundCompanies.join(', ')}`);
    } else {
      console.log(`\n--fix-portals (dry run): would disable ${disabledCount} companies: ${notFoundCompanies.join(', ')}`);
    }
  }
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 7. Print summary
  console.log(`${'━'.repeat(50)}`);
  console.log(`Portal Scan — ${date}${dryRun ? '  [DRY RUN]' : ''}`);
  console.log(`${'━'.repeat(50)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Filtered by location:  ${totalLocationFiltered} removed`);
  console.log(`Duplicates skipped:    ${totalDupes}`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (newOffers.length > 0) {
    // Breakdown by portal type
    const bySource = groupBySource(newOffers);
    const sourceLine = Object.entries(bySource)
      .map(([src, n]) => `${src}: ${n}`)
      .join('  |  ');
    console.log(`  by portal → ${sourceLine}`);
  }

  // Error report
  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  // New offers listing
  if (newOffers.length > 0) {
    if (verbose) {
      // Group by company for a cleaner view
      const byCompany = groupByCompany(newOffers);
      console.log('\nNew offers (grouped by company):');
      for (const [company, offers] of Object.entries(byCompany)) {
        console.log(`\n  ${company} (${offers.length})`);
        for (const o of offers) {
          const loc = o.location ? `  [${o.location}]` : '';
          console.log(`    + ${o.title}${loc}`);
          console.log(`      ${o.url}`);
        }
      }
    } else {
      // Compact flat list
      console.log('\nNew offers:');
      for (const o of newOffers) {
        const loc = o.location ? `  [${o.location}]` : '';
        console.log(`  + ${o.company} | ${o.title}${loc}`);
        console.log(`    ${o.url}`);
      }
    }
  } else {
    console.log('\nNo new offers found — all results were filtered or already seen.');
  }

  // Footer with file paths
  if (!dryRun && newOffers.length > 0) {
    console.log(`\nFiles updated:`);
    console.log(`  ${PIPELINE_PATH}         (${newOffers.length} new entries under ## Pendientes)`);
    console.log(`  ${SCAN_HISTORY_PATH}  (${newOffers.length} rows appended)`);
  }

  console.log('');

  // Exit with non-zero only on fetch errors (not "no results" — that's normal)
  process.exit(errors.length > 0 && newOffers.length === 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
