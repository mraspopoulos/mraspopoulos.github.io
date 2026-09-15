#!/usr/bin/env node
/**
 * Fetch per-publication citation counts from Semantic Scholar, then compute
 * aggregate stats locally from those counts.
 *
 * Outputs:
 *   - src/data/stats.json          works, citations, h-index, i10
 *   - src/data/citations.json      { "10.xxxx/yyyy": 42, ... }
 *   - src/data/missing.json        diagnostic — DOIs Semantic Scholar could
 *                                  not find, and pubs without a DOI
 *
 * Env vars:
 *   SEMANTIC_SCHOLAR_API_KEY   optional but recommended
 */

import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY || null;
const REQUEST_DELAY_MS = API_KEY ? 300 : 1200;

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const pubsDir = resolve(__dirname, '..', 'src', 'content', 'publications');

const headers = { 'Accept': 'application/json' };
if (API_KEY) headers['x-api-key'] = API_KEY;

async function withRetry(fn, label) {
  const delays = [2000, 5000, 15000, 30000];
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

// Read every publication .md file and extract useful metadata for logging.
function readPublications() {
  const files = readdirSync(pubsDir).filter((f) => f.endsWith('.md'));
  return files.map((f) => {
    const content = readFileSync(resolve(pubsDir, f), 'utf8');
    const grab = (field) => {
      const m = content.match(new RegExp(`^${field}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, 'm'));
      return m ? m[1].trim() : null;
    };
    return {
      file: f,
      doi: (grab('doi') || '').toLowerCase() || null,
      title: grab('title') || null,
      year: grab('year') ? parseInt(grab('year'), 10) : null,
      venue: grab('venue') || null,
      type: grab('type') || null,
    };
  });
}

// Look up citation counts one DOI at a time. Returns {counts, notFoundDois, failedDois}.
async function fetchCitations(dois) {
  const counts = {};
  const notFound = [];
  const failed = [];

  for (let i = 0; i < dois.length; i++) {
    const doi = dois[i];
    const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=citationCount`;
    const idx = `[${String(i + 1).padStart(3, ' ')}/${dois.length}]`;
    try {
      const paper = await get(url);
      const n = typeof paper?.citationCount === 'number' ? paper.citationCount : null;
      if (n !== null) {
        counts[doi] = n;
        process.stdout.write(`  ${idx} ${doi.padEnd(45)} → ${n}\n`);
      } else {
        notFound.push({ doi, reason: 'paper found but citationCount was null' });
        process.stdout.write(`  ${idx} ${doi.padEnd(45)} → no count\n`);
      }
    } catch (err) {
      const is404 = String(err.message).includes('404');
      if (is404) {
        notFound.push({ doi, reason: 'not indexed by Semantic Scholar' });
        process.stdout.write(`  ${idx} ${doi.padEnd(45)} → not found\n`);
      } else {
        failed.push({ doi, reason: err.message });
        process.stdout.write(`  ${idx} ${doi.padEnd(45)} → FAILED (${err.message.slice(0, 40)}...)\n`);
      }
    }
    if (i < dois.length - 1) await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  }
  return { counts, notFound, failed };
}

// h-index (Hirsch): largest N such that N papers each have >= N citations
function computeHIndex(countsArr) {
  const sorted = [...countsArr].sort((a, b) => b - a);
  let h = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] >= i + 1) h = i + 1;
    else break;
  }
  return h;
}

// ---- main ----
console.log('Fetching Semantic Scholar per-paper counts and computing local aggregates.');
console.log(`API key: ${API_KEY ? 'present' : 'not set (using shared pool)'}`);
console.log(`Request pacing: ${REQUEST_DELAY_MS}ms\n`);

try {
  const pubs = readPublications();
  const totalPubs = pubs.length;
  const withDoi = pubs.filter((p) => p.doi);
  const withoutDoi = pubs.filter((p) => !p.doi);
  const dois = [...new Set(withDoi.map((p) => p.doi))];

  console.log(`Publications on site: ${totalPubs}`);
  console.log(`  with DOI:    ${withDoi.length}`);
  console.log(`  without DOI: ${withoutDoi.length}\n`);

  console.log('Looking up each DOI ...\n');
  const { counts, notFound, failed } = await fetchCitations(dois);

  // ---- Aggregates from what we got ----
  const countsArr = Object.values(counts);
  const totalCitations = countsArr.reduce((s, n) => s + n, 0);
  const hIndex = computeHIndex(countsArr);
  const i10Index = countsArr.filter((n) => n >= 10).length;
  const today = new Date().toISOString().slice(0, 10);

  const statsOut = {
    works_count: totalPubs,
    cited_by_count: totalCitations,
    h_index: hIndex,
    i10_index: i10Index,
    last_updated: today,
    source: 'Semantic Scholar',
    note: `Aggregates computed locally from per-DOI Semantic Scholar counts. works_count reflects all publications on the site; citations, h-index and i10 are computed from the DOIs Semantic Scholar has indexed.`,
  };
  writeFileSync(resolve(dataDir, 'stats.json'), JSON.stringify(statsOut, null, 2) + '\n', 'utf8');

  writeFileSync(
    resolve(dataDir, 'citations.json'),
    JSON.stringify({ last_updated: today, source: 'Semantic Scholar', counts }, null, 2) + '\n',
    'utf8',
  );

  // ---- Diagnostic file for missing/problematic publications ----
  const notFoundByDoi = new Map(notFound.map((x) => [x.doi, x.reason]));
  const failedByDoi = new Map(failed.map((x) => [x.doi, x.reason]));

  const missing = {
    last_updated: today,
    summary: {
      publications_on_site: totalPubs,
      with_doi: withDoi.length,
      without_doi: withoutDoi.length,
      doi_indexed_ok: Object.keys(counts).length,
      doi_not_indexed: notFound.length,
      doi_lookup_failed: failed.length,
    },
    without_doi: withoutDoi.map((p) => ({
      file: p.file,
      title: p.title,
      year: p.year,
      venue: p.venue,
      type: p.type,
      action: 'Add a doi: line to the publication .md frontmatter so Semantic Scholar can look it up.',
    })),
    not_indexed_by_semantic_scholar: withDoi
      .filter((p) => notFoundByDoi.has(p.doi))
      .map((p) => ({
        file: p.file,
        title: p.title,
        year: p.year,
        venue: p.venue,
        doi: p.doi,
        reason: notFoundByDoi.get(p.doi),
        action: 'Verify the DOI is correct on doi.org. If correct but Semantic Scholar has not indexed the paper, contact them at feedback@semanticscholar.org with the DOI.',
      })),
    lookup_failed: withDoi
      .filter((p) => failedByDoi.has(p.doi))
      .map((p) => ({
        file: p.file,
        title: p.title,
        doi: p.doi,
        reason: failedByDoi.get(p.doi),
        action: 'Transient failure. Should self-correct on the next run.',
      })),
  };
  writeFileSync(resolve(dataDir, 'missing.json'), JSON.stringify(missing, null, 2) + '\n', 'utf8');

  console.log('\n=== Aggregate stats (computed locally) ===');
  console.log(`  works:      ${statsOut.works_count}`);
  console.log(`  citations:  ${statsOut.cited_by_count}`);
  console.log(`  h-index:    ${statsOut.h_index}`);
  console.log(`  i10-index:  ${statsOut.i10_index}`);

  console.log('\n=== Missing/problematic ===');
  console.log(`  Without DOI in frontmatter: ${withoutDoi.length}`);
  console.log(`  DOI not indexed by S2:      ${notFound.length}`);
  console.log(`  DOI lookup failed:          ${failed.length}`);
  console.log(`\nDetails written to src/data/missing.json for review.`);
} catch (err) {
  console.error('\nFailed:', err.message);
  process.exit(1);
}
