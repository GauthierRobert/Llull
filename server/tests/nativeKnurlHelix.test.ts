/**
 * 03 WRP M5 on the native OCCT kernel: the modeled diagonal and diamond knurl (FR-WRP-32). Helical V-grooves are exact screw sweeps; a diagonal removes N x length x A_t (closed form, the
 * transverse section is kept by the screw motion), a diamond the union of the two hands (numeric integral). Skipped when the llull-kernel binary (with the `emboss` capability) is not built.
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { helicalGrooveArea, helicalRemovedVolume, type HelicalKnurl } from '@core/commands/wrap/knurlHelix';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

vi.setConfig({ testTimeout: 280_000 });

type Run = ReturnType<typeof execute>;
const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);

describeNativeWhen({ capabilities: ['emboss'], label: 'WRP helical knurl' })(
  'WRP modeled diagonal and diamond knurl on the native OCCT kernel',
  () => {
    let kernel: IsolatedKernel;
    beforeAll(() => {
      kernel = createNativeTestKernel();
      setGeometryKernel(kernel);
    }, 120_000);
    afterAll(() => {
      setGeometryKernel(null);
      kernel.dispose();
    });

    const base = (): CadDocument => ({ ...createEmptyDocument(), units: 'mm' });
    const must = (doc: CadDocument, name: string, params: Record<string, unknown>): Run => {
      const result = execute(doc, name, params);
      expect(result.rejected, result.summary).toBeUndefined();
      return result;
    };
    const volume = (doc: CadDocument, id: string): number =>
      (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
    const rod = (): { doc: CadDocument; id: string } => {
      const body = must(base(), 'add_cylinder', { radius: 20, height: 40 });
      return { doc: body.document, id: body.affected[0] as string };
    };
    const face = { faceNear: [20, 0, 0] };
    const PITCH = (Math.PI * 40) / 8;
    const solidOf = (done: Run): string => done.affected[0] as string;

    it('a diagonal knurl (8 teeth, helix 30 degrees, 90 degree V): the volume removed is 8 x 40 x A_t, lead 2 pi r / tan(helix), a land of 10 % of the pitch', () => {
      const { doc, id } = rod();
      const started = Date.now();
      const done = must(doc, 'add_knurl', { id, face, pattern: 'diagonal', pitch: PITCH, model: 'geometry' });
      const seconds = (Date.now() - started) / 1000;
      const info = done.data as Record<string, number | number[] | string | string[]>;
      expect(info).toMatchObject({ teeth: 8, grooves: 8, hands: ['right'], helixAngleDeg: 30 });
      const shape: HelicalKnurl = {
        teeth: 24,
        radius: 20,
        depth: info['depth'] as number,
        toothAngleDeg: 90,
        helixDeg: 30,
        hands: 1,
        left: false,
      };
      const removed = volume(doc, id) - volume(done.document, solidOf(done));
      expect(relative(removed, 8 * 40 * helicalGrooveArea(shape))).toBeLessThan(1e-5);
      expect(info['expectedVolumeDelta']).toBeCloseTo(-8 * 40 * helicalGrooveArea(shape), 9);
      expect(info['lead']).toBeCloseTo((2 * Math.PI * 20) / Math.tan(Math.PI / 6), 9);
      expect(info['land']).toBeCloseTo(0.1 * PITCH, 9);
      expect(seconds).toBeLessThan(60);
    });

    it('the left hand removes the same volume as the right (helix 45 degrees)', () => {
      const { doc, id } = rod();
      const right = must(doc, 'add_knurl', { id, face, pattern: 'diagonal', pitch: PITCH, model: 'geometry', helixAngleDeg: 45 });
      const left = must(doc, 'add_knurl', {
        id,
        face,
        pattern: 'diagonal',
        pitch: PITCH,
        model: 'geometry',
        helixAngleDeg: 45,
        hand: 'left',
      });
      expect(relative(volume(left.document, solidOf(left)), volume(right.document, solidOf(right)))).toBeLessThan(1e-6);
      const shape: HelicalKnurl = {
        teeth: 8,
        radius: 20,
        depth: (right.data as { depth: number }).depth,
        toothAngleDeg: 90,
        helixDeg: 45,
        hands: 1,
        left: false,
      };
      expect(relative(volume(doc, id) - volume(right.document, solidOf(right)), 8 * 40 * helicalGrooveArea(shape))).toBeLessThan(1e-5);
    });

    it('a diamond knurl (4 teeth x 2 hands = 8 grooves, helix 45 degrees): the union of the two hands, measured within 1e-3 of the numeric integral', () => {
      const { doc, id } = rod();
      const started = Date.now();
      const done = must(doc, 'add_knurl', {
        id,
        face,
        pattern: 'diamond',
        pitch: (Math.PI * 40) / 4,
        model: 'geometry',
        helixAngleDeg: 45,
        depth: 2,
      });
      const seconds = (Date.now() - started) / 1000;
      const info = done.data as { depth: number; grooves: number; hands: string[]; expectedVolumeDelta: number };
      expect(info).toMatchObject({ grooves: 8, hands: ['right', 'left'] });
      const shape: HelicalKnurl = { teeth: 4, radius: 20, depth: info.depth, toothAngleDeg: 90, helixDeg: 45, hands: 2, left: false };
      const removed = volume(doc, id) - volume(done.document, solidOf(done));
      const single = 4 * 40 * helicalGrooveArea({ ...shape, hands: 1 });
      expect(removed).toBeGreaterThan(single);
      expect(removed).toBeLessThan(2 * single);
      expect(relative(removed, helicalRemovedVolume(shape, 40))).toBeLessThan(1e-3);
      expect(relative(removed, -info.expectedVolumeDelta)).toBeLessThan(1e-3);
      expect(seconds).toBeLessThan(120);
    });

    it('refuses by code: more than 12 grooves, a shoulder at an end of the face, and grooves that meet', () => {
      const { doc, id } = rod();
      expect(execute(doc, 'add_knurl', { id, face, pattern: 'diamond', pitch: 2, model: 'geometry' }).error?.code).toBe(
        'WRP_KNURL_TOO_MANY_GROOVES',
      );
      expect(execute(doc, 'add_knurl', { id, face, pattern: 'diagonal', pitch: PITCH, model: 'geometry', depth: 9 }).error?.code).toBe(
        'WRP_KNURL_DEPTH_INVALID',
      );
      const step = must(doc, 'add_cylinder', { radius: 10, height: 40, position: [0, 0, 40] });
      const shaft = must(step.document, 'boolean', { op: 'union', a: id, b: step.affected[0] });
      const refused = execute(shaft.document, 'add_knurl', {
        id: shaft.affected[0],
        face,
        pattern: 'diagonal',
        pitch: PITCH,
        model: 'geometry',
      });
      expect(refused.error?.code).toBe('WRP_KNURL_GEOMETRY_UNSUPPORTED');
      expect(refused.document).toBe(shaft.document);
    });

    it('replay_history rebuilds the grooved solid', () => {
      const { doc, id } = rod();
      const done = must(doc, 'add_knurl', { id, face, pattern: 'diagonal', pitch: PITCH, model: 'geometry' });
      const replayed = must(done.document, 'replay_history', {});
      expect(JSON.stringify(replayed.document.entities)).toBe(JSON.stringify(done.document.entities));
    });
  },
);
