# Mode: voice — Authentic-Voice Rewrite

Rewrite tailored CV bullets, summaries, or cover letters so they read in the
candidate's **own natural voice** — not generic AI prose. This is a *quality*
pass, NOT an AI-detector-evasion trick: the goal is writing that sounds like a
real senior engineer wrote it, grounded in true facts.

## Hard Rules

1. **NEVER fabricate.** No new metrics, employers, dates, titles, or claims. You
   may only rephrase what already exists in `cv.md`, `modes/_profile.md`,
   `config/profile.yml`, `article-digest.md`, or the input text. If a sentence
   has nothing true to say, cut it — don't invent filler.
2. **Preserve ATS keywords.** Any JD keyword already present (from a `pdf`/`cover`
   tailoring pass) must survive the rewrite. Voice ≠ keyword loss. If a keyword
   reads awkwardly, reshape the sentence around it rather than dropping it.
3. **This is not deception.** Do not claim the text was human-written, and do not
   target detector signatures. Just write well.

## Voice Anchors (read these first)

- `config/profile.yml` → `narrative` (exit_story, superpowers, tone if present)
- `modes/_profile.md` → work history, differentiators, the "core narrative"
- `cv.md` → the candidate's existing phrasing and register (mirror its level of
  formality; do not upgrade a plain-spoken CV into corporate boilerplate)

Infer the voice from these: sentence length, how much hedging, first-person vs
implied subject, concrete-vs-abstract balance. Match it.

## AI-Tell Checklist (cut or rewrite each)

- Empty intensifiers: *cutting-edge, robust, seamless, leverage, utilize,
  spearheaded, passionate, dynamic, world-class, state-of-the-art*
- Triadic filler ("scalable, reliable, and maintainable") with no specifics
- Resume clichés: *"results-driven professional", "proven track record",
  "wear many hats", "think outside the box"*
- Vague impact verbs with no object/number: "drove growth", "optimized
  processes" → name what and by how much (only if the number is already true)
- Symmetrical bullet openers (every line starting "Led / Built / Designed")
- Em-dash overuse and the "It's not just X, it's Y" cadence
- Hedge stacking: "helped to successfully assist in"

## Method

1. Identify the artifact type (summary / bullets / cover letter) and its target
   JD if one is in context.
2. List the true facts available for this text (from the anchors). Rewrites draw
   only from this list.
3. Rewrite for the candidate's voice:
   - Lead with the concrete thing built and the real outcome.
   - Prefer plain verbs over thesaurus verbs.
   - Vary sentence rhythm; break the parallel-opener pattern.
   - Keep one specific, verifiable detail per bullet over three vague claims.
4. Re-insert any ATS keyword that the rewrite displaced.
5. **Output**:
   - The rewritten text.
   - A short diff-style note: what changed and why (1 line per major edit).
   - **Flags**: any sentence you could not make both authentic AND truthful —
     surface it for the user instead of guessing.

## Invocation

- `/career-ops voice` + pasted text → rewrite that text.
- `/career-ops voice cv` → rewrite the `cv.md` Summary in authentic voice.
- After a `pdf` or `cover` tailoring pass → offer to run `voice` on the output
  before the user finalizes.

## Stop Conditions

- If no voice anchors exist yet (fresh setup), ask the user for 2-3 sentences in
  their own words about a project they're proud of, and use that as the anchor.
- Always STOP before any submission. Voice rewrite produces a draft for the user
  to approve, never a sent artifact.
