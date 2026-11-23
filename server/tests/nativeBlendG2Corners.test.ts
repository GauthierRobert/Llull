/**
 * BLD §13.36 on the native OCCT kernel: the corner star of a curvature-profile step is curvature-continuous (G2) to the blend and flat faces it meets,
 * so a G2 chain stays G2 through its corners; check_blends reads it with `require: "G2"`. The edges between two sub-patches (spokes) are curvature-continuous beyond the first
 * fifth of each spoke from its vertex (§13.38); next to the vertices they are tangent.
 * Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

interface Contact {
  readonly edge: number;
  readonly g1AngleRad: number;
  readonly g2Gap: number;
  readonly g2Rel: number;
  readonly order: string;
}
interface Checked {
  readonly status: string;
  readonly blends: Array<{ readonly kind: string; readonly profile: string; readonly contacts: readonly Contact[] }>;
  readonly findings: Array<{ code: string; severity: string; value?: number; limit?: number; message?: string }>;
}
interface Notes {
  readonly corners?: Array<{
    readonly patch: string;
    readonly continuity?: string;
    readonly g2Refused?: string;
    readonly spokes?: string;
    readonly spokeReach?: number;
    readonly spokeRelative?: number;
    readonly spokeVertexRelative?: number;
    readonly spokeJump?: number;
  }>;
}

describeNative('BLD 13.36: G2 corner stars of curvature-profile steps (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const rounded = (profile: Record<string, unknown>): { doc: CadDocument; id: string; notes: Notes } => {
    const made = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10], anchor: 'min' });
    const done = execute(made.document, 'fillet_edge', { id: made.affected[0] as string, radius: 1, profile });
    expect(done.error).toBeUndefined();
    return { doc: done.document, id: done.affected[0] as string, notes: (done.data as { profile: Notes }).profile };
  };
  const check = (doc: CadDocument, id: string, require: 'G1' | 'G2'): Checked =>
    execute(doc, 'check_blends', { ids: [id], require }).data as Checked;

  it('a curvature-profile cube has vertex fans (13.45, the default since 13.46): its spokes are curvature-continuous to the vertices and check_blends require G2 raises no finding', () => {
    const { doc, id, notes } = rounded({ type: 'curvature', shape: 0.5 });
    expect(notes.corners).toHaveLength(8);
    for (const corner of notes.corners ?? []) {
      expect([corner.continuity, corner.spokes, corner.spokeReach]).toEqual(['G2', 'G2-fan', 0]);
      // measured on the fan seams (the build gate is 0.02 relative + a floor per length, so a small curvature may read up to a few per cent): under 0.1 everywhere, the absolute jump a few per mille (the 13.38 spokes read 0.83 at the vertex)
      expect(corner.spokeRelative).toBeLessThan(0.1);
      expect(corner.spokeVertexRelative).toBeLessThan(0.1);
      expect(corner.spokeJump).toBeLessThan(5e-3);
    }
    const checked = check(doc, id, 'G2');
    expect(checked.findings.filter((found) => found.severity === 'fail')).toEqual([]);
    // 6 trimmed sub-patches and 12 fans per corner, each with one contact with a blend or flat face or a seam
    const corners = checked.blends.filter((row) => row.kind === 'corner');
    expect(corners).toHaveLength(8 * 18);
    const contacts = corners.flatMap((row) => row.contacts);
    for (const contact of contacts) expect(contact.g1AngleRad).toBeLessThan(1e-3);
    expect(checked.findings.some((found) => found.code === 'BLD_CHECK_SPOKE_G2_LOST')).toBe(false);
    expect(checked.findings.some((found) => found.code === 'BLD_CHECK_G2_JUMP')).toBe(false);
    expect(checked.findings.filter((found) => found.code === 'BLD_CHECK_SPOKE_G2')).toEqual([]);
    expect(checked.status).toBe('pass');
  }, 120_000);

  it('the conic cube keeps the G1 star: require G2 fails at its corner contacts', () => {
    const { doc, id, notes } = rounded({ type: 'conic', rho: 0.5 });
    for (const corner of notes.corners ?? []) expect(corner.continuity).toBe('G1');
    const checked = check(doc, id, 'G2');
    expect(checked.findings.some((found) => found.code === 'BLD_CHECK_G2_JUMP' && found.severity === 'fail')).toBe(true);
  });

  it('a curvature profile whose G2 star is refused is built G1 and the refusal is named in the corner note', () => {
    const { notes } = rounded({ type: 'curvature', shape: 0.05 });
    for (const corner of notes.corners ?? []) {
      expect(corner.continuity).toBe('G1');
      expect(corner.g2Refused).toContain('the curvature of the supports by');
    }
  });
});
