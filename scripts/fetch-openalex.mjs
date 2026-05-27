#!/usr/bin/env node
/**
 * Fetch academic stats and per-publication citation counts from OpenAlex.
 * Outputs:
 *   - src/data/stats.json       (works, citations, h-index, i10)
 *   - src/data/citations.json   ({ "10.xxxx/yyyy": 42, ... })
 *
 * Runs weekly via .github/workflows/update-stats.yml — no API key needed.
 * Note on accuracy: OpenAlex citation counts typically run within 10–15% of
 * Google Scholar (Scholar has no public API and blocks scraping). For most
 * works the numbers are close; for very recent papers OpenAlex may lag.
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORCID = process.env.ORCID || '0000-0003-1513-6018';
const POLITE_EMAIL = process.env.OPENALEX_EMAIL || 'mraspopoulos@uclan.ac.uk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');

const ua = `academic-site-stats-fetcher (mailto:${POLITE_EMAIL})`;
const mailto = encodeURIComponent(POLITE_EMAIL);

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': ua } });
  if (!res.ok) throw new Error(`OpenAlex ${res.status} on ${url}`);
  return res.json();
}

console.log(`Fetching OpenAlex data for ORCID ${ORCID} ...`);

try {
  // 1) Author summary stats
  const author = await get(`https://api.openalex.org/authors/orcid:${ORCID}?mailto=${mailto}`);
  const summary = author?.summary_stats ?? {};

  const stats = {
    works_count: author.works_count ?? 0,
    cited_by_count: author.cited_by_count ?? 0,
    h_index: summary.h_index ?? 0,
    i10_index: summary.i10_index ?? 0,
    two_year_mean_citedness: summary['2yr_mean_citedness'] ?? 0,
    openalex_id: author.id ?? null,
    display_name: author.display_name ?? null,
    last_updated: new Date().toISOString().slice(0, 10),
    source: 'OpenAlex',
  };

  writeFileSync(
    resolve(dataDir, 'stats.json'),
    JSON.stringify(stats, null, 2) + '\n',
    'utf8',
  );

  console.log('Author stats:');
  console.log('  works:    ', stats.works_count);
  console.log('  citations:', stats.cited_by_count);
  console.log('  h-index:  ', stats.h_index);
  console.log('  i10:      ', stats.i10_index);

  // 2) Per-work citation counts, keyed by lowercase DOI
  const citations = {};
  let cursor = '*';
  let pageNo = 0;
  while (cursor) {
    pageNo++;
    const url = `https://api.openalex.org/works?filter=authorships.author.orcid:${ORCID}&per-page=200&cursor=${cursor}&mailto=${mailto}`;
    const page = await get(url);
    for (const w of page.results || []) {
      if (w.doi) {
        const doi = w.doi.replace(/^https?:\/\/doi\.org\//i, '').toLowerCase().trim();
        citations[doi] = w.cited_by_count ?? 0;
      }
    }
    cursor = page.meta?.next_cursor ?? null;
    if (pageNo > 10) break; // safety
  }

  writeFileSync(
    resolve(dataDir, 'citations.json'),
    JSON.stringify(
      { last_updated: stats.last_updated, source: 'OpenAlex', counts: citations },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(`Per-DOI citation counts: ${Object.keys(citations).length} works indexed`);
} catch (err) {
  console.error('Failed to fetch OpenAlex data:', err);
  process.exit(1);
}
