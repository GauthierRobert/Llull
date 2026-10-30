/**
 * VC-DEF-22 (01 DEF FR-DEF-34, §17.13) on the real native kernel: an exact deformation is written to STEP (AP242, the XDE writer) and read back with `import_step_exact`:
 * the read solid has exact faces (the same count), B-spline surfaces where the warp fitted them (analytic ones where `preserveAnalytic` rebuilt them) and the same exact
 * volume within 2e-6 relative (see the note on the mass rule in §17.13).
 */

import { expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { describeNative, liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
const ctx = (): ExecutionContext => ({ ...defaultContext(), kernel: kernels.occt });
const run = (doc: CadDocument, name: string, params: Record<string, unknown> = {}): CommandResult => execute(doc, name, params, ctx());
const FRAME = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] } as const;

const volumeOf = (doc: CadDocument, id: string): number =>
  (run(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
const surfacesOf = (doc: CadDocument, id: string): string[] => {
  const topology = run(doc, 'inspect_topology', { id });
  return (topology.data as { faces: Array<{ surface: string }> }).faces.map((face) => face.surface).sort();
};

describeNative('STEP round trip of an exact deformation (VC-DEF-22, native kernel)', () => {
  const roundTrip = (doc: CadDocument, id: string): { back: CadDocument; imported: string } => {
    const exported = run(doc, 'export_step_ap242', { entityIds: [id], timestamp: '2026-10-30T00:00:00' });
    const text = (exported.data as { step: string }).step;
    expect(text, exported.summary).toContain('ISO-10303-21');
    const back = run(createEmptyDocument(), 'import_step_exact', { text, fileName: `${id}.stp` });
    expect(back.rejected, back.summary).toBeUndefined();
    const [imported] = back.affected;
    expect(imported, back.summary).toBeDefined();
    return { back: back.document, imported: imported as string };
  };
  const deformed = (
    add: [string, Record<string, unknown>],
    command: string,
    params: Record<string, unknown>,
  ): { doc: CadDocument; id: string } => {
    const base = run(createEmptyDocument(), add[0], add[1]);
    const result = run(base.document, command, {
      id: base.affected[0],
      ...(command === 'deform_by_point' ? {} : { frame: FRAME }),
      ...params,
    });
    expect(result.error, result.summary).toBeUndefined();
    expect((result.data as { path: string }).path).toBe('exact');
    return { doc: result.document, id: result.affected[0] as string };
  };

  it('a tapered cylinder, a twisted box and a pushed slab keep their volume, their faces and their B-spline surfaces', () => {
    const cases: Array<[string, { doc: CadDocument; id: string }]> = [
      [
        'taper',
        deformed(['add_cylinder', { radius: 5, height: 40, anchor: 'base-center' }], 'taper_body', {
          scaleEnd: 0.4,
          region: { start: 0, end: 40, falloff: 'linear' },
          output: { mode: 'exact', tolerance: 1e-4 },
        }),
      ],
      [
        'twist',
        deformed(['add_box', { size: [10, 10, 40], anchor: 'base-center' }], 'twist_body', {
          angleDeg: 70,
          region: { start: 0, end: 40, falloff: 'linear' },
          output: { mode: 'exact', tolerance: 1e-4 },
        }),
      ],
      [
        'push',
        deformed(['add_box', { size: [40, 40, 10], anchor: 'base-center' }], 'deform_by_point', {
          point: [0, 0, 10],
          direction: [0, 0, 1],
          radius: 8,
          distance: 2,
          falloff: 'smooth_c2',
          output: { mode: 'exact', tolerance: 1e-4 },
        }),
      ],
    ];
    for (const [label, { doc, id }] of cases) {
      const { back, imported } = roundTrip(doc, id);
      const before = volumeOf(doc, id);
      const after = volumeOf(back, imported);
      expect(Math.abs(after - before) / before, `${label}: volume ${before} -> ${after}`).toBeLessThan(2e-6);
      // the exchange itself is lossless: a second round trip (both reads use the same mass rule) gives the same volume
      const again = roundTrip(back, imported);
      expect(Math.abs(volumeOf(again.back, again.imported) - after) / after, label).toBeLessThan(1e-9);
      const [kindsBefore, kindsAfter] = [surfacesOf(doc, id), surfacesOf(back, imported)];
      expect(kindsAfter.length, label).toBe(kindsBefore.length);
      expect(
        kindsAfter.filter((kind) => kind === 'bspline' || kind === 'other').length,
        `${label}: B-spline faces ${kindsAfter}`,
      ).toBeGreaterThan(0);
    }
  }, 300_000);

  it('with preserveAnalytic the cone and the planes stay analytic through STEP', () => {
    const { doc, id } = deformed(['add_cylinder', { radius: 5, height: 40, anchor: 'base-center' }], 'taper_body', {
      scaleEnd: 0.4,
      region: { start: 0, end: 40, falloff: 'linear' },
      output: { mode: 'exact', tolerance: 1e-4, preserveAnalytic: true },
    });
    expect(surfacesOf(doc, id)).toEqual(['cone', 'plane', 'plane']);
    const { back, imported } = roundTrip(doc, id);
    expect(surfacesOf(back, imported)).toEqual(['cone', 'plane', 'plane']);
    expect(Math.abs(volumeOf(back, imported) - volumeOf(doc, id)) / volumeOf(doc, id)).toBeLessThan(1e-6);
  }, 180_000);
});
