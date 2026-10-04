/**
 * @layer quality
 *
 * Download the pinned quality-gate corpus (quality/corpus.json) into .cache/quality-corpus/.
 * Every file is verified against its sha256; a cached file with the right hash is not re-fetched.
 * Synthetic entries are skipped: `npm run quality:generate` (quality/synthetic_step.py) makes them.
 *
 *   node quality/fetchCorpus.mjs [--tier smoke|full|stress] [--format step|dxf]
 *
 * Tiers are cumulative: smoke ⊂ full ⊂ stress. Default: $QUALITY_TIER, else full (as the gates).
 * Exit code 1 if any download fails or any hash mismatches.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CORPUS_DIR = join(ROOT, '.cache', 'quality-corpus');
const TIERS = ['smoke', 'full', 'stress'];

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** File name in the cache: `<id>.<format>`. */
export function cachedName(entry) {
  return `${entry.id}.${entry.format}`;
}

async function cachedIsValid(path, expected) {
  try {
    return sha256(await readFile(path)) === expected;
  } catch {
    return false;
  }
}

async function fetchEntry(entry) {
  const target = join(CORPUS_DIR, cachedName(entry));
  if (await cachedIsValid(target, entry.sha256)) return 'cached';
  const response = await fetch(entry.url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${entry.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== entry.sha256) {
    throw new Error(`sha256 mismatch for ${entry.id}: expected ${entry.sha256}, got ${actual}`);
  }
  await writeFile(`${target}.part`, bytes);
  await rename(`${target}.part`, target);
  return 'downloaded';
}

async function main() {
  const tier = argument('tier', process.env.QUALITY_TIER ?? 'full');
  const format = argument('format', null);
  if (!TIERS.includes(tier)) throw new Error(`--tier must be one of ${TIERS.join(', ')}`);
  const manifest = JSON.parse(await readFile(join(ROOT, 'quality', 'corpus.json'), 'utf8'));
  const wanted = manifest.files.filter(
    (entry) =>
      entry.source !== 'synthetic' &&
      TIERS.indexOf(entry.tier) <= TIERS.indexOf(tier) &&
      (format === null || entry.format === format),
  );
  await mkdir(CORPUS_DIR, { recursive: true });
  let failures = 0;
  for (const entry of wanted) {
    try {
      const outcome = await fetchEntry(entry);
      process.stdout.write(`${outcome.padEnd(10)} ${entry.id} (${entry.bytes} bytes)\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(`FAILED     ${entry.id}: ${error.message}\n`);
    }
  }
  process.stdout.write(`${wanted.length - failures}/${wanted.length} files in ${CORPUS_DIR}\n`);
  if (failures > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
