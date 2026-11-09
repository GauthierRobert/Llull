import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { FaceDetail, FaceQueryPort } from '@core/geometry/kernelPorts';
import { createEmptyDocument, type CadDocument, type Vec3 } from '@core/model/types';
import { vibroacousticsErrors } from '@cae/vibroacoustics/model';
import { xy } from '../../helpers/xy';
import { fakeKernel } from '../../helpers/fakeKernel';
import { expectedNumbers, flatParams, run, withinCase } from './fixtures';

/** Box 300 x 200 x 100 (min corner at the origin): faces 0 x=0, 1 x=300, 2 y=0, 3 y=200, 4 z=0, 5 z=100; areas 20000, 20000, 30000, 30000, 60000, 60000. */
const SIZE: Vec3 = [300, 200, 100];
const FACES: FaceDetail[] = [
  { index: 0, surface: 'plane', area: 200 * 100, centroid: [0, 100, 50], normal: [-1, 0, 0], samples: [] },
  { index: 1, surface: 'plane', area: 200 * 100, centroid: [300, 100, 50], normal: [1, 0, 0], samples: [] },
  { index: 2, surface: 'plane', area: 300 * 100, centroid: [150, 0, 50], normal: [0, -1, 0], samples: [] },
  { index: 3, surface: 'plane', area: 300 * 100, centroid: [150, 200, 50], normal: [0, 1, 0], samples: [] },
  { index: 4, surface: 'plane', area: 300 * 200, centroid: [150, 100, 0], normal: [0, 0, -1], samples: [] },
  { index: 5, surface: 'plane', area: 300 * 200, centroid: [150, 100, 100], normal: [0, 0, 1], samples: [] },
];

/** Distance from `p` to the rectangle of face `index` (its plane clamped to the other two extents). */
function faceDistance(index: number, p: Vec3): number {
  const axis = Math.floor(index / 2);
  const plane = index % 2 === 0 ? 0 : (SIZE[axis] ?? 0);
  const gap = [0, 1, 2].map((k) => (k === axis ? (p[k] ?? 0) - plane : Math.max(0 - (p[k] ?? 0), 0, (p[k] ?? 0) - (SIZE[k] ?? 0))));
  return Math.hypot(...gap);
}

function boxKernel(overrides: Partial<FaceQueryPort> = {}): GeometryKernel {
  const nothing = (): null => null;
  const faceQuery: FaceQueryPort = {
    faceDetails: () => FACES,
    faceContains: nothing,
    faceGraph: nothing,
    faceGeometry: nothing,
    projectOnFace: nothing,
    evaluateFace: nothing,
    tessellateFace: nothing,
    faceSamples: nothing,
    edgeSamples: nothing,
    edgeContinuity: nothing,
    distance: (_shape, points) =>
      points.map((point) => {
        const ranked = [0, 1, 2, 3, 4, 5]
          .map((face) => ({ face, distance: faceDistance(face, point) }))
          .sort((a, b) => a.distance - b.distance);
        const [best, next] = ranked;
        const tie = (next?.distance ?? Infinity) - (best?.distance ?? 0) < 1e-9;
        return { distance: best?.distance ?? 0, signed: 0, face: tie ? -1 : (best?.face ?? -1) };
      }),
    bspline: nothing,
    projectCurves: nothing,
    ...overrides,
  };
  return Object.assign(fakeKernel(), { faceQuery });
}

const withKernel = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });
const refusal = (result: ReturnType<typeof execute>): string | undefined => (result.rejected === true ? result.error?.code : undefined);

function boxDocument(units: 'mm' | 'cm' = 'mm'): { doc: CadDocument; box: string } {
  const unitsSet = run(createEmptyDocument(), 'set_units', { units });
  const scale = units === 'cm' ? 0.1 : 1;
  const added = run(unitsSet.document, 'add_box', { size: SIZE.map((v) => v * scale), position: [0, 0, 0], anchor: 'min' });
  return { doc: added.document, box: added.affected[0] ?? '' };
}

