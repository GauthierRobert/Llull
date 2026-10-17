/**
 * Builds the aerospace seed material library (08 MAT M4) from the VERIFIED entries of
 * docs/aerospace/08-materials-standards-libraries/validation/materials_dataset.json:
 *   packages/domain-aero/data/seed.llull-matlib.json   llull-material-library, import with import_material_library
 *   packages/domain-aero/data/sources.lock.json        every source the seed cites (TR-MAT-41)
 *
 * Only entries with status exactly "verified" are bundled. Nothing is invented: no allowable is typed in this file. Sources whose terms
 * forbid bundling (OQ-MAT-06: MatWeb typical values) are excluded. `--check` fails when the committed files differ from a fresh build.
 *
 *   node scripts/build-seed-library.mjs [--check]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATASET = join(ROOT, 'docs/aerospace/08-materials-standards-libraries/validation/materials_dataset.json');
const DATA_DIR = join(ROOT, 'packages/domain-aero/data');
const ACCESSED = '2026-10-15';
const FETCH_ATTEMPT = '2026-10-17';
const FETCH_RESULT = 'HTTP 403 (CONNECT tunnel failed) from the build sandbox proxy; the primary file was never downloaded';

/** Sources the dataset cites for verified values (validation/sources.md). `excluded` carries the reason a source is not bundled. */
const SOURCES = {
  S10: { excluded: 'OQ-MAT-06: MatWeb / datasheet typical values are validation-only' },
  S12: { excluded: 'OQ-MAT-06: MatWeb / datasheet typical values are validation-only' },
  S13: {
    citation: 'Michlin Metals, 7075 AMS 4154 / AMS 4045 (supplier page)',
    url: 'https://www.michlinmetals.com/7075-aluminum-round-bar-ams-4154-ams-4045-sheet-plate/',
    grade: 'supplier',
  },
  S15: {
    citation: 'Rolled Alloys, Data Sheet - 6Al-4V Titanium (supplier datasheet)',
    url: 'https://www.rolledalloys.com/wp-content/uploads/6AL4V_Data-sheet.pdf',
    grade: 'supplier',
  },
  S16: {
    citation: 'Aircraft Materials, Ti-6Al-4V typical annealed sheet properties; titanium.com AMS 4911 summary',
    url: 'https://www.aircraftmaterials.com/data/titanium/ti6al4v.html',
    grade: 'typical / supplier',
  },
  S21: {
    citation: 'AIA/NAS NAS6203-6220 catalogue entry (GlobalSpec / Accuris): 160 KSI Ftu bolt',
    url: 'https://store.accuristech.com/standards/aia-nas6203-6220?product_id=2926055',
    grade: 'catalogue',
  },
  S22: {
    citation: 'Airfasco NAS6203 / NAS6204 product pages (minimum shear 95 ksi)',
    url: 'https://airfasco.com/products/NAS/NAS6203THRUNAS6220/NAS6204.php',
    grade: 'distributor',
  },
  S26: {
    citation: 'Hi-Shear HL18 drawing (AAE store); HL10 / HL18 shear 95 ksi',
    url: 'https://www.aaestore.com.au/media/specs/HL18.pdf',
    grade: 'manufacturer drawing / distributor',
  },
  S38: {
    citation: 'MIL-HDBK-5J (31 January 2003, cancelled), EverySpec listing',
    url: 'https://everyspec.com/MIL-HDBK/MIL-HDBK-0001-0099/MIL_HDBK_5J_139/',
    grade: 'primary (index)',
    milHdbk5J: true,
  },
};

/** Dataset key prefix -> { property, basis override }. A verified key outside this table stops the build (nothing is guessed). */
const KEYS = {
  density: { property: 'density' },
  tensileModulus: { property: 'E' },
  shearModulus: { property: 'G' },
  poisson: { property: 'nu' },
  Ftu: { property: 'Ftu' },
  Fty: { property: 'Fty' },
  elongation: { property: 'elongation' },
};
const FASTENER_KEYS = { Ftu_min: 'Ftu', Fsu_min: 'Fsu' };
const UNITS = { '-': '1' };
const BASES = new Set(['A', 'B', 'S', 'typical', 'supplier_unstated', 'company', 'unspecified']);
const MIL_SUPERSEDED = { by: 'MMPDS', note: 'MIL-HDBK-5J cancelled 2003; superseded by MMPDS' };

const usable = (entry) => entry !== null && typeof entry === 'object' && entry.status === 'verified' && !SOURCES[entry.source]?.excluded;

function modelOf(materialId, group, key, entry, property, basis) {
  const source = SOURCES[entry.source];
  if (source === undefined || source.excluded !== undefined)
    throw new Error(`verified value ${materialId}.${key} cites unregistered source ${entry.source}`);
  if (!BASES.has(basis)) throw new Error(`${materialId}.${key}: basis '${basis}' is not a llull basis`);
  return {
    id: key,
    property,
    unit: UNITS[entry.unit] ?? entry.unit,
    variables: [],
    validity: [],
    form: { kind: 'constant', value: entry.value },
    basis,
    ...(entry.thickness_in !== undefined
      ? { condition: { thickness: { min: entry.thickness_in[0], max: entry.thickness_in[1], unit: 'in' } } }
      : {}),
    provenance: {
      sourceId: entry.source,
      citation: source.citation,
      locator: `validation/materials_dataset.json#${materialId}.${group}.${key}${entry.note ? ` (${entry.note})` : ''}; sources.md ${entry.source}`,
      url: source.url,
      accessed: ACCESSED,
    },
  };
}

