#!/usr/bin/env node
/**
 * Fetch academic stats and per-publication citation counts from Semantic Scholar.
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
 * No API key required for this volume (~2 requests per run). If you hit rate
 * limits, request a key at https://www.semanticscholar.org/product/api#api-key-form
 * and set the SEMANTIC_SCHOLAR_API_KEY env var (or GitHub secret).
 */

import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AUTHOR_NAME = process.env.AUTHOR_NAME || 'Marios Raspopoulos';
const ORCID = process.env.ORCID || '0000-0003-1513-6018';
const AFFILIATION_HINT = (process.env.AFFILIATION_HINT || 'UCLan').toLowerCase();
const API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY || null;

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const pubsDir = resolve(__dirname, '..', 'src', 'content', 'publications');

const headers = { 'Accept': 'application/json' };
if (API_KEY) headers['x-api-key'] = API_KEY;

async function get(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Semantic Scholar ${res.status} on ${url}`);
  return res.json();
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Semantic Scholar ${res.status} on ${url}`);
  return res.json();
}

// Read all publication DOIs from src/content/publications/*.md
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

// Find the Semantic Scholar author record for our person
async function findAuthorId() {
  const searchUrl =
    `https://api.semanticscholar.org/graph/v1/author/search?` +
    `query=${encodeURIComponent(AUTHOR_NAME)}` +
    `&fields=name,affiliations,externalIds,hIndex,paperCount,citationCount` +
    `&limit=25`;
  const data = await get(searchUrl);
  const candidates = data.data || [];

  // 1) Prefer ORCID match
  let match = candidates.find(
    (c) => c.externalIds?.ORCID === ORCID || c.externalIds?.orcid === ORCID,
  );
  if (match) return { authorId: match.authorId, matchedVia: 'ORCID', author: match };

  // 2) Name + affiliation
  match = candidates.find(
    (c) =>
      c.name?.toLowerCase().includes('raspopoulos') &&
      (c.affiliations || []).some((a) => a.toLowerCase().includes(AFFILIATION_HINT)),
  );
  if (match) return { authorId: match.authorId, matchedVia: 'name+affiliation', author: match };

  // 3) Highest h-index Raspopoulos
  const raspopouloses = candidates
    .filter((c) => c.name?.toLowerCase().includes('raspopoulos'))
    .sort((a, b) => (b.hIndex || 0) - (a.hIndex || 0));
  if (raspopouloses.length > 0) {
    return { authorId: raspopouloses[0].authorId, matchedVia: 'name (best h-index)', author: raspopouloses[0] };
  }

  throw new Error('No matching author found on Semantic Scholar.');
}

// Fetch authoritative aggregate stats
async function getAuthorStats(authorId) {
  return get(
    `https://api.semanticscholar.org/graph/v1/author/${authorId}` +
      `?fields=name,hIndex,citationCount,paperCount,externalIds`,
  );
}

// Batch-fetch citation counts by DOI (max 500 per request)
async function getCitationsBatch(dois) {
  if (dois.length === 0) return {};
  const ids = dois.map((d) => `DOI:${d}`);
  const results = await post(
    `https://api.semanticscholar.org/graph/v1/paper/batch?fields=externalIds,citationCount`,
    { ids },
  );

  const counts = {};
  results.forEach((paper, i) => {
    if (paper && typeof paper.citationCount === 'number') {
      counts[dois[i]] = paper.citationCount;
    }
  });
  return counts;
}

// ---------------- main ----------------
console.log(`Fetching Semantic Scholar data for ${AUTHOR_NAME} (${ORCID}) ...`);

try {
  const dois = readPublicationDois();
  console.log(`Local DOIs found: ${dois.length}`);

  const { authorId, matchedVia, author } = await findAuthorId();
  console.log(`Matched author id ${authorId} via ${matchedVia}`);

  const stats = await getAuthorStats(authorId);
  const counts = await getCitationsBatch(dois);

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

  console.log('Author stats (Semantic Scholar):');
  console.log('  works:    ', statsOut.works_count);
  console.log('  citations:', statsOut.cited_by_count);
  console.log('  h-index:  ', statsOut.h_index);
  console.log('  i10:      ', statsOut.i10_index, '(computed from local DOIs)');
  console.log(`Per-DOI counts written: ${Object.keys(counts).length} of ${dois.length} DOIs matched`);
} catch (err) {
  console.error('Failed to fetch Semantic Scholar data:', err.message);
  process.exit(1);
}