const exposureParams = (box: string, facesNear: Vec3[] = [[150, 100, 100]], extra: object = {}): object => ({
  name: 'enclosure_skin',
  spectrum: 'flat130',
  target: { entityId: box, facesNear },
  field: 'diffuse',
  ...extra,
});

function exposedDocument(grade: 'A' | 'B' = 'A', extra: object = {}, facesNear?: Vec3[]): { doc: CadDocument; box: string } {
  const { doc, box } = boxDocument();
  const withSpectrum = run(doc, 'define_acoustic_spectrum', flatParams('flat130', 130, grade)).document;
  return { doc: run(withSpectrum, 'define_acoustic_exposure', exposureParams(box, facesNear, extra)).document, box };
}

describe('define_acoustic_exposure', () => {
  it('binds a spectrum to face points: affected, entity, order, valid slice, factual summary', () => {
    const { doc, box } = exposedDocument();
    const result = execute(
      run(boxDocument().doc, 'define_acoustic_spectrum', flatParams()).document,
      'define_acoustic_exposure',
      exposureParams(box),
    );
    expect(result.affected).toEqual(['enclosure_skin']);
    const slice = result.document.vibroacoustics;
    expect(slice?.exposureOrder).toEqual(['enclosure_skin']);
    expect(slice?.exposures['enclosure_skin']).toEqual({
      name: 'enclosure_skin',
      spectrum: 'flat130',
      target: { entityId: box, facesNear: [[150, 100, 100]] },
      field: 'diffuse',
    });
    expect(result.summary).toContain('diffuse field on 1 face point(s)');
    expect((result.data as { unverified: boolean }).unverified).toBe(false);
    expect(vibroacousticsErrors({ vibroacoustics: doc.vibroacoustics })).toEqual([]);
  });

  it('is pure', () => {
    const { doc, box } = boxDocument();
    const spectrum = run(doc, 'define_acoustic_spectrum', flatParams()).document;
    const before = structuredClone(spectrum);
    const result = execute(spectrum, 'define_acoustic_exposure', exposureParams(box));
    expect(spectrum).toEqual(before);
    expect(result.document).not.toBe(spectrum);
  });

  it('keeps a progressive incidence angle and notes, and refuses an incidence with a diffuse field', () => {
    const { doc, box } = exposedDocument('A', { field: 'progressive', incidenceDeg: 30, notes: 'lift-off' });
    expect(doc.vibroacoustics?.exposures['enclosure_skin']).toMatchObject({ field: 'progressive', incidenceDeg: 30, notes: 'lift-off' });
    const base = run(boxDocument().doc, 'define_acoustic_spectrum', flatParams()).document;
    const refused = execute(base, 'define_acoustic_exposure', exposureParams(box, [[150, 100, 100]], { incidenceDeg: 30 }));
    expect(refusal(refused)).toBe('VAC_PARAMS_INVALID');
  });

  it('VC-VAC-32: an exposure of a grade B spectrum is flagged VAC_SPECTRUM_UNVERIFIED', () => {
    const { doc, box } = boxDocument();
    const spectrum = run(doc, 'define_acoustic_spectrum', flatParams('flat130', 130, 'B')).document;
    const result = execute(spectrum, 'define_acoustic_exposure', exposureParams(box));
    const data = result.data as { unverified: boolean; items: { code: string }[] };
    expect(data.unverified).toBe(true);
    expect(data.items.map((entry) => entry.code)).toEqual(['VAC_SPECTRUM_UNVERIFIED']);
    expect(result.summary).toContain('VAC_SPECTRUM_UNVERIFIED');
  });

  it('refuses a missing or unknown field type with VAC_FIELD_UNSET (no default)', () => {
    const { doc, box } = boxDocument();
    const spectrum = run(doc, 'define_acoustic_spectrum', flatParams()).document;
    const { field: _unset, ...withoutField } = exposureParams(box) as { field: string };
    for (const params of [withoutField, exposureParams(box, [[150, 100, 100]], { field: 'random' })]) {
      const result = execute(spectrum, 'define_acoustic_exposure', params);
      expect(refusal(result)).toBe('VAC_FIELD_UNSET');
      expect(result.document).toBe(spectrum);
      expect(result.affected).toEqual([]);
    }
  });

  it('refuses an unknown spectrum, a taken name and an invalid name', () => {
    const { doc, box } = exposedDocument();
    expect(refusal(execute(boxDocument().doc, 'define_acoustic_exposure', exposureParams(box)))).toBe('VAC_SPECTRUM_UNKNOWN');
    expect(refusal(execute(doc, 'define_acoustic_exposure', exposureParams(box)))).toBe('VAC_NAME_TAKEN');
    const invalid = execute(doc, 'define_acoustic_exposure', { ...exposureParams(box), name: 'constructor' });
    expect(refusal(invalid)).toBe('VAC_PARAMS_INVALID');
  });

  it('refuses a missing entity and a 2D entity with FEA_TARGET_UNRESOLVED', () => {
    const { doc } = boxDocument();
    const spectrum = run(doc, 'define_acoustic_spectrum', flatParams()).document;
    expect(refusal(execute(spectrum, 'define_acoustic_exposure', exposureParams('nope')))).toBe('FEA_TARGET_UNRESOLVED');
    const line = run(spectrum, 'draw_polyline', { points: xy(0, 0, 1, 0) });
    const flat = execute(line.document, 'define_acoustic_exposure', exposureParams(line.affected[0] ?? ''));
    expect(refusal(flat)).toBe('FEA_TARGET_UNRESOLVED');
  });

  it('rejects an empty facesNear and an incidence beyond 90 degrees in the schema, and warns of a point far off the part', () => {
    const { doc, box } = boxDocument();
    const spectrum = run(doc, 'define_acoustic_spectrum', flatParams()).document;
    expect(execute(spectrum, 'define_acoustic_exposure', exposureParams(box, [])).summary).toContain('invalid params');
    const far = execute(
      spectrum,
      'define_acoustic_exposure',
      exposureParams(box, [[5000, 0, 0]], { field: 'progressive', incidenceDeg: 120 }),
    );
    expect(far.summary).toContain('invalid params');
    const warned = execute(spectrum, 'define_acoustic_exposure', exposureParams(box, [[5000, 0, 0]]));
    expect(warned.summary).toContain('WARNING');
  });

  it('keeps the spectrum in use until the exposure is deleted', () => {
    const { doc } = exposedDocument();
    expect(refusal(execute(doc, 'delete_acoustic_spectrum', { name: 'flat130' }))).toBe('VAC_SPECTRUM_IN_USE');
    const deleted = execute(doc, 'delete_acoustic_exposure', { name: 'enclosure_skin' });
    expect(deleted.affected).toEqual(['enclosure_skin']);
    expect(deleted.document.vibroacoustics?.exposureOrder).toEqual([]);
    expect(deleted.document.vibroacoustics?.spectrumOrder).toEqual(['flat130']);
    expect(execute(deleted.document, 'delete_acoustic_spectrum', { name: 'flat130' }).affected).toEqual(['flat130']);
  });
});

