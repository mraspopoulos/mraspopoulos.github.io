#!/usr/bin/env node
/**
 * Fetch academic stats and per-publication citation counts from Semantic Scholar.
 *
 * Semantic Scholar typically reports counts closer to Google Scholar than
 * OpenAlex does — a better fit for engineering papers with heavy conference
 * citations.
 *
 * Outputs:
 *   - src/data/stats.json       (works, citations, h-index, i10)
 *   - src/data/citations.json   ({ "10.xxxx/yyyy": 42, ... })
 *
 * Runs weekly via .github/workflows/update-stats.yml
 *
 * With an API key set via SEMANTIC_SCHOLAR_API_KEY: fast, ~1 req/second.
 * Without a key: uses the shared pool with retry-with-backoff and 1.2s pacing.
 * Either way the script goes through DOIs one at a time so a rate limit on
 * one paper only affects that paper, not the whole run.
 */

import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AUTHOR_NAME = process.env.AUTHOR_NAME || 'Marios Raspopoulos';
const ORCID = process.env.ORCID || '0000-0003-1513-6018';
const AFFILIATION_HINT = (process.env.AFFILIATION_HINT || 'UCLan').toLowerCase();
const API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY || null;

// Pacing between per-DOI requests. With an API key you can drop this to ~300ms.
const REQUEST_DELAY_MS = API_KEY ? 300 : 1200;

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const pubsDir = resolve(__dirname, '..', 'src', 'content', 'publications');

const headers = { 'Accept': 'application/json' };
if (API_KEY) headers['x-api-key'] = API_KEY;

// ---- HTTP with retry-on-429 ----
async function withRetry(fn, label) {
  const delays = [2000, 5000, 15000, 30000]; // ms
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = String(err.message).includes('429');
      if (!is429 || i === delays.length) throw err;
      console.log(`    rate limited on ${label}, waiting ${delays[i] / 1000}s ...`);
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

async function get(url) {
  return withRetry(async () => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Semantic Scholar ${res.status} on ${url}`);
    return res.json();
  }, url.split('?')[0].split('/').pop());
}

// ---- Read local DOIs ----
function readPublicationDois() {
  const files = readdirSync(pubsDir).filter((f) => f.endsWith('.md'));
  const dois = [];
  for (const f of files) {
    const content = readFileSync(resolve(pubsDir, f), 'utf8');
    const m = content.match(/^doi:\s*['"]?([^'"\n]+)['"]?\s*$/m);
    if (m) {
      const doi = m[1].trim().toLowerCase();
      if (doi && doi.startsWith('10.')) dois.push(doi);
    }
  }
  return [...new Set(dois)];
}

// ---- Find author on Semantic Scholar ----
async function findAuthorId() {
  const url =
    `https://api.semanticscholar.org/graph/v1/author/search?` +
    `query=${encodeURIComponent(AUTHOR_NAME)}` +
    `&fields=name,affiliations,externalIds,hIndex,paperCount,citationCount` +
    `&limit=25`;
  const data = await get(url);
  const candidates = data.data || [];

  let match = candidates.find(
    (c) => c.externalIds?.ORCID === ORCID || c.externalIds?.orcid === ORCID,
  );
  if (match) return { authorId: match.authorId, matchedVia: 'ORCID' };

  match = candidates.find(
    (c) =>
      c.name?.toLowerCase().includes('raspopoulos') &&
      (c.affiliations || []).some((a) => a.toLowerCase().includes(AFFILIATION_HINT)),
  );
  if (match) return { authorId: match.authorId, matchedVia: 'name+affiliation' };

  const raspopouloses = candidates
    .filter((c) => c.name?.toLowerCase().includes('raspopoulos'))
    .sort((a, b) => (b.hIndex || 0) - (a.hIndex || 0));
  if (raspopouloses.length > 0) {
    return { authorId: raspopouloses[0].authorId, matchedVia: 'name (best h-index)' };
  }
  throw new Error('No matching author found on Semantic Scholar.');
}

async function getAuthorStats(authorId) {
  return get(
    `https://api.semanticscholar.org/graph/v1/author/${authorId}` +
      `?fields=name,hIndex,citationCount,paperCount,externalIds`,
  );
}

// ---- Fetch per-DOI citation counts, one at a time ----
async function getCitationsPerDoi(dois) {
  if (dois.length === 0) return {};
  const counts = {};
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < dois.length; i++) {
    const doi = dois[i];
    const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=citationCount`;
    try {
      const paper = await get(url);
      const n = typeof paper?.citationCount === 'number' ? paper.citationCount : null;
      if (n !== null) {
        counts[doi] = n;
        ok++;
      }
      process.stdout.write(`  [${String(i + 1).padStart(3, ' ')}/${dois.length}] ${doi} → ${n ?? '—'}\n`);
    } catch (err) {
      fail++;
      console.log(`  [${String(i + 1).padStart(3, ' ')}/${dois.length}] ${doi} → FAILED (${err.message})`);
    }
    if (i < dois.length - 1) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  }
  console.log(`\nFetched ${ok}/${dois.length} papers (${fail} failed).`);
  return counts;
}

// ---- main ----
console.log(`Fetching Semantic Scholar data for ${AUTHOR_NAME} (${ORCID}) ...`);
console.log(`API key: ${API_KEY ? 'present' : 'not set (using shared pool)'}`);
console.log(`Request pacing: ${REQUEST_DELAY_MS}ms between calls\n`);

try {
  const dois = readPublicationDois();
  console.log(`Local DOIs found: ${dois.length}\n`);

  const { authorId, matchedVia } = await findAuthorId();
  console.log(`Matched author id ${authorId} via ${matchedVia}`);
  console.log(`Verify at: https://www.semanticscholar.org/author/${authorId}\n`);

  const stats = await getAuthorStats(authorId);
  console.log('Fetching per-paper citation counts ...\n');
  const counts = await getCitationsPerDoi(dois);

  const i10 = Object.values(counts).filter((c) => c >= 10).length;

  const statsOut = {
    works_count: stats.paperCount ?? 0,
    cited_by_count: stats.citationCount ?? 0,
    h_index: stats.hIndex ?? 0,
    i10_index: i10,
    author_id: authorId,
    author_url: `https://www.semanticscholar.org/author/${authorId}`,
    display_name: stats.name ?? null,
    last_updated: new Date().toISOString().slice(0, 10),
    source: 'Semantic Scholar',
    note: 'i10_index computed from DOIs listed on this site; other stats from Semantic Scholar author record.',
  };

  writeFileSync(
    resolve(dataDir, 'stats.json'),
    JSON.stringify(statsOut, null, 2) + '\n',
    'utf8',
  );

  writeFileSync(
    resolve(dataDir, 'citations.json'),
    JSON.stringify(
      {
        last_updated: statsOut.last_updated,
        source: 'Semantic Scholar',
        author_id: authorId,
        counts,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log('\nAuthor stats (Semantic Scholar):');
  console.log('  works:    ', statsOut.works_count);
  console.log('  citations:', statsOut.cited_by_count);
  console.log('  h-index:  ', statsOut.h_index);
  console.log('  i10:      ', statsOut.i10_index, '(computed from local DOIs)');
  console.log(`\nWrote src/data/stats.json and src/data/citations.json`);
} catch (err) {
  console.error('\nFailed to fetch Semantic Scholar data:', err.message);
  process.exit(1);
}