function materialModels(material) {
  const models = [];
  for (const group of ['physical', 'mechanical']) {
    for (const [key, entry] of Object.entries(material[group] ?? {})) {
      if (!usable(entry)) continue;
      const rule = KEYS[key.split('_')[0]];
      if (rule === undefined) throw new Error(`verified value ${material.id}.${key} has no property mapping`);
      models.push(modelOf(material.id, group, key, entry, rule.property, entry.basis));
    }
  }
  return models;
}

/** Library material from a dataset material; null when none of its values is bundled. */
function libraryMaterial(material) {
  const propertyModels = materialModels(material);
  if (propertyModels.length === 0) return null;
  const cited = new Set(propertyModels.map((model) => model.provenance.sourceId));
  const superseded = [...cited].some((id) => SOURCES[id]?.milHdbk5J === true);
  return {
    id: material.id,
    name: material.id,
    designation: material.designation,
    ...(material.temper !== undefined && material.temper !== 'tbd' ? { temper: material.temper } : {}),
    ...(material.productForm !== undefined && material.productForm !== 'tbd' ? { productForm: material.productForm } : {}),
    specs: (material.specs ?? []).filter((spec) => spec.status === 'verified').map((spec) => ({ body: spec.body, id: spec.id })),
    licence: 'vendor-catalogue',
    exportMarking: { regime: 'none' },
    ...(superseded ? { superseded: MIL_SUPERSEDED } : {}),
    propertyModels,
  };
}

function fastenerMaterial(row) {
  const propertyModels = Object.entries(FASTENER_KEYS).flatMap(([key, property]) =>
    usable(row[key]) ? [modelOf(row.id, 'fastenerMaterialAllowables', key, row[key], property, row[key].basis ?? 'supplier_unstated')] : [],
  );
  if (propertyModels.length === 0) return null;
  return {
    id: row.id,
    name: row.id,
    designation: row.appliesTo,
    productForm: 'fastener',
    specs: [],
    licence: 'vendor-catalogue',
    exportMarking: { regime: 'none' },
    propertyModels,
  };
}

export function buildSeed(dataset) {
  const materials = [...dataset.materials.map(libraryMaterial), ...dataset.fastenerMaterialAllowables.map(fastenerMaterial)].filter(
    (material) => material !== null,
  );
  const cited = [...new Set(materials.flatMap((m) => m.propertyModels.map((model) => model.provenance.sourceId)))].sort();
  const library = {
    format: 'llull-material-library',
    schemaVersion: 1,
    id: 'llull-aero-seed',
    version: '0.1.0',
    title: 'llull aerospace seed library (verified entries only; supplier / typical / specification-minimum values, no design allowables)',
    licence: 'vendor-catalogue',
    exportMarking: { regime: 'none' },
    storage: 'embedded',
    sources: Object.fromEntries(cited.map((id) => [id, { citation: SOURCES[id].citation, url: SOURCES[id].url, accessed: ACCESSED }])),
    materials,
  };
  const lockedIds = [...new Set([...cited, ...Object.keys(SOURCES).filter((id) => SOURCES[id].milHdbk5J === true)])].sort();
  const lock = {
    schema: 'llull-sources-lock/1',
    note: 'sha256 pins the primary file (TR-MAT-41). null = the file could not be fetched (reason given): the value is still traceable by URL and locator but not content-pinned.',
    sources: Object.fromEntries(
      lockedIds.map((id) => [
        id,
        {
          citation: SOURCES[id].citation,
          url: SOURCES[id].url,
          grade: SOURCES[id].grade,
          sha256: null,
          size: null,
          retrieved: null,
          unpinned: { reason: 'primary file not fetched', attempted: FETCH_ATTEMPT, result: FETCH_RESULT },
          ...(SOURCES[id].milHdbk5J === true ? { milHdbk5J: true, supersededBy: 'MMPDS' } : {}),
        },
      ]),
    ),
  };
  return { library, lock };
}

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

function main() {
  const { library, lock } = buildSeed(JSON.parse(readFileSync(DATASET, 'utf8')));
  const outputs = [
    [join(DATA_DIR, 'seed.llull-matlib.json'), serialize(library)],
    [join(DATA_DIR, 'sources.lock.json'), serialize(lock)],
  ];
  if (process.argv.includes('--check')) {
    const stale = outputs.filter(([path, text]) => {
      try {
        return readFileSync(path, 'utf8') !== text;
      } catch {
        return true;
      }
    });
    if (stale.length > 0) {
      console.error(`stale: ${stale.map(([path]) => path).join(', ')} (run node scripts/build-seed-library.mjs)`);
      process.exit(1);
    }
    return;
  }
  for (const [path, text] of outputs) writeFileSync(path, text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
