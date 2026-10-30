/**
 * Release package of a revision whose sheet shows an asset-backed mesh (TECHNICAL_SPEC 13.22): the drawing is rebuilt from the frozen definition with the host's
 * context, so the stored mesh is read (a package without the context dropped the sheet with a MESH_ASSET_LOD_ONLY note although the asset is held).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newEntity } from '@core/commands/entity/newEntity';
import type { CadDocument, Entity } from '@core/model/types';
import { icosphere } from '../../tests/helpers/meshFixtures';
import { T, approveAll, reviewWithEco } from '../../tests/unit/plm/fixtures';
import { run } from '../../tests/unit/plm/scenarioRunner';
import { defaultMeshAssetStore } from '../src/meshAssets/store';
import { buildReleasePackage } from '../src/plm/releasePackage';

process.env['LLULL_MESH_CACHE'] = path.join(mkdtempSync(path.join(tmpdir(), 'llull-release-mesh-')), 'cache');

/** A released revision A of the sample part with one sheet, holding one asset-backed mesh (display: an 80-triangle sphere). */
function releasedWithScan(options: { held: boolean }): CadDocument {
  const stored = icosphere(10, 4);
  const reference = defaultMeshAssetStore().writeMesh(stored);
  const asset = options.held ? reference : { ...reference, key: 'f'.repeat(64), triangles: 99_999 };
  const scan: Entity = newEntity('mesh', 'scan', { mesh: icosphere(10, 1), asset }, [0, 0, 0], '#cccccc');
  const base = reviewWithEco();
  const rejected = run(base, 'reject_review', { comment: 'add the drawing', at: T, by: 'u-1' }).document;
  const withScan = { ...rejected, entities: { ...rejected.entities, scan }, order: [...rejected.order, 'scan'] };
  const drawn = run(withScan, 'create_sheet', { name: 'S1', views: ['front'] }).document;
  const review = run(drawn, 'submit_for_review', { at: T, by: 'u-1' }).document;
  return run(approveAll(review), 'release_item', { changeOrder: 'ECO-0100', at: T, by: 'u-1' }).document;
}

describe('buildReleasePackage with a sheet that shows a stored mesh', () => {
  it('writes the sheet (the stored mesh is read through the host context)', () => {
    const pack = buildReleasePackage(releasedWithScan({ held: true }), 'A', '0.1.0');
    expect(typeof pack).not.toBe('string');
    if (typeof pack === 'string') return;
    expect(pack.notes).toEqual([]);
    expect(pack.files.some((file) => file.path.startsWith('drawings/') && file.content.includes('<svg'))).toBe(true);
  });

  it('an asset this machine does not hold is a note naming the display level of detail, not a sheet of it', () => {
    const pack = buildReleasePackage(releasedWithScan({ held: false }), 'A', '0.1.0');
    if (typeof pack === 'string') throw new Error(pack);
    expect(pack.files.some((file) => file.path.startsWith('drawings/'))).toBe(false);
    expect(pack.notes.join(' ')).toContain('display level of detail');
  });
});
