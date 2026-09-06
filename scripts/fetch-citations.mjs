#!/usr/bin/env node
/**
 * Fetch academic stats and per-publication citation counts from Semantic Scholar.
 *
 * Multi-profile aware: finds ALL author records on Semantic Scholar matching
 * the configured name, filters them to only those that plausibly belong to
 * this person (via ORCID, affiliation, or shared co-authors with other
 * confirmed profiles), then combines their papers, de-duplicates by DOI,
 * and computes aggregate stats from the union.
 *
 * Per-paper citation counts are still looked up individually by DOI, so
 * they're always accurate regardless of which profile a paper is under.
 *
 * Outputs:
 *   - src/data/stats.json       (works, citations, h-index, i10)
 *   - src/data/citations.json   ({ "10.xxxx/yyyy": 42, ... })
 *
 * Env vars:
 *   ORCID                      required — used to pick trusted profiles
 *   AUTHOR_NAME                default "Marios Raspopoulos"
 *   AFFILIATION_HINT           default "UCLan"; substring match, case insensitive
 *   SEMANTIC_SCHOLAR_API_KEY   optional — recommended
 *   MANUAL_AUTHOR_IDS          optional CSV of author IDs to force-include
 *                              (use if a profile can't be auto-detected)
 */

import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AUTHOR_NAME = process.env.AUTHOR_NAME || 'Marios Raspopoulos';
const ORCID = process.env.ORCID || '0000-0003-1513-6018';
const AFFILIATION_HINT = (process.env.AFFILIATION_HINT || 'UCLan').toLowerCase();
const API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY || null;
const MANUAL_IDS = (process.env.MANUAL_AUTHOR_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const REQUEST_DELAY_MS = API_KEY ? 300 : 1200;

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const pubsDir = resolve(__dirname, '..', 'src', 'content', 'publications');

const headers = { 'Accept': 'application/json' };
if (API_KEY) headers['x-api-key'] = API_KEY;

// ---- HTTP with retry-on-429 ----
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

async function pause(ms = REQUEST_DELAY_MS) {
  await new Promise((r) => setTimeout(r, ms));
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

// ---- Find all candidate author profiles ----
async function findCandidateProfiles() {
  const url =
    `https://api.semanticscholar.org/graph/v1/author/search?` +
    `query=${encodeURIComponent(AUTHOR_NAME)}` +
    `&fields=name,affiliations,externalIds,hIndex,paperCount,citationCount,homepage` +
    `&limit=50`;
  const data = await get(url);
  return (data.data || []).filter((c) =>
    c.name?.toLowerCase().includes('raspopoulos'),
  );
}

// A profile is "trusted" (definitely this person) if:
//   - its ORCID matches, OR
//   - its affiliation contains our hint (e.g. "UCLan"), OR
//   - we're manually forcing it via env var
function classifyProfile(p) {
  if (MANUAL_IDS.includes(p.authorId)) return 'manual';
  const orcid = p.externalIds?.ORCID || p.externalIds?.orcid;
  if (orcid === ORCID) return 'orcid';
  const aff = (p.affiliations || []).map((s) => s.toLowerCase());
  if (aff.some((a) => a.includes(AFFILIATION_HINT))) return 'affiliation';
  return null; // ambiguous — needs further disambiguation
}

// For ambiguous profiles, check whether they share co-authors with trusted ones.
// Two profiles for the same real person will typically overlap heavily on co-authors.
async function fetchPapersForAuthor(authorId, limit = 100) {
  const url =
    `https://api.semanticscholar.org/graph/v1/author/${authorId}/papers?` +
    `fields=externalIds,title,year,authors&limit=${limit}`;
  const data = await get(url);
  return data.data || [];
}
function coauthorSet(papers, selfId) {
  const set = new Set();
  for (const p of papers) {
    for (const a of p.authors || []) {
      if (a.authorId && a.authorId !== selfId) set.add(a.authorId);
    }
  }
  return set;
}
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---- Fetch per-DOI citation counts, one at a time ----
async function getCitationsPerDoi(dois) {
  if (dois.length === 0) return {};
  const counts = {};
  let ok = 0, fail = 0;
  for (let i = 0; i < dois.length; i++) {
    const doi = dois[i];
    const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=citationCount`;
    try {
      const paper = await get(url);
      const n = typeof paper?.citationCount === 'number' ? paper.citationCount : null;
      if (n !== null) { counts[doi] = n; ok++; }
      process.stdout.write(`    [${String(i + 1).padStart(3, ' ')}/${dois.length}] ${doi} → ${n ?? '—'}\n`);
    } catch (err) {
      fail++;
      console.log(`    [${String(i + 1).padStart(3, ' ')}/${dois.length}] ${doi} → FAILED (${err.message})`);
    }
    if (i < dois.length - 1) await pause();
  }
  console.log(`  Fetched ${ok}/${dois.length} per-DOI counts (${fail} failed).`);
  return counts;
}

// ---- main ----
console.log(`Fetching Semantic Scholar data for ${AUTHOR_NAME} (${ORCID}) ...`);
console.log(`API key: ${API_KEY ? 'present' : 'not set (using shared pool)'}`);
console.log(`Request pacing: ${REQUEST_DELAY_MS}ms\n`);

try {
  const localDois = readPublicationDois();
  console.log(`Local DOIs in site: ${localDois.length}\n`);

  // 1) Discover candidate profiles
  console.log('Discovering author profiles ...');
  const candidates = await findCandidateProfiles();
  console.log(`  Found ${candidates.length} candidate profile(s) named "Raspopoulos"`);
  for (const c of candidates) {
    const label = classifyProfile(c) ?? 'ambiguous';
    console.log(`    - ${c.authorId}  ${c.name.padEnd(28)}  ${label.padEnd(11)}  h=${c.hIndex ?? '?'}  papers=${c.paperCount ?? '?'}`);
  }

  const trusted = candidates.filter((c) => classifyProfile(c) !== null);
  const ambiguous = candidates.filter((c) => classifyProfile(c) === null);

  if (trusted.length === 0) {
    throw new Error('No trusted author profile found. Set MANUAL_AUTHOR_IDS env var to force include.');
  }

  console.log(`\n  Trusted profiles: ${trusted.length}`);
  console.log(`  Ambiguous profiles: ${ambiguous.length}`);

  // 2) For ambiguous profiles, check co-author overlap with trusted ones.
  //    High overlap (Jaccard > 0.15) = probably the same person under a different profile.
  const confirmedIds = new Set(trusted.map((c) => c.authorId));
  if (ambiguous.length > 0 && trusted.length > 0) {
    console.log('\nChecking co-author overlap for ambiguous profiles ...');
    const trustedCoauthorSets = new Map();
    for (const t of trusted) {
      await pause();
      const papers = await fetchPapersForAuthor(t.authorId, 50);
      trustedCoauthorSets.set(t.authorId, coauthorSet(papers, t.authorId));
    }
    for (const amb of ambiguous) {
      await pause();
      const papers = await fetchPapersForAuthor(amb.authorId, 50);
      const ambCoauthors = coauthorSet(papers, amb.authorId);
      let bestSim = 0;
      for (const [tid, tset] of trustedCoauthorSets) {
        bestSim = Math.max(bestSim, jaccard(ambCoauthors, tset));
      }
      const merge = bestSim >= 0.15;
      console.log(`    - ${amb.authorId}  ${amb.name.padEnd(28)}  co-author overlap ${(bestSim * 100).toFixed(1)}%  ${merge ? 'MERGE' : 'skip'}`);
      if (merge) confirmedIds.add(amb.authorId);
    }
  }

  console.log(`\nFinal profiles to combine: ${confirmedIds.size}`);
  for (const id of confirmedIds) console.log(`  - https://www.semanticscholar.org/author/${id}`);

  // 3) Collect all papers across confirmed profiles, deduped by DOI (falling back
  //    to Semantic Scholar paperId when no DOI is present)
  console.log('\nCollecting papers from all confirmed profiles ...');
  const paperMap = new Map(); // key: doi or "sspaper:<id>", value: {citationCount, year}
  for (const id of confirmedIds) {
    await pause();
    // paginate — 100 per call
    let offset = 0;
    while (true) {
      const url =
        `https://api.semanticscholar.org/graph/v1/author/${id}/papers?` +
        `fields=externalIds,citationCount,year,title&limit=100&offset=${offset}`;
      const data = await get(url);
      const papers = data.data || [];
      for (const p of papers) {
        const doi = p.externalIds?.DOI?.toLowerCase();
        const key = doi ? doi : `sspaper:${p.paperId}`;
        if (!paperMap.has(key)) {
          paperMap.set(key, {
            citationCount: p.citationCount ?? 0,
            year: p.year,
            title: p.title,
          });
        }
      }
      console.log(`  ${id}: fetched ${papers.length} at offset ${offset} (running total unique: ${paperMap.size})`);
      if (papers.length < 100) break;
      offset += 100;
      await pause();
    }
  }

  // 4) Compute aggregate stats from the combined, deduped set
  const allCounts = [...paperMap.values()].map((p) => p.citationCount).sort((a, b) => b - a);
  const worksCount = paperMap.size;
  const totalCitations = allCounts.reduce((s, n) => s + n, 0);
  let hIndex = 0;
  for (let i = 0; i < allCounts.length; i++) {
    if (allCounts[i] >= i + 1) hIndex = i + 1; else break;
  }
  const i10Index = allCounts.filter((n) => n >= 10).length;

  // 5) Per-DOI counts for the badges on the publications page.
  //    These use direct DOI lookups so they're independent of author attribution.
  console.log(`\nFetching per-DOI counts for site publications ...`);
  const perDoi = await getCitationsPerDoi(localDois);

  // 6) Write outputs
  const today = new Date().toISOString().slice(0, 10);
  const statsOut = {
    works_count: worksCount,
    cited_by_count: totalCitations,
    h_index: hIndex,
    i10_index: i10Index,
    combined_from_authors: [...confirmedIds],
    author_urls: [...confirmedIds].map((id) => `https://www.semanticscholar.org/author/${id}`),
    last_updated: today,
    source: 'Semantic Scholar',
    note: 'Aggregate stats combined across multiple Semantic Scholar author profiles that all belong to this person. Per-DOI counts are direct paper lookups.',
  };
  writeFileSync(resolve(dataDir, 'stats.json'), JSON.stringify(statsOut, null, 2) + '\n', 'utf8');
  writeFileSync(
    resolve(dataDir, 'citations.json'),
    JSON.stringify({
      last_updated: today,
      source: 'Semantic Scholar',
      combined_from_authors: [...confirmedIds],
      counts: perDoi,
    }, null, 2) + '\n',
    'utf8',
  );

  console.log('\n=== Combined author stats ===');
  console.log(`  works (unique):  ${statsOut.works_count}`);
  console.log(`  total citations: ${statsOut.cited_by_count}`);
  console.log(`  h-index:         ${statsOut.h_index}`);
  console.log(`  i10-index:       ${statsOut.i10_index}`);
  console.log(`\nWrote src/data/stats.json and src/data/citations.json`);
} catch (err) {
  console.error('\nFailed:', err.message);
  process.exit(1);
}