describe('delete_acoustic_exposure', () => {
  it('is pure and refuses an unknown name (including inherited keys) with VAC_EXPOSURE_UNKNOWN', () => {
    const { doc } = exposedDocument();
    const before = structuredClone(doc);
    execute(doc, 'delete_acoustic_exposure', { name: 'enclosure_skin' });
    expect(doc).toEqual(before);
    for (const name of ['nope', 'constructor']) {
      const result = execute(doc, 'delete_acoustic_exposure', { name });
      expect(refusal(result)).toBe('VAC_EXPOSURE_UNKNOWN');
      expect(result.document).toBe(doc);
    }
  });
});

interface Package {
  schema: string;
  field: string;
  spectrum: { oasplDb: number; pRmsPa: number; bands: { nominalHz: number; psdPa2PerHz: number }[] };
  faces: { faceIndex: number; areaMm2: number; centroidMm: number[]; rmsForceN: number | null }[];
  totalAreaMm2: number;
  totalRmsForceN: number | null;
  provenance: { documentHash: string; source: { citation: string } };
  unverified: boolean;
  reviewRequired: boolean;
  items: { code: string }[];
}

const exportOf = (
  doc: CadDocument,
  kernel: GeometryKernel | null = boxKernel(),
  params: object = { exposure: 'enclosure_skin' },
): ReturnType<typeof execute> => execute(doc, 'export_acoustic_load', params, withKernel(kernel));

