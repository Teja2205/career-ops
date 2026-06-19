// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// LinkedIn provider — BEST-EFFORT, personal-scale only.
//
// ⚠️  IMPORTANT — read before enabling:
//   LinkedIn has NO official free jobs API. This provider hits the public
//   "guest" endpoint that LinkedIn's own front-end uses to lazy-load job cards
//   for logged-out visitors:
//       https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
//   It is UNDOCUMENTED, FRAGILE, RATE-LIMITED, and using it for bulk collection
//   is against LinkedIn's Terms of Service. It works for low-volume personal
//   use and will sometimes return 429/empty — in which case this provider fails
//   gracefully (scan.mjs records the error and moves on, like any other source).
//   Do NOT crank up volume or redistribute the data. You use it at your own risk
//   (see LEGAL_DISCLAIMER.md).
//
// Wire in via a `job_boards:` entry in portals.yml:
//   job_boards:
//     - name: LinkedIn AI Roles
//       provider: linkedin
//       query: "AI Engineer"        # keywords (required)
//       location: "United States"   # optional geo string
//       remote: true                # optional → adds f_WT=2 (remote filter)
//       since: r604800              # optional → f_TPR (e.g. r604800 = last 7 days)
//       pages: 2                    # optional → how many 25-card pages to pull (default 2, max 5)

const GUEST_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const PER_PAGE = 25;
const MAX_PAGES = 5;

// Tolerant attribute/text extraction from a single <li> job card.
function parseCards(html) {
  const jobs = [];
  // Each card is a <li> wrapping a div.base-card with a data-entity-urn.
  const cards = html.split(/<li[\s>]/i).slice(1);
  for (const card of cards) {
    // Title
    const titleM = card.match(/<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i)
      || card.match(/<span[^>]*class="[^"]*sr-only[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    // Company
    const companyM = card.match(/<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/i);
    // Location
    const locM = card.match(/<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    // URL — the anchor on the card
    const urlM = card.match(/<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/i)
      || card.match(/href="(https:\/\/[a-z]*\.?linkedin\.com\/jobs\/view\/[^"]+)"/i);

    const clean = (s) => s ? s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    const title = clean(titleM?.[1]);
    const url = (urlM?.[1] || '').split('?')[0].trim();
    if (!title || !/^https?:\/\//i.test(url)) continue;

    jobs.push({
      title,
      url,
      company: clean(companyM?.[1]) || 'LinkedIn',
      location: clean(locM?.[1]),
    });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'linkedin',

  // No URL auto-detection — must be opted into explicitly with `provider: linkedin`.

  /**
   * @param {{ name?: string, query?: string, location?: string, remote?: boolean, since?: string, pages?: number }} entry
   * @param {{ fetchText: (url: string, opts?: any) => Promise<string> }} ctx
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string}>>}
   */
  async fetch(entry, ctx) {
    const keywords = (entry.query || '').trim();
    if (!keywords) {
      throw new Error(`linkedin: entry "${entry.name || 'LinkedIn'}" requires a 'query' (keywords) field`);
    }
    const pages = Math.min(MAX_PAGES, Math.max(1, Number(entry.pages) || 2));
    const all = [];
    const seen = new Set();

    for (let page = 0; page < pages; page++) {
      const params = new URLSearchParams();
      params.set('keywords', keywords);
      if (entry.location) params.set('location', String(entry.location));
      if (entry.remote) params.set('f_WT', '2');
      if (entry.since) params.set('f_TPR', String(entry.since));
      params.set('start', String(page * PER_PAGE));

      let html;
      try {
        html = await ctx.fetchText(`${GUEST_URL}?${params.toString()}`, {
          headers: {
            // lowercase to cleanly override _http.mjs's default user-agent
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            'accept': 'text/html,application/xhtml+xml',
          },
          redirect: 'follow',
        });
      } catch (err) {
        // 429/blocked/empty — return whatever we already have rather than throwing
        // away the whole scan. If the very first page fails, surface the error.
        if (page === 0) throw new Error(`linkedin: guest endpoint failed (likely rate-limited): ${err.message}`);
        break;
      }

      const batch = parseCards(html);
      if (batch.length === 0) break; // no more results
      for (const j of batch) {
        if (seen.has(j.url)) continue;
        seen.add(j.url);
        all.push(j);
      }
      // Gentle pacing between pages to stay under the radar.
      if (page < pages - 1) await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
    }

    return all;
  },
};
