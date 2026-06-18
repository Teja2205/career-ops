#!/usr/bin/env node
/**
 * Ollama pre-screener for career-ops hybrid engine.
 * Fetches JD text from a job URL, sends it + candidate CV to a local Ollama
 * model, and returns a quick fit score WITHOUT spending Claude tokens.
 *
 * Usage: node ollama-prescreen.mjs <url> [--model qwen2.5:7b] [--ollama-base http://localhost:11434]
 * Stdout: JSON { score, archetype, hard_blocks, reason, fetch_failed? }
 * Exit 0 always — errors produce a pass-through score of 3.0 so the batch
 * runner falls back to Claude rather than silently dropping the offer.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;

// ── Parse args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--'));
let model = 'qwen2.5:7b';
let ollamaBase = 'http://localhost:11434';
let cvPath = join(PROJECT_DIR, 'cv.md');
let profilePath = join(PROJECT_DIR, 'config', 'profile.yml');
let apiKey = process.env.OPENROUTER_API_KEY || process.env.OLLAMA_API_KEY || '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--model' && args[i + 1]) model = args[++i];
  if (args[i] === '--ollama-base' && args[i + 1]) ollamaBase = args[++i];
  if (args[i] === '--cv' && args[i + 1]) cvPath = args[++i];
  if (args[i] === '--api-key' && args[i + 1]) apiKey = args[++i];
}

if (!url) {
  process.stderr.write('Usage: node ollama-prescreen.mjs <url> [--model qwen2.5:7b]\n');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function loadFile(path, maxChars = 3000) {
  if (!existsSync(path)) return '';
  const content = readFileSync(path, 'utf8');
  return content.length > maxChars ? content.slice(0, maxChars) + '\n...[truncated]' : content;
}

function passthrough(reason, extra = {}) {
  process.stdout.write(JSON.stringify({ score: 3.0, reason, archetype: 'unknown', hard_blocks: [], ...extra }) + '\n');
  process.exit(0);
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── JD Fetchers (API-first, HTML fallback) ──────────────────────────────────
async function fetchJD(rawUrl) {
  const timeout = AbortSignal.timeout(15000);

  // Ashby API
  const ashby = rawUrl.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([a-f0-9-]{36})/i)
    || rawUrl.match(/ashby_jid=([a-f0-9-]{36})/i);
  if (ashby) {
    const jobId = ashby[2] || ashby[1];
    try {
      const r = await fetch('https://api.ashbyhq.com/posting-public/jobPosting.info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobPostingId: jobId }),
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) {
        const d = await r.json();
        const j = d?.results;
        if (j) {
          const text = [j.title, j.teamName, j.locationName,
            (j.descriptionHtml || j.description || '').replace(/<[^>]+>/g, ' ')]
            .filter(Boolean).join('\n');
          return text.slice(0, 5000);
        }
      }
    } catch { /* fall through */ }
  }

  // Greenhouse API
  const gh = rawUrl.match(/job-boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (gh) {
    try {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${gh[1]}/jobs/${gh[2]}`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const d = await r.json();
        return `${d.title || ''}\n${stripHtml(d.content || '')}`.slice(0, 5000);
      }
    } catch { /* fall through */ }
  }

  // Lever API
  const lever = rawUrl.match(/jobs\.lever\.co\/([^/]+)\/([a-f0-9-]{36})/);
  if (lever) {
    try {
      const r = await fetch(`https://api.lever.co/v0/postings/${lever[1]}/${lever[2]}`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const d = await r.json();
        const text = [d.text, d.categories?.team, d.categories?.location,
          (d.description || ''), (d.lists || []).map(l => l.content).join('\n')]
          .filter(Boolean).join('\n');
        return stripHtml(text).slice(0, 5000);
      }
    } catch { /* fall through */ }
  }

  // Generic HTML fallback
  try {
    const r = await fetch(rawUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; career-ops-prescreen/1.0)' },
      signal: timeout,
    });
    if (!r.ok) return null;
    return stripHtml(await r.text()).slice(0, 5000);
  } catch {
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const cv = loadFile(cvPath, 2500);
  const profile = loadFile(profilePath, 800);

  const jdText = await fetchJD(url);
  if (!jdText || jdText.trim().length < 80) {
    return passthrough('JD fetch failed — passing to Claude for full evaluation', { fetch_failed: true });
  }

  const systemPrompt = `You are a job-fit pre-screener. Output ONLY valid JSON — no prose, no markdown fences outside the JSON object.`;

  const userPrompt = `## Candidate CV (truncated)
${cv}

## Candidate Profile Config
${profile}

## Job URL
${url}

## Job Description
${jdText}

## Task
Score fit between candidate and this job. Reply with ONLY this JSON (no other text):
{
  "score": <0.0-5.0, one decimal place>,
  "archetype": "<AI/ML Engineer | Backend SWE | Full Stack | Data Engineer | Platform/DevOps | Other>",
  "hard_blocks": ["<list blocking issues, or empty array>"],
  "reason": "<2 sentences max>"
}

Scoring guide:
5.0 = perfect — AI/ML role, all requirements met
4.0-4.9 = strong — AI-adjacent, minor gaps
3.0-3.9 = decent — transferable skills but missing AI component or has gaps
2.0-2.9 = weak — wrong domain, wrong level, or hard blockers present
0.0-1.9 = skip — off-target, expired, or explicit deal-breaker

CRITICAL rules:
- Candidate NEEDS visa sponsorship. If JD says "no sponsorship" → score ≤ 1.0
- Pure backend/SaaS role with zero AI/ML component → score ≤ 3.0 max
- On-site only in a city the candidate excluded → hard_blocks entry, score ≤ 2.0
- Candidate targets Senior AI Engineer / ML Engineer / Gen AI Engineer roles`;

  try {
    const reqHeaders = { 'Content-Type': 'application/json' };
    if (apiKey) reqHeaders['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`${ollamaBase}/v1/chat/completions`, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return passthrough(`Ollama HTTP ${res.status} — passing to Claude`, { ollama_error: true, detail: body.slice(0, 200) });
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '';

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return passthrough(`Ollama non-JSON response — passing to Claude`, { ollama_error: true });
    }

    const result = JSON.parse(jsonMatch[0]);

    if (typeof result.score !== 'number') throw new Error('score field missing or not a number');
    result.score = Math.round(Math.max(0, Math.min(5, result.score)) * 10) / 10;
    if (!Array.isArray(result.hard_blocks)) result.hard_blocks = [];
    if (typeof result.reason !== 'string') result.reason = '';
    if (typeof result.archetype !== 'string') result.archetype = 'unknown';

    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (e) {
    return passthrough(`Ollama error: ${e.message} — passing to Claude`, { ollama_error: true });
  }
}

main().catch(e => {
  process.stderr.write(`ollama-prescreen fatal: ${e.message}\n`);
  passthrough('Fatal error in pre-screener — passing to Claude', { fatal_error: true });
});