describe('export_acoustic_load', () => {
  it('exports the exact face area, the spectrum PSD and the force of a diffuse field (VC-VAC-06, 09, 10)', () => {
    const { doc } = exposedDocument();
    const result = exportOf(doc);
    const data = result.data as Package;
    expect(result.rejected).not.toBe(true);
    expect(result.affected).toEqual([]);
    expect(data.schema).toBe('llull.acousticLoad/1');
    expect(data.faces).toHaveLength(1);
    expect(data.faces[0]).toMatchObject({ faceIndex: 5, areaMm2: 60000, centroidMm: [150, 100, 100] });
    expect(withinCase(data.spectrum.oasplDb, expectedNumbers('VC-VAC-06')[0] ?? 0, 'VC-VAC-06')).toBe(true);
    const overall = expectedNumbers('VC-VAC-09')[0] ?? 0;
    expect(withinCase(data.spectrum.pRmsPa, overall, 'VC-VAC-09')).toBe(true);
    const kHz = data.spectrum.bands.find((band) => band.nominalHz === 1000);
    expect(withinCase(kHz?.psdPa2PerHz ?? 0, expectedNumbers('VC-VAC-10')[0] ?? 0, 'VC-VAC-10')).toBe(true);
    expect(data.spectrum.bands).toHaveLength(27);
    expect(data.faces[0]?.rmsForceN).toBeCloseTo(overall * 0.06, 9);
    expect(data.totalRmsForceN).toBe(data.faces[0]?.rmsForceN);
    expect(data.unverified).toBe(false);
    expect(data.reviewRequired).toBe(true);
    expect(data.items.map((entry) => entry.code)).toEqual(['VAC_REVIEW_PENDING']);
    expect(result.summary).toContain('60000');
    expect(result.summary).toContain('reviewRequired');
  });

  it('converts the document unit to mm and mm^2 (cm box 30 x 20 x 10 is the same 60000 mm^2 face)', () => {
    const { doc, box } = boxDocument('cm');
    const spectrum = run(doc, 'define_acoustic_spectrum', flatParams()).document;
    const exposed = run(spectrum, 'define_acoustic_exposure', exposureParams(box, [[15, 10, 10]])).document;
    const inMm = boxKernel().faceQuery as FaceQueryPort;
    const kernel = boxKernel({
      distance: (shape, points) =>
        inMm.distance(
          shape,
          points.map((point) => point.map((v) => v * 10) as unknown as Vec3),
        ),
      faceDetails: () =>
        FACES.map((face) => ({ ...face, area: face.area / 100, centroid: face.centroid.map((v) => v / 10) as unknown as Vec3 })),
    });
    const data = exportOf(exposed, kernel).data as Package;
    expect(data.faces[0]?.areaMm2).toBeCloseTo(60000, 6);
    expect(data.faces[0]?.centroidMm).toEqual([150, 100, 100]);
  });

  it('lists each resolved face once, ascending, and totals the area', () => {
    const { doc } = exposedDocument('A', {}, [
      [150, 100, 100],
      [10, 10, 100],
      [150, 0, 50],
    ]);
    const data = exportOf(doc).data as Package;
    expect(data.faces.map((face) => face.faceIndex)).toEqual([2, 5]);
    expect(data.totalAreaMm2).toBe(90000);
  });

  it('VC-VAC-32: a grade B spectrum exports unverified with VAC_SPECTRUM_UNVERIFIED and reviewRequired', () => {
    const data = exportOf(exposedDocument('B').doc).data as Package;
    expect(data.unverified).toBe(true);
    expect(data.reviewRequired).toBe(true);
    expect(data.items.map((entry) => entry.code)).toEqual(['VAC_SPECTRUM_UNVERIFIED', 'VAC_REVIEW_PENDING']);
  });

  it('gives no force for a progressive field (the incidence is not applied)', () => {
    const { doc } = exposedDocument('A', { field: 'progressive', incidenceDeg: 45 });
    const data = exportOf(doc).data as Package & { incidenceDeg: number };
    expect(data.field).toBe('progressive');
    expect(data.incidenceDeg).toBe(45);
    expect(data.faces[0]?.rmsForceN).toBeNull();
    expect(data.totalRmsForceN).toBeNull();
  });

  it('is deterministic, pure and bound to the document hash', () => {
    const { doc } = exposedDocument();
    const before = structuredClone(doc);
    const first = exportOf(doc);
    expect(doc).toEqual(before);
    expect(exportOf(doc).data).toEqual(first.data);
    const other = run(doc, 'set_units', { units: 'cm' }).document;
    expect((exportOf(other).data as Package | undefined)?.provenance.documentHash).not.toBe(
      (first.data as Package).provenance.documentHash,
    );
  });

  it('VC-VAC-33: a response request is refused with VAC_OUT_OF_SCOPE and exports nothing', () => {
    const result = exportOf(exposedDocument().doc, boxKernel(), { exposure: 'enclosure_skin', kind: 'sea' });
    expect(refusal(result)).toBe('VAC_OUT_OF_SCOPE');
    expect(result.data).toBeUndefined();
  });

  it('refuses an unknown exposure and an exposure whose spectrum was lost', () => {
    const { doc } = exposedDocument();
    expect(refusal(exportOf(doc, boxKernel(), { exposure: 'nope' }))).toBe('VAC_EXPOSURE_UNKNOWN');
    const lost: CadDocument = {
      ...doc,
      vibroacoustics: { ...(doc.vibroacoustics as NonNullable<CadDocument['vibroacoustics']>), spectra: {}, spectrumOrder: [] },
    };
    expect(refusal(exportOf(lost))).toBe('VAC_SPECTRUM_UNKNOWN');
  });

  it('never guesses an area: no kernel is refused by execute, a mesh kernel (no face queries) by KRN_NO_EXACT_KERNEL', () => {
    const { doc } = exposedDocument();
    const none = exportOf(doc, null);
    expect(none.data).toBeUndefined();
    expect(none.affected).toEqual([]);
    const mesh = exportOf(doc, fakeKernel());
    expect(refusal(mesh)).toBe('KRN_NO_EXACT_KERNEL');
    expect(mesh.data).toBeUndefined();
  });

  it('refuses a vanished or non-solid target, a point off the solid and a point on an edge with VAC_EXPOSURE_UNRESOLVED', () => {
    const { doc, box } = exposedDocument();
    const gone = { ...doc, entities: Object.fromEntries(Object.entries(doc.entities).filter(([id]) => id !== box)) };
    expect(refusal(exportOf(gone))).toBe('VAC_EXPOSURE_UNRESOLVED');
    const off = exposedDocument('A', {}, [[150, 100, 500]]).doc;
    const offResult = exportOf(off);
    expect(refusal(offResult)).toBe('VAC_EXPOSURE_UNRESOLVED');
    expect(offResult.summary).toContain('not on the solid');
    const edge = exposedDocument('A', {}, [[150, 200, 100]]).doc;
    expect(exportOf(edge).summary).toContain('edge or seam');
  });

  it('refuses when the kernel cannot build the solid or answer the face distances', () => {
    const { doc } = exposedDocument();
    expect(exportOf(doc, boxKernel({ distance: () => null })).summary).toContain('face distances');
    const unbuildable = Object.assign(boxKernel(), { evaluate: () => null });
    expect(exportOf(doc, unbuildable).summary).toContain('could not build');
  });

  it('refuses malformed inspect_faces records (non-finite area, bad centroid, wrong surface) with KRN_FACE_QUERY_FAILED', () => {
    const { doc } = exposedDocument();
    const bad: Partial<FaceDetail>[] = [
      { area: Number.NaN },
      { centroid: [1, 2] as unknown as Vec3 },
      { surface: 3 as unknown as 'plane' },
    ];
    for (const change of bad) {
      const result = exportOf(doc, boxKernel({ faceDetails: () => FACES.map((face) => ({ ...face, ...change })) }));
      expect(refusal(result)).toBe('KRN_FACE_QUERY_FAILED');
      expect(result.data).toBeUndefined();
    }
  });

  it('rounds areas and centroids to 1e-6 so a saved package is stable across kernel builds', () => {
    const { doc } = exposedDocument();
    const noisy = boxKernel({
      faceDetails: () => FACES.map((face) => ({ ...face, area: face.area + 1e-9, centroid: [150 + 1e-10, 100, 100] })),
    });
    const data = exportOf(doc, noisy).data as Package;
    expect(data.faces[0]?.areaMm2).toBe(60000);
    expect(data.faces[0]?.centroidMm).toEqual([150, 100, 100]);
    expect(data.totalAreaMm2).toBe(60000);
  });

  it('forwards a refusal of inspect_faces (the kernel cannot compute the faces)', () => {
    const { doc } = exposedDocument();
    const result = exportOf(doc, boxKernel({ faceDetails: () => null }));
    expect(result.rejected).toBe(true);
    expect(result.summary).toContain('export_acoustic_load: inspect_faces');
  });
});

