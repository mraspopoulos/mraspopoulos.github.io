#!/usr/bin/env node
/**
 * Fetch per-publication citation counts from Semantic Scholar, with
 * monotonic protection against transient API glitches.
 *
 * Citation counts only ever go UP in reality — papers do not un-get-cited.
 * If the fetched count for a paper is LOWER than what we already have on
 * disk from yesterday, we treat that as suspicious, retry the lookup a
 * few more times, and if it is STILL lower we keep the previous (higher)
 * value and log the incident in missing.json.
 *
 * Supports lookup by:
 *   - doi:                    preferred, works for most papers
 *   - semantic_scholar_id:    for papers without a DOI
 *
 * Outputs:
 *   - src/data/stats.json
 *   - src/data/citations.json   (keyed by DOI or by "s2:{paperId}")
 *   - src/data/missing.json     diagnostic
 *
 * Env:
 *   SEMANTIC_SCHOLAR_API_KEY   optional but recommended
 *   DISABLE_MONOTONIC_CLAMP    set to "1" to allow decreases (rare — for
 *                              one-off manual recalibration only)
 */

import { writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY || null;
const REQUEST_DELAY_MS = API_KEY ? 300 : 1200;
const DISABLE_CLAMP = process.env.DISABLE_MONOTONIC_CLAMP === '1';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const pubsDir = resolve(__dirname, '..', 'src', 'content', 'publications');

const headers = { Accept: 'application/json' };
if (API_KEY) headers['x-api-key'] = API_KEY;

// -------- HTTP with retry-on-429 --------
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

// -------- Read publications --------
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

// -------- Read previous citations.json for comparison --------
function readPreviousCounts() {
  const path = resolve(dataDir, 'citations.json');
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed?.counts ?? {};
  } catch {
    return {};
  }
}

// -------- Lookup plan per publication --------
function planLookup(pub) {
  if (pub.doi) {
    return {
      lookupUrl: (d) =>
        `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(d)}?fields=citationCount`,
      arg: pub.doi,
      key: pub.doi,
      via: 'doi',
    };
  }
  if (pub.semantic_scholar_id) {
    return {
      lookupUrl: (id) =>
        `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=citationCount`,
      arg: pub.semantic_scholar_id,
      key: `s2:${pub.semantic_scholar_id}`,
      via: 'semantic_scholar_id',
    };
  }
  return null;
}

// -------- Fetch a single count, returns number or null --------
async function fetchCount(plan) {
  const paper = await get(plan.lookupUrl(plan.arg));
  return typeof paper?.citationCount === 'number' ? paper.citationCount : null;
}

// -------- Main fetch loop with monotonic protection --------
async function fetchAllCitations(pubs, previousCounts) {
  const counts = {};
  const notFound = [];
  const failed = [];
  const noIdentifier = [];
  const suspiciousDecreases = [];

  const plans = [];
  for (const p of pubs) {
    const plan = planLookup(p);
    if (plan) plans.push({ pub: p, ...plan });
    else noIdentifier.push(p);
  }

  for (let i = 0; i < plans.length; i++) {
    const { pub, key, via } = plans[i];
    const idx = `[${String(i + 1).padStart(3, ' ')}/${plans.length}]`;
    const previous = previousCounts[key];
    const hasPrevious = typeof previous === 'number';

    try {
      let fetchedCount = await fetchCount(plans[i]);

      // Monotonic protection: if the new count is lower than what we had
      // from yesterday, retry a couple more times with longer delays.
      if (
        !DISABLE_CLAMP &&
        hasPrevious &&
        fetchedCount !== null &&
        fetchedCount < previous
      ) {
        const extraDelays = [3000, 8000]; // ms between retries
        const attempts = [fetchedCount];
        for (const delay of extraDelays) {
          await new Promise((r) => setTimeout(r, delay));
          try {
            const retried = await fetchCount(plans[i]);
            attempts.push(retried);
            if (retried !== null && retried >= previous) {
              fetchedCount = retried;
              break;
            }
          } catch {
            attempts.push(null);
          }
        }

        // After all retries, if still lower than previous, keep previous
        const finalMax = Math.max(previous, ...attempts.filter((n) => typeof n === 'number'));
        if (finalMax > fetchedCount) {
          suspiciousDecreases.push({
            pub,
            key,
            via,
            previous,
            fetched: fetchedCount,
            retried: attempts.slice(1),
            kept: previous,
          });
          counts[key] = previous;
          process.stdout.write(
            `  ${idx} ${via.padEnd(4)}  ${key.slice(0, 40).padEnd(40)}  ${fetchedCount} → kept ${previous} (decrease)\n`,
          );
          if (i < plans.length - 1) await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
          continue;
        }
        // Retry succeeded in getting the correct (higher) number
      }

      if (fetchedCount !== null) {
        counts[key] = fetchedCount;
        const marker = hasPrevious && fetchedCount > previous ? ` (↑${fetchedCount - previous})` : '';
        process.stdout.write(
          `  ${idx} ${via.padEnd(4)}  ${key.slice(0, 40).padEnd(40)}  ${fetchedCount}${marker}\n`,
        );
      } else {
        // No count returned at all — if we had a previous value, keep it
        if (hasPrevious) {
          counts[key] = previous;
          process.stdout.write(
            `  ${idx} ${via.padEnd(4)}  ${key.slice(0, 40).padEnd(40)}  no count → kept ${previous}\n`,
          );
        } else {
          notFound.push({ pub, key, via, reason: 'paper found but citationCount was null' });
          process.stdout.write(`  ${idx} ${via.padEnd(4)}  ${key.slice(0, 40).padEnd(40)}  no count\n`);
        }
      }
    } catch (err) {
      const is404 = String(err.message).includes('404');
      if (is404) {
        if (hasPrevious) {
          // Paper vanished from the index temporarily — keep previous
          counts[key] = previous;
          process.stdout.write(
            `  ${idx} ${via.padEnd(4)}  ${key.slice(0, 40).padEnd(40)}  not found → kept ${previous}\n`,
          );
        } else {
          notFound.push({ pub, key, via, reason: 'not indexed by Semantic Scholar' });
          process.stdout.write(`  ${idx} ${via.padEnd(4)}  ${key.slice(0, 40).padEnd(40)}  not found\n`);
        }
      } else {
        if (hasPrevious) {
          counts[key] = previous;
          process.stdout.write(
            `  ${idx} ${via.padEnd(4)}  ${key.slice(0, 40).padEnd(40)}  FAILED → kept ${previous}\n`,
          );
        } else {
          failed.push({ pub, key, via, reason: err.message });
          process.stdout.write(`  ${idx} ${via.padEnd(4)}  ${key.slice(0, 40).padEnd(40)}  FAILED\n`);
        }
      }
    }

    if (i < plans.length - 1) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  }

  return { counts, notFound, failed, noIdentifier, suspiciousDecreases };
}

