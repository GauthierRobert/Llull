/**
 * BLD §13.36 on the native OCCT kernel: the corner star of a curvature-profile step is curvature-continuous (G2) to the blend and flat faces it meets,
 * so a G2 chain stays G2 through its corners; check_blends reads it with `require: "G2"`. The edges between two sub-patches (spokes) are G1 seams.
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
  readonly corners?: Array<{ readonly patch: string; readonly continuity?: string; readonly g2Refused?: string }>;
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

  it('a curvature-profile cube passes check_blends require G2 through its corners; the spokes are reported, never failed', () => {
    const { doc, id, notes } = rounded({ type: 'curvature', shape: 0.5 });
    expect(notes.corners).toHaveLength(8);
    for (const corner of notes.corners ?? []) expect(corner.continuity).toBe('G2');
    const checked = check(doc, id, 'G2');
    expect(checked.status).toBe('pass');
    expect(checked.findings.filter((found) => found.severity === 'fail')).toEqual([]);
    const corners = checked.blends.filter((row) => row.kind === 'corner');
    expect(corners).toHaveLength(48);
    // every sub-patch has one contact with a blend or flat face (order G2, curvature jump under the blend-scale floor) and two spokes (G1 seams)
    const contacts = corners.flatMap((row) => row.contacts);
    const seams = contacts.filter((contact) => contact.order !== 'G2');
    expect(contacts.filter((contact) => contact.order === 'G2').length).toBeGreaterThanOrEqual(48);
    for (const seam of seams) expect(seam.order).toBe('G1');
    for (const contact of contacts) expect(contact.g1AngleRad).toBeLessThan(1e-3);
    expect(checked.findings.some((found) => found.code === 'BLD_CHECK_G2_JUMP' && found.severity !== 'info')).toBe(false);
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
