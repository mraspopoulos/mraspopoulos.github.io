#!/usr/bin/env node
/**
 * Fetch per-publication citation counts from Semantic Scholar.
 *
 * Looks up each publication by whichever identifier it has:
 *   1. doi:                    — preferred, works for most papers
 *   2. semantic_scholar_id:    — for papers without a DOI (book chapters,
 *                                old conference proceedings). Find the ID
 *                                by opening the paper on semanticscholar.org
 *                                and copying the 40-char hex from the URL.
 *
 * Papers with neither identifier are listed in missing.json as needing
 * attention. Aggregate stats (total citations, h-index, i10) are computed
 * locally from all successfully-looked-up counts.
 *
 * Outputs:
 *   - src/data/stats.json
 *   - src/data/citations.json   (keyed by DOI or by "s2:{paperId}")
 *   - src/data/missing.json     (diagnostic)
 *
 * Env: SEMANTIC_SCHOLAR_API_KEY   optional but recommended
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
      semantic_scholar_id: grab('semantic_scholar_id') || null,
      isbn: grab('isbn') || null,
      title: grab('title'),
      year: grab('year') ? parseInt(grab('year'), 10) : null,
      venue: grab('venue'),
      type: grab('type'),
    };
  });
}

// Build the lookup URL and the key to use in citations.json
function planLookup(pub) {
  if (pub.doi) {
    return {
      lookupUrl: `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(pub.doi)}?fields=citationCount`,
      key: pub.doi,
      via: 'doi',
    };
  }
  if (pub.semantic_scholar_id) {
    return {
      lookupUrl: `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(pub.semantic_scholar_id)}?fields=citationCount`,
      key: `s2:${pub.semantic_scholar_id}`,
      via: 'semantic_scholar_id',
    };
  }
  return null;
}

async function fetchAllCitations(pubs) {
  const counts = {};
  const notFound = []; // has an identifier but S2 didn't find it
  const failed = [];
  const noIdentifier = []; // no doi and no semantic_scholar_id

  const lookupPlans = [];
  for (const p of pubs) {
    const plan = planLookup(p);
    if (plan) lookupPlans.push({ pub: p, ...plan });
    else noIdentifier.push(p);
  }

  for (let i = 0; i < lookupPlans.length; i++) {
    const { pub, lookupUrl, key, via } = lookupPlans[i];
    const idx = `[${String(i + 1).padStart(3, ' ')}/${lookupPlans.length}]`;
    try {
      const paper = await get(lookupUrl);
      const n = typeof paper?.citationCount === 'number' ? paper.citationCount : null;
      if (n !== null) {
        counts[key] = n;
        process.stdout.write(`  ${idx} ${via.padEnd(4)}  ${key.slice(0, 45).padEnd(45)}  ${n}\n`);
      } else {
        notFound.push({ pub, key, via, reason: 'paper found but citationCount was null' });
        process.stdout.write(`  ${idx} ${via.padEnd(4)}  ${key.slice(0, 45).padEnd(45)}  no count\n`);
      }
    } catch (err) {
      const is404 = String(err.message).includes('404');
      if (is404) {
        notFound.push({ pub, key, via, reason: 'not indexed by Semantic Scholar' });
        process.stdout.write(`  ${idx} ${via.padEnd(4)}  ${key.slice(0, 45).padEnd(45)}  not found\n`);
      } else {
        failed.push({ pub, key, via, reason: err.message });
        process.stdout.write(`  ${idx} ${via.padEnd(4)}  ${key.slice(0, 45).padEnd(45)}  FAILED\n`);
      }
    }
    if (i < lookupPlans.length - 1) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  }
  return { counts, notFound, failed, noIdentifier };
}

function computeHIndex(arr) {
  const sorted = [...arr].sort((a, b) => b - a);
  let h = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] >= i + 1) h = i + 1;
    else break;
  }
  return h;
}

console.log('Fetching Semantic Scholar per-paper counts and computing local aggregates.');
console.log(`API key: ${API_KEY ? 'present' : 'not set (using shared pool)'}`);
console.log(`Request pacing: ${REQUEST_DELAY_MS}ms\n`);

try {
  const pubs = readPublications();
  const totalPubs = pubs.length;
  const byDoi = pubs.filter((p) => p.doi).length;
  const byS2Id = pubs.filter((p) => !p.doi && p.semantic_scholar_id).length;
  const noId = pubs.filter((p) => !p.doi && !p.semantic_scholar_id).length;

  console.log(`Publications on site: ${totalPubs}`);
  console.log(`  looked up by DOI:               ${byDoi}`);
  console.log(`  looked up by semantic_scholar_id: ${byS2Id}`);
  console.log(`  no identifier at all:            ${noId}\n`);

  console.log('Looking up each paper ...\n');
  const { counts, notFound, failed, noIdentifier } = await fetchAllCitations(pubs);

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
    note: 'Aggregates computed locally from per-paper Semantic Scholar counts. Papers with a doi: or semantic_scholar_id: in their frontmatter are looked up; others count toward works_count only.',
  };
  writeFileSync(resolve(dataDir, 'stats.json'), JSON.stringify(statsOut, null, 2) + '\n', 'utf8');

  writeFileSync(
    resolve(dataDir, 'citations.json'),
    JSON.stringify({ last_updated: today, source: 'Semantic Scholar', counts }, null, 2) + '\n',
    'utf8',
  );

  const missing = {
    last_updated: today,
    summary: {
      publications_on_site: totalPubs,
      looked_up_by_doi: byDoi,
      looked_up_by_s2_id: byS2Id,
      no_identifier: noId,
      lookup_ok: Object.keys(counts).length,
      not_indexed: notFound.length,
      lookup_failed: failed.length,
    },
    no_identifier: noIdentifier.map((p) => ({
      file: p.file,
      title: p.title,
      year: p.year,
      venue: p.venue,
      type: p.type,
      isbn: p.isbn ?? null,
      action:
        p.isbn
          ? 'Has ISBN — no DOI. To include in citation totals, look up the paper on semanticscholar.org, copy the 40-char hex id from the URL, and add: semantic_scholar_id: \'<id>\''
          : 'No doi: or semantic_scholar_id: in frontmatter. Add one so this paper contributes to citation totals.',
    })),
    not_indexed_by_semantic_scholar: notFound.map((x) => ({
      file: x.pub.file,
      title: x.pub.title,
      year: x.pub.year,
      via: x.via,
      identifier: x.key,
      reason: x.reason,
      action:
        x.via === 'doi'
          ? 'Verify the DOI is correct on doi.org. If correct but Semantic Scholar still cannot find it, contact feedback@semanticscholar.org.'
          : 'Verify the semantic_scholar_id is correct — open the paper on semanticscholar.org and re-copy the id from the URL.',
    })),
    lookup_failed: failed.map((x) => ({
      file: x.pub.file,
      title: x.pub.title,
      via: x.via,
      identifier: x.key,
      reason: x.reason,
      action: 'Transient failure; should self-correct on the next run.',
    })),
  };
  writeFileSync(resolve(dataDir, 'missing.json'), JSON.stringify(missing, null, 2) + '\n', 'utf8');

  console.log('\n=== Aggregate stats (computed locally) ===');
  console.log(`  works:      ${statsOut.works_count}`);
  console.log(`  citations:  ${statsOut.cited_by_count}`);
  console.log(`  h-index:    ${statsOut.h_index}`);
  console.log(`  i10-index:  ${statsOut.i10_index}`);

  console.log('\n=== Diagnostics ===');
  console.log(`  successfully looked up:    ${Object.keys(counts).length}`);
  console.log(`  no identifier:             ${noIdentifier.length}`);
  console.log(`  not indexed by S2:         ${notFound.length}`);
  console.log(`  lookup failed:             ${failed.length}`);
  console.log('\nDetails in src/data/missing.json');
} catch (err) {
  console.error('\nFailed:', err.message);
  process.exit(1);
}