// -------- h-index (Hirsch) --------
function computeHIndex(arr) {
  const sorted = [...arr].sort((a, b) => b - a);
  let h = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] >= i + 1) h = i + 1;
    else break;
  }
  return h;
}

// -------- main --------
console.log('Fetching Semantic Scholar per-paper counts with monotonic protection.');
console.log(`API key: ${API_KEY ? 'present' : 'not set (using shared pool)'}`);
console.log(`Request pacing: ${REQUEST_DELAY_MS}ms`);
console.log(`Monotonic clamp: ${DISABLE_CLAMP ? 'DISABLED (allowing decreases)' : 'enabled (decreases blocked)'}\n`);

try {
  const pubs = readPublications();
  const totalPubs = pubs.length;
  const byDoi = pubs.filter((p) => p.doi).length;
  const byS2Id = pubs.filter((p) => !p.doi && p.semantic_scholar_id).length;
  const noId = pubs.filter((p) => !p.doi && !p.semantic_scholar_id).length;

  console.log(`Publications on site: ${totalPubs}`);
  console.log(`  looked up by DOI:                ${byDoi}`);
  console.log(`  looked up by semantic_scholar_id: ${byS2Id}`);
  console.log(`  no identifier at all:             ${noId}\n`);

  const previousCounts = readPreviousCounts();
  const previousCount = Object.keys(previousCounts).length;
  console.log(`Previous citations.json: ${previousCount} entries from last run\n`);

  console.log('Looking up each paper ...\n');
  const { counts, notFound, failed, noIdentifier, suspiciousDecreases } =
    await fetchAllCitations(pubs, previousCounts);

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
    note: 'Aggregates computed locally from per-paper Semantic Scholar counts. Monotonic protection: decreases vs the previous day are retried and, if still lower, the older higher value is kept.',
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
      suspicious_decreases: suspiciousDecreases.length,
    },
    no_identifier: noIdentifier.map((p) => ({
      file: p.file,
      title: p.title,
      year: p.year,
      venue: p.venue,
      type: p.type,
      isbn: p.isbn ?? null,
      action: p.isbn
        ? 'Has ISBN but no DOI. To include in totals, look up the paper on semanticscholar.org, copy the 40-char hex id from the URL, and add: semantic_scholar_id: \'<id>\''
        : 'No doi: or semantic_scholar_id: in frontmatter.',
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
          ? 'Verify the DOI on doi.org. If correct but Semantic Scholar has not indexed it, email feedback@semanticscholar.org.'
          : 'Verify the semantic_scholar_id is correct.',
    })),
    lookup_failed: failed.map((x) => ({
      file: x.pub.file,
      title: x.pub.title,
      via: x.via,
      identifier: x.key,
      reason: x.reason,
      action: 'Transient failure; should self-correct on the next run.',
    })),
    suspicious_decreases: suspiciousDecreases.map((x) => ({
      file: x.pub.file,
      title: x.pub.title,
      via: x.via,
      identifier: x.key,
      previous: x.previous,
      fetched_values: [x.fetched, ...x.retried],
      kept: x.kept,
      action:
        'Semantic Scholar returned a lower citation count than yesterday. After 3 attempts the lower value persisted. Keeping the previous higher value as a safety measure. If the true count really did drop (very rare), you can run the script locally with DISABLE_MONOTONIC_CLAMP=1 to force a reset.',
    })),
  };
  writeFileSync(resolve(dataDir, 'missing.json'), JSON.stringify(missing, null, 2) + '\n', 'utf8');

  console.log('\n=== Aggregate stats ===');
  console.log(`  works:      ${statsOut.works_count}`);
  console.log(`  citations:  ${statsOut.cited_by_count}`);
  console.log(`  h-index:    ${statsOut.h_index}`);
  console.log(`  i10-index:  ${statsOut.i10_index}`);

  console.log('\n=== Diagnostics ===');
  console.log(`  successfully looked up:    ${Object.keys(counts).length}`);
  console.log(`  no identifier:             ${noIdentifier.length}`);
  console.log(`  not indexed by S2:         ${notFound.length}`);
  console.log(`  lookup failed:             ${failed.length}`);
  console.log(`  suspicious decreases:      ${suspiciousDecreases.length} (reverted to previous value)`);
  console.log('\nDetails in src/data/missing.json');
} catch (err) {
  console.error('\nFailed:', err.message);
  process.exit(1);
}
