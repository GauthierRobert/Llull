/**
 * check_wrap volume guard on fitted footprints (sphere, torus): the allowance widens with the construction tolerance but has a ceiling, it is reported in `limits`, an injected
 * kernel volume error above it is a finding and one just below it passes; minFeatureSize on these faces reports a skipped count.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { fakeWrapKernel } from '../../helpers/fakeWrapKernel';
import { emptyDoc, make, sphere, useFakeKernel, type Made } from './support';

afterEach(() => setGeometryKernel(null));

interface Report {
  findings: Array<{ code: string; value: number; limit: number }>;
  limits: { volumeAllowance: { value: number } };
  checked: { volumes: number; strokeChecksSkipped?: number };
}
const checkOf = (doc: Made['doc'], extra: Record<string, unknown> = {}): Report =>
  execute(doc, 'check_wrap', { maxLengthStrain: 0.5, ...extra }).data as unknown as Report;
const volumeFinding = (report: Report): Report['findings'][number] | undefined =>
  report.findings.find((f) => f.code === 'WRP_CHECK_VOLUME_MISMATCH');

const onSphere = (fitTolerance?: number): Made => {
  const ball = sphere();
  const circle = make(ball.doc, 'draw_arc', { center: [0, 0], radius: 4 });
  return make(circle.doc, 'emboss_on_face', {
    id: ball.id,
    face: { faceNear: [0, 0, 25] },
    profileIds: [circle.id],
    mode: 'emboss',
    depth: 1,
    placement: { method: 'geodesic', anchor: { chart: [0, 0], on: [0, 0, 25] } },
    ...(fitTolerance === undefined ? {} : { fitTolerance }),
  });
};

const onTorus = (): Made => {
  const ring = make(emptyDoc(), 'add_torus', { ringRadius: 10, tubeRadius: 3 });
  const rectangle = make(ring.doc, 'draw_rectangle', { width: 2, height: 1, position: [-1, -0.5, 0] });
  return make(rectangle.doc, 'emboss_on_face', {
    id: ring.id,
    face: { faceNear: [13, 0, 0] },
    profileIds: [rectangle.id],
    mode: 'emboss',
    depth: 0.5,
    placement: { method: 'parametric', anchor: { chart: [0, 0], on: [13, 0, 0] } },
    maxLengthStrain: 0.5,
  });
};

describe('check_wrap volume allowance on fitted footprints', () => {
  useFakeKernel();

  it.each([
    ['sphere', (): Made => onSphere()],
    ['torus', (): Made => onTorus()],
  ])('%s: a kernel error above the allowance fails with the allowance as limit, one just below passes', (_name, build) => {
    const { doc } = build();
    setGeometryKernel(fakeWrapKernel({ embossSkew: 1.5 }));
    const probe = volumeFinding(checkOf(doc));
    expect(probe).toBeDefined();
    const allowed = probe?.limit as number;
    expect(allowed).toBeGreaterThan(1e-6);
    expect(allowed).toBeLessThanOrEqual(1e-3);
    setGeometryKernel(fakeWrapKernel({ embossSkew: 1 + 1.2 * allowed }));
    expect(volumeFinding(checkOf(doc))?.value).toBeCloseTo(1.2 * allowed, 9);
    setGeometryKernel(fakeWrapKernel({ embossSkew: 1 + 0.9 * allowed }));
    const below = checkOf(doc);
    expect(volumeFinding(below)).toBeUndefined();
    expect(below.limits.volumeAllowance.value).toBeCloseTo(allowed, 12);
  });

  it('caps the allowance at 1e-3 however large the fit tolerance', () => {
    const { doc } = onSphere(2);
    setGeometryKernel(fakeWrapKernel({ embossSkew: 1.002 }));
    const failing = volumeFinding(checkOf(doc));
    expect(failing?.limit).toBe(1e-3);
    setGeometryKernel(fakeWrapKernel({ embossSkew: 1.0005 }));
    const passing = checkOf(doc);
    expect(volumeFinding(passing)).toBeUndefined();
    expect(passing.limits.volumeAllowance.value).toBe(1e-3);
  });

  it('counts the stroke checks skipped on a sphere', () => {
    const { doc } = onSphere();
    const report = checkOf(doc, { minFeatureSize: 0.1 });
    expect(report.checked.strokeChecksSkipped).toBe(1);
    expect(report.findings.map((f) => f.code)).toContain('WRP_CHECK_STROKE_SKIPPED');
    expect(checkOf(doc).checked.strokeChecksSkipped).toBeUndefined();
  });
});