describe('check_acoustic_handoff', () => {
  const check = (doc: CadDocument, kernel: GeometryKernel | null = boxKernel()): ReturnType<typeof execute> =>
    execute(doc, 'check_acoustic_handoff', {}, withKernel(kernel));
  const dataOf = (
    result: ReturnType<typeof execute>,
  ): { status: string; items: { code: string; severity: string }[]; reviewRequired: boolean } =>
    result.data as { status: string; items: { code: string; severity: string }[]; reviewRequired: boolean };

  it('passes only when every exposure resolves on the exact kernel with a grade A spectrum', () => {
    const data = dataOf(check(exposedDocument().doc));
    expect(data).toMatchObject({ status: 'pass', items: [], reviewRequired: true });
  });

  it('is unknown, never pass, with no exposure or without the exact kernel', () => {
    expect(dataOf(check(createEmptyDocument())).status).toBe('unknown');
    expect(dataOf(check(createEmptyDocument())).items.map((entry) => entry.code)).toEqual(['VAC_NO_EXPOSURE']);
    const unchecked = dataOf(check(exposedDocument().doc, null));
    expect(unchecked.status).toBe('unknown');
    expect(unchecked.items.map((entry) => entry.code)).toEqual(['VAC_EXPOSURE_UNCHECKED']);
    expect(dataOf(check(exposedDocument().doc, fakeKernel())).status).toBe('unknown');
  });

  it('warns about an unverified spectrum and fails on an unresolved face or a lost spectrum', () => {
    expect(dataOf(check(exposedDocument('B').doc))).toMatchObject({
      status: 'warn',
      items: [{ code: 'VAC_SPECTRUM_UNVERIFIED', severity: 'warning' }],
    });
    const off = check(exposedDocument('A', {}, [[150, 100, 500]]).doc);
    expect(dataOf(off).status).toBe('fail');
    expect(dataOf(off).items.map((entry) => entry.code)).toEqual(['VAC_EXPOSURE_UNRESOLVED']);
    const { doc, box } = exposedDocument();
    const gone = { ...doc, entities: Object.fromEntries(Object.entries(doc.entities).filter(([id]) => id !== box)) };
    expect(dataOf(check(gone, null)).status).toBe('fail');
    const lost: CadDocument = {
      ...doc,
      vibroacoustics: { ...(doc.vibroacoustics as NonNullable<CadDocument['vibroacoustics']>), spectra: {}, spectrumOrder: [] },
    };
    expect(dataOf(check(lost)).items.map((entry) => entry.code)).toContain('VAC_SPECTRUM_UNKNOWN');
  });

  it('is pure', () => {
    const { doc } = exposedDocument();
    const before = structuredClone(doc);
    check(doc);
    expect(doc).toEqual(before);
  });
});
