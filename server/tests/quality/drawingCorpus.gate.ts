/**
 * Drawing-to-model gate: every part of quality/drawings/manifest.json was modelled in llull from a
 * published 2D technical drawing (plan in quality/drawings/plans/<id>.json) and verified against
 * the real 3D part. This replays each plan through `build_project` on the live OCC kernel and
 * checks the exact B-rep volume (the drawing's mass answer / the reference solid) and the overall
 * extents, so a kernel or command regression that changes geometry fails here.
 *
 *   npm run quality:drawings
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptyDocument, is3D, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createNodeOcctKernel } from '../../src/occtNode';

const DIR = path.resolve(__dirname, '../../../quality/drawings');

interface DrawingPart {
  readonly id: string;
  readonly title: string;
  /** Exact solid volume of the real part (mm³): official mass / density, else the reference solid. */
  readonly volume: number;
  /** Allowed relative volume error. */
  readonly volumeTolerance: number;
  /** Reference overall extents (mm), sorted ascending. */
  readonly extents: readonly [number, number, number];
}

const manifest = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) as { readonly parts: readonly DrawingPart[] };

beforeAll(async () => setGeometryKernel(await createNodeOcctKernel()), 120_000);

function build(id: string): CadDocument {
  const actions: unknown = JSON.parse(readFileSync(path.join(DIR, 'plans', `${id}.json`), 'utf8'));
  const result = execute(createEmptyDocument(), 'build_project', { actions });
  expect(result.summary, id).toMatch(/plan step\(s\) ok/);
  expect(result.summary, id).not.toMatch(/failed|rolled back/);
  return result.document;
}

/** Exact volume of every 3D solid of `doc` (mm³). */
function solidVolume(doc: CadDocument): number {
  let total = 0;
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (entity === undefined || !is3D(entity)) continue;
    const measured = execute(doc, 'mass_properties', { entityId: id });
    total += (measured.data as { volume: number } | undefined)?.volume ?? 0;
  }
  return total;
}

/** Overall extents of the 3D solids (leftover sketch pieces excluded), sorted ascending. */
function sortedExtents(doc: CadDocument): number[] {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (entity === undefined || !is3D(entity)) continue;
    const box = execute(doc, 'measure_bounding_box', { entityId: id }).data as { min: number[]; max: number[] };
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis] ?? Infinity, box.min[axis] ?? Infinity);
      max[axis] = Math.max(max[axis] ?? -Infinity, box.max[axis] ?? -Infinity);
    }
  }
  return max.map((value, axis) => value - (min[axis] ?? 0)).sort((a, b) => a - b);
}

describe('drawing corpus: plans rebuild the real parts', () => {
  it.each(manifest.parts.map((part) => [part.id, part] as const))('%s', (_id, part) => {
    const doc = build(part.id);
    const volume = solidVolume(doc);
    expect(Math.abs(volume / part.volume - 1), `${part.title}: volume ${volume}`).toBeLessThan(part.volumeTolerance);
    sortedExtents(doc).forEach((size, axis) =>
      expect(Math.abs(size - (part.extents[axis] ?? 0)), `${part.title} extent ${axis}`).toBeLessThan(0.5),
    );
  });
});
