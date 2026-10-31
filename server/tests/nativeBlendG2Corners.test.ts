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
  readonly findings: Array<{ code: string; severity: string }>;
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

  it('a curvature-profile cube has no failing finding under check_blends require G2; the seams of its corner stars warn BLD_CHECK_SPOKE_G2', () => {
    const { doc, id, notes } = rounded({ type: 'curvature', shape: 0.5 });
    expect(notes.corners).toHaveLength(8);
    for (const corner of notes.corners ?? []) {
      expect([corner.continuity, corner.spokes, corner.spokeReach]).toEqual(['G2', 'G2', 0.2]);
      // measured on the built sub-patches: G2 (under the 0.02 build gate) beyond the stretch, an honest relative jump within it, 50 times under the 0.83 of the G1 seams in absolute terms
      expect(corner.spokeRelative).toBeLessThan(0.02);
      expect(corner.spokeVertexRelative).toBeGreaterThan(0.1);
      expect(corner.spokeJump).toBeLessThan(0.03);
    }
    const checked = check(doc, id, 'G2');
    expect(checked.status).toBe('warn');
    expect(checked.findings.filter((found) => found.severity === 'fail')).toEqual([]);
    const corners = checked.blends.filter((row) => row.kind === 'corner');
    expect(corners).toHaveLength(48);
    // every sub-patch has one contact with a blend or flat face (order G2, curvature jump under the blend-scale floor) and two spokes (G1 seams)
    const contacts = corners.flatMap((row) => row.contacts);
    const seams = contacts.filter((contact) => contact.order !== 'G2');
    expect(contacts.filter((contact) => contact.order === 'G2').length).toBeGreaterThanOrEqual(48);
    expect(seams.length).toBeGreaterThan(0);
    for (const seam of seams) expect(seam.order).toBe('G1');
    for (const contact of contacts) expect(contact.g1AngleRad).toBeLessThan(1e-3);
    // the seams are warned under their own code, and nothing is a BLD_CHECK_G2_JUMP
    expect(checked.findings.some((found) => found.code === 'BLD_CHECK_SPOKE_G2')).toBe(true);
    expect(checked.findings.filter((found) => found.code === 'BLD_CHECK_SPOKE_G2').every((found) => found.severity === 'warn')).toBe(true);
    expect(checked.findings.some((found) => found.code === 'BLD_CHECK_G2_JUMP')).toBe(false);
  });

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
