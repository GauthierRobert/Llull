/** 03 GDT M2 / M7: every pmi command, happy and failure paths, purity, review gate (VC-GDT-03, 04, 05, 07, 08, 57). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import type { PmiItem } from '@core/model/pmi';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { plateKernel } from '../../helpers/pmiPlateKernel';

const FRONT = [60, 0, 6] as const;
const BOTTOM = [30, 10, 0] as const;
const LEFT = [0, 40, 6] as const;
const HOLE = [16.7, 20, 6] as const;
const BORE = [50, 40, 6] as const;

interface Run {
  document: CadDocument;
  id: string;
}

/** A solid with the plate topology (the analytic plate kernel answers for every shape). */
function plate(): Run {
  const box = execute(createEmptyDocument(), 'add_box', { size: [120, 80, 12] });
  return { document: box.document, id: box.affected[0] as string };
}

const exec = (doc: CadDocument, name: string, params: Record<string, unknown>): ReturnType<typeof execute> => execute(doc, name, params);
const items = (doc: CadDocument): PmiItem[] => Object.values(doc.pmi?.items ?? {});
const codeOf = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;

/** Adds `name` and returns the new document + the first affected id. */
function add(run: Run, name: string, params: Record<string, unknown>): Run & { result: ReturnType<typeof execute> } {
  const targeted = name === 'add_geometric_tolerance' && (params['targetPmiId'] !== undefined || params['compositeOf'] !== undefined);
  const result = exec(run.document, name, targeted ? params : { entityId: run.id, ...params });
  expect(result.rejected, result.summary).toBeUndefined();
  return { document: result.document, id: run.id, result };
}
const idOf = (r: { result: ReturnType<typeof execute> }): string => r.result.affected[0] as string;

beforeEach(() => setGeometryKernel(plateKernel()));
afterEach(() => setGeometryKernel(null));

describe('every pmi command is pure and refuses with a code', () => {
  it('leaves the input untouched', () => {
    const { document, id } = plate();
    const before = JSON.stringify(document);
    exec(document, 'add_datum_feature', { entityId: id, facesNear: [BOTTOM] });
    exec(document, 'set_pmi_standard', { standard: 'ISO_GPS' });
    exec(document, 'add_pmi_note', { text: 'x' });
    expect(JSON.stringify(document)).toBe(before);
  });

  it('refuses a non-solid, a missing id, a mesh kernel and no kernel', () => {
    const { document, id } = plate();
    const line = exec(document, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 0],
      ],
    });
    const flat = line.affected[0] as string;
    expect(codeOf(exec(line.document, 'add_datum_feature', { entityId: flat, facesNear: [BOTTOM] }))).toBe('GDT_ENTITY_NOT_SOLID');
    expect(codeOf(exec(document, 'add_datum_feature', { entityId: 'nope', facesNear: [BOTTOM] }))).toBe('GDT_ENTITY_NOT_SOLID');
    setGeometryKernel(plateKernel({ thickness: 12, noFaceQuery: true }));
    const noPort = exec(document, 'add_datum_feature', { entityId: id, facesNear: [BOTTOM] });
    expect(codeOf(noPort)).toBe('GDT_KERNEL_NO_TOPOLOGY');
    expect(noPort.error?.remediation).toContain('OCC');
    expect(noPort.document).toBe(document);
    expect((noPort.data as { error: { code: string } }).error.code).toBe('GDT_KERNEL_NO_TOPOLOGY');
    setGeometryKernel(null);
    const none = execute(document, 'add_datum_feature', { entityId: id, facesNear: [BOTTOM] }, { ...defaultContext(), kernel: null });
    expect(none.rejected).toBe(true);
    expect(none.document).toBe(document);
  });
});

describe('set_pmi_standard', () => {
  it('stores the standard and note, is idempotent, and keeps items', () => {
    const { document, id } = plate();
    const datum = add({ document, id }, 'add_datum_feature', { facesNear: [BOTTOM] });
    const set = exec(datum.document, 'set_pmi_standard', { standard: 'ISO_GPS', generalToleranceNote: 'ISO 2768-m' });
    expect(set.affected).toEqual(['pmi']);
    expect(set.document.pmi?.standard).toBe('ISO_GPS');
    expect(set.document.pmi?.generalToleranceNote).toBe('ISO 2768-m');
    expect(items(set.document)).toHaveLength(1);
    expect(exec(set.document, 'set_pmi_standard', { standard: 'ISO_GPS', generalToleranceNote: 'ISO 2768-m' }).affected).toEqual([]);
    const keep = exec(set.document, 'set_pmi_standard', { standard: 'ASME_Y14.5_2018' });
    expect(keep.document.pmi?.generalToleranceNote).toBe('ISO 2768-m');
    expect(exec(createEmptyDocument(), 'set_pmi_standard', { standard: 'ASME_Y14.5_2018' }).document.pmi).toBeDefined();
  });
});

describe('add_datum_feature / add_datum_target', () => {
  it('takes the next free letter, then honours an explicit label, per solid', () => {
    let run = plate();
    run = add(run, 'add_datum_feature', { facesNear: [BOTTOM] });
    run = add(run, 'add_datum_feature', { facesNear: [FRONT] });
    run = add(run, 'add_datum_feature', { facesNear: [LEFT], label: 'Z' });
    expect(items(run.document).map((i) => (i.kind === 'datum_feature' ? i.label : ''))).toEqual(['A', 'B', 'Z']);
    const cyl = add(run, 'add_datum_feature', { facesNear: [BORE], label: 'AB' });
    expect(cyl.result.summary).toContain('cylinder');
  });

  it('refuses invalid / duplicate labels, points off the faces, ambiguous edges and unsupported surfaces', () => {
    const run = add(plate(), 'add_datum_feature', { facesNear: [BOTTOM], label: 'A' });
    expect(codeOf(exec(run.document, 'add_datum_feature', { entityId: run.id, facesNear: [FRONT], label: 'a1' }))).toBe(
      'GDT_DATUM_LABEL_INVALID',
    );
    expect(codeOf(exec(run.document, 'add_datum_feature', { entityId: run.id, facesNear: [FRONT], label: 'A' }))).toBe(
      'GDT_DATUM_DUPLICATE',
    );
    expect(codeOf(exec(run.document, 'add_datum_feature', { entityId: run.id, facesNear: [[60, 40, 50]] }))).toBe('GDT_POINT_NOT_ON_FACE');
    const edge = exec(run.document, 'add_datum_feature', { entityId: run.id, facesNear: [[0, 0, 0]] });
    expect(codeOf(edge)).toBe('GDT_FACE_AMBIGUOUS');
    expect(edge.error?.paths).toEqual(['facesNear.0']);
    setGeometryKernel(plateKernel({ thickness: 12, bottomAsBspline: true }));
    expect(codeOf(exec(run.document, 'add_datum_feature', { entityId: run.id, facesNear: [BOTTOM], label: 'Q' }))).toBe(
      'GDT_POINT_NOT_ON_FACE',
    );
  });

  it('adds datum targets with numbering, and refuses unknown datums, area without size and duplicates', () => {
    let run = add(plate(), 'add_datum_feature', { facesNear: [BOTTOM], label: 'A' });
    const t1 = add(run, 'add_datum_target', { label: 'A', targetKind: 'point', facesNear: [BOTTOM] });
    run = t1;
    run = add(run, 'add_datum_target', { label: 'A', targetKind: 'area', areaSize: 6, facesNear: [[90, 70, 0]] });
    const targets = items(run.document).flatMap((i) => (i.kind === 'datum_target' ? [`${i.label}${i.targetNumber}:${i.targetKind}`] : []));
    expect(targets).toEqual(['A1:point', 'A2:area']);
    expect(codeOf(exec(run.document, 'add_datum_target', { entityId: run.id, label: 'Q', targetKind: 'point', facesNear: [BOTTOM] }))).toBe(
      'GDT_DATUM_UNDEFINED',
    );
    expect(codeOf(exec(run.document, 'add_datum_target', { entityId: run.id, label: 'A', targetKind: 'area', facesNear: [BOTTOM] }))).toBe(
      'GDT_ZONE_NON_POSITIVE',
    );
    expect(
      codeOf(
        exec(run.document, 'add_datum_target', { entityId: run.id, label: 'A', targetKind: 'line', targetNumber: 1, facesNear: [BOTTOM] }),
      ),
    ).toBe('GDT_DATUM_DUPLICATE');
    expect(codeOf(exec(run.document, 'add_datum_target', { entityId: 'nope', label: 'A', targetKind: 'line', facesNear: [BOTTOM] }))).toBe(
      'GDT_ENTITY_NOT_SOLID',
    );
    expect(
      codeOf(exec(run.document, 'add_datum_target', { entityId: run.id, label: 'A', targetKind: 'line', facesNear: [[60, 40, 50]] })),
    ).toBe('GDT_POINT_NOT_ON_FACE');
  });
});

describe('size and location dimensions', () => {
  const holes = [
    [16.7, 20, 6],
    [96.7, 20, 6],
    [16.7, 60, 6],
    [96.7, 60, 6],
  ];

  it('measures pattern count, diameter, radius, width and keeps ISO 14405 modifiers', () => {
    const run = plate();
    const size = add(run, 'add_size_dimension', {
      facesNear: holes,
      sizeKind: 'diameter',
      tolerance: { type: 'limits', lower: 6.6, upper: 6.9 },
      sizeModifiers: ['E', 'LP'],
    });
    const item = items(size.document)[0];
    expect(item).toMatchObject({ kind: 'size_dimension', count: 4, sizeModifiers: ['E', 'LP'] });
    expect(item?.kind === 'size_dimension' && item.feature.ofSize).toMatchObject({ kind: 'cylinder', measured: 6.6, internal: true });
    expect(size.result.summary).toContain('4X Ø6.6–6.9 Ⓔ (LP)');
    const radius = add(run, 'add_size_dimension', {
      facesNear: [BORE],
      sizeKind: 'radius',
      tolerance: { type: 'plusMinus', upper: 0.1, lower: -0.1 },
    });
    expect(radius.result.summary).toContain('R10 ±0.1');
    const width = add(run, 'add_size_dimension', { facesNear: [FRONT, [60, 80, 6]], sizeKind: 'width', tolerance: { type: 'basic' } });
    const w = items(width.document)[0];
    expect(w?.kind === 'size_dimension' && w.feature.ofSize).toEqual({ kind: 'width', measured: 80, internal: false });
    const fit = add(run, 'add_size_dimension', {
      facesNear: [BORE],
      sizeKind: 'diameter',
      tolerance: { type: 'fit', code: 'H7', upper: 0.021, lower: 0 },
    });
    expect(fit.result.summary).toContain('Ø20 H7 (+0.021/0)');
  });

  it('refuses a plane, mixed sizes, a wrong kind, inverted limits; warns when the nominal is outside the limits', () => {
    const run = plate();
    const tol = { type: 'plusMinus', upper: 0.1, lower: -0.1 };
    expect(
      codeOf(exec(run.document, 'add_size_dimension', { entityId: run.id, facesNear: [BOTTOM], sizeKind: 'diameter', tolerance: tol })),
    ).toBe('GDT_NOT_FOS');
    expect(
      codeOf(exec(run.document, 'add_size_dimension', { entityId: run.id, facesNear: [BOTTOM, FRONT], sizeKind: 'width', tolerance: tol })),
    ).toBe('GDT_NOT_FOS');
    expect(
      codeOf(exec(run.document, 'add_size_dimension', { entityId: run.id, facesNear: [FRONT, LEFT], sizeKind: 'width', tolerance: tol })),
    ).toBe('GDT_NOT_FOS');
    expect(
      codeOf(exec(run.document, 'add_size_dimension', { entityId: run.id, facesNear: [HOLE, BORE], sizeKind: 'diameter', tolerance: tol })),
    ).toBe('GDT_SIZE_MIXED');
    expect(
      codeOf(
        exec(run.document, 'add_size_dimension', { entityId: run.id, facesNear: [HOLE], sizeKind: 'spherical_diameter', tolerance: tol }),
      ),
    ).toBe('GDT_SIZE_KIND_MISMATCH');
    expect(
      codeOf(
        exec(run.document, 'add_size_dimension', {
          entityId: run.id,
          facesNear: [HOLE],
          sizeKind: 'diameter',
          tolerance: { type: 'limits', upper: 6, lower: 7 },
        }),
      ),
    ).toBe('GDT_LIMITS_INVERTED');
    expect(
      codeOf(
        exec(run.document, 'add_size_dimension', {
          entityId: run.id,
          facesNear: [HOLE],
          sizeKind: 'diameter',
          tolerance: { type: 'basic' },
          placement: undefined,
        }),
      ),
    ).toBeUndefined();
    const outside = add(run, 'add_size_dimension', {
      facesNear: [HOLE],
      sizeKind: 'diameter',
      tolerance: { type: 'limits', lower: 7, upper: 7.2 },
    });
    expect(outside.result.summary).toContain('GDT_NOMINAL_OUTSIDE_LIMITS');
    const check = exec(outside.document, 'check_pmi', {}).data as { warnings: Array<{ code: string }> };
    expect(check.warnings.map((w) => w.code)).toContain('GDT_NOMINAL_OUTSIDE_LIMITS');
  });

  it('refuses location dimensions spanning several holes and invalid pairs, and takes tolerances', () => {
    const run = plate();
    const ambiguous = exec(run.document, 'add_location_dimension', { entityId: run.id, from: [FRONT], to: holes, measure: 'distance' });
    expect(codeOf(ambiguous)).toBe('GDT_LOCATION_AMBIGUOUS');
    expect(
      codeOf(
        exec(run.document, 'add_location_dimension', {
          entityId: run.id,
          from: [BOTTOM],
          to: [
            [0, 40, 6],
            [60, 80, 6],
          ],
          measure: 'distance',
        }),
      ),
    ).toBe('GDT_LOCATION_AMBIGUOUS');
    expect(
      codeOf(
        exec(run.document, 'add_location_dimension', {
          entityId: run.id,
          from: [[16.7, 20, 6]],
          to: [[96.7, 20, 6]],
          measure: 'distance',
          tolerance: { type: 'plusMinus', upper: -1, lower: 1 },
        }),
      ),
    ).toBe('GDT_LIMITS_INVERTED');
    const axes = add(run, 'add_location_dimension', {
      from: [[16.7, 20, 6]],
      to: [[96.7, 20, 6]],
      measure: 'distance',
      tolerance: { type: 'plusMinus', upper: 0.1, lower: -0.1 },
    });
    const hole = items(axes.document)[0];
    expect(hole?.kind === 'location_dimension' && hole.measured).toBeCloseTo(80, 9);
    const axisPlane = add(run, 'add_location_dimension', { from: [[16.7, 20, 6]], to: [FRONT], measure: 'distance' });
    expect((items(axisPlane.document)[0] as { measured: number }).measured).toBeCloseTo(20, 9);
    const twisted = exec(run.document, 'add_location_dimension', {
      entityId: run.id,
      from: [[16.7, 20, 6]],
      to: [BOTTOM],
      measure: 'distance',
    });
    expect(codeOf(twisted)).toBe('GDT_LOCATION_INVALID');
    const planeAngle = add(run, 'add_location_dimension', { from: [[16.7, 20, 6]], to: [FRONT], measure: 'angle' });
    expect(items(planeAngle.document)[0]).toMatchObject({ measure: 'angle' });
    const axisAngle = add(run, 'add_location_dimension', { from: [[16.7, 20, 6]], to: [[96.7, 20, 6]], measure: 'angle' });
    expect((items(axisAngle.document)[0] as { measured: number }).measured).toBeCloseTo(0, 9);
    const noFace = exec(run.document, 'add_location_dimension', {
      entityId: run.id,
      from: [FRONT],
      to: [[60, 40, 50]],
      measure: 'distance',
    });
    expect(codeOf(noFace)).toBe('GDT_POINT_NOT_ON_FACE');
    expect(noFace.error?.paths).toEqual(['to.0']);
    expect(codeOf(exec(run.document, 'add_location_dimension', { entityId: 'nope', from: [FRONT], to: [LEFT], measure: 'angle' }))).toBe(
      'GDT_ENTITY_NOT_SOLID',
    );
  });
});

describe('add_geometric_tolerance', () => {
  function withDatums(): Run & { size: string } {
    let run = plate();
    run = add(run, 'add_datum_feature', { facesNear: [BOTTOM], label: 'A' });
    run = add(run, 'add_datum_feature', { facesNear: [FRONT], label: 'B' });
    const size = add(run, 'add_size_dimension', {
      facesNear: [HOLE],
      sizeKind: 'diameter',
      tolerance: { type: 'limits', lower: 6.6, upper: 6.9 },
    });
    return { document: size.document, id: run.id, size: idOf(size) };
  }

  it('builds FCFs on a size dimension and on faces with datums, modifiers and boundary modifiers', () => {
    const base = withDatums();
    const position = add(base, 'add_geometric_tolerance', {
      characteristic: 'position',
      targetPmiId: base.size,
      zone: { value: 0.3, diametral: true, projectedLength: 5 },
      materialCondition: 'MMC',
      modifiers: ['free_state'],
      datums: [{ label: 'A' }, { label: 'B', boundary: 'MMB' }],
    });
    expect(position.result.summary).toContain('⌖ | Ø0.3 Ⓜ Ⓟ5 Ⓕ | A | B Ⓜ');
    const profile = add(position, 'add_geometric_tolerance', {
      characteristic: 'profile_surface',
      facesNear: [LEFT],
      zone: { value: 0.2, unequallyDisposed: 0.1 },
      modifiers: ['all_around'],
      datums: [{ label: 'A' }],
    });
    expect(profile.result.summary).toContain('UZ 0.1');
    expect(profile.result.summary).toContain('ALL AROUND');
    const flat = add(profile, 'add_geometric_tolerance', {
      characteristic: 'flatness',
      facesNear: [BOTTOM],
      zone: { value: 0.05 },
      placement: { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0], position: [5, 5] },
    });
    const placed = items(flat.document).at(-1);
    expect(placed?.placement).toMatchObject({ auto: false, position: [5, 5] });
  });

  it('composite FCF: the lower segment inherits the target and may not exceed the upper zone', () => {
    const base = withDatums();
    const upper = add(base, 'add_geometric_tolerance', {
      characteristic: 'position',
      targetPmiId: base.size,
      zone: { value: 0.5, diametral: true },
      datums: [{ label: 'A' }, { label: 'B' }],
    });
    const upperId = idOf(upper);
    const lower = add(upper, 'add_geometric_tolerance', {
      characteristic: 'position',
      compositeOf: upperId,
      zone: { value: 0.2, diametral: true },
      datums: [{ label: 'A' }],
    });
    expect(items(lower.document).at(-1)).toMatchObject({ compositeOf: upperId });
    expect(lower.result.summary).toContain(`composite lower segment of ${upperId}`);
    const wider = exec(upper.document, 'add_geometric_tolerance', {
      characteristic: 'position',
      compositeOf: upperId,
      zone: { value: 0.9, diametral: true },
    });
    expect(codeOf(wider)).toBe('GDT_COMPOSITE_INVALID');
    const other = exec(upper.document, 'add_geometric_tolerance', {
      characteristic: 'profile_surface',
      compositeOf: upperId,
      zone: { value: 0.1 },
    });
    expect(codeOf(other)).toBe('GDT_COMPOSITE_INVALID');
    expect(
      codeOf(exec(upper.document, 'add_geometric_tolerance', { characteristic: 'position', compositeOf: 'nope', zone: { value: 0.1 } })),
    ).toBe('GDT_PMI_UNKNOWN');
    const notFcf = exec(upper.document, 'add_geometric_tolerance', {
      characteristic: 'position',
      compositeOf: base.size,
      zone: { value: 0.1 },
    });
    expect(codeOf(notFcf)).toBe('GDT_COMPOSITE_INVALID');
    expect(
      codeOf(
        exec(lower.document, 'add_geometric_tolerance', {
          characteristic: 'position',
          compositeOf: idOf(lower),
          zone: { value: 0.1 },
          materialCondition: 'MMC',
        }),
      ),
    ).toBe('GDT_COMPOSITE_INVALID');
  });

  it('refuses every rule violation with its code', () => {
    const base = withDatums();
    const run = (params: Record<string, unknown>): string | undefined =>
      codeOf(
        exec(base.document, 'add_geometric_tolerance', {
          entityId: base.id,
          facesNear: [BOTTOM],
          characteristic: 'perpendicularity',
          zone: { value: 0.1 },
          ...params,
        }),
      );
    expect(run({ datums: [{ label: 'A' }, { label: 'A' }] })).toBe('GDT_DATUM_REPEATED');
    expect(run({ datums: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }] })).toBe('GDT_DATUM_TOO_MANY');
    expect(run({ datums: [{ label: 'Q' }] })).toBe('GDT_DATUM_UNDEFINED');
    expect(run({ characteristic: 'flatness', datums: [{ label: 'A' }] })).toBe('GDT_FORM_WITH_DATUM');
    expect(run({ zone: { value: 0 } })).toBe('GDT_ZONE_NON_POSITIVE');
    expect(run({ zone: { value: 0.1, projectedLength: 0 } })).toBe('GDT_ZONE_NON_POSITIVE');
    expect(run({ zone: { value: 0.1, unequallyDisposed: 0.5 } })).toBe('GDT_ZONE_NON_POSITIVE');
    expect(run({ materialCondition: 'LMC' })).toBe('GDT_MC_ON_NON_FOS');
    expect(run({ zone: { value: 0.1, diametral: true } })).toBe('GDT_DIAMETRAL_ON_PLANE');
    expect(run({ modifiers: ['all_over'] })).toBe('GDT_MODIFIER_NOT_APPLICABLE');
    expect(run({ entityId: undefined })).toBe('GDT_TARGET_FORM');
    expect(run({ targetPmiId: base.size })).toBe('GDT_TARGET_FORM');
    expect(
      codeOf(exec(base.document, 'add_geometric_tolerance', { characteristic: 'position', targetPmiId: 'nope', zone: { value: 0.1 } })),
    ).toBe('GDT_PMI_UNKNOWN');
    const datumId = items(base.document).find((i) => i.kind === 'datum_feature')?.id as string;
    expect(
      codeOf(exec(base.document, 'add_geometric_tolerance', { characteristic: 'position', targetPmiId: datumId, zone: { value: 0.1 } })),
    ).toBe('GDT_TARGET_FORM');
    expect(
      codeOf(
        exec(base.document, 'add_geometric_tolerance', {
          characteristic: 'position',
          targetPmiId: base.size,
          zone: { value: 0.1, diametral: true },
          materialCondition: 'MMC',
        }),
      ),
    ).toBeUndefined();
    const width = add(base, 'add_size_dimension', { facesNear: [FRONT, [60, 80, 6]], sizeKind: 'width', tolerance: { type: 'basic' } });
    expect(
      codeOf(
        exec(width.document, 'add_geometric_tolerance', {
          characteristic: 'symmetry',
          targetPmiId: idOf(width),
          zone: { value: 0.1, diametral: true },
        }),
      ),
    ).toBe('GDT_DIAMETRAL_ON_PLANE');
  });
});

describe('add_surface_texture and add_pmi_note', () => {
  it('stores texture with units and refuses unknown parameters and values <= 0', () => {
    const run = plate();
    const texture = add(run, 'add_surface_texture', {
      facesNear: [BOTTOM],
      parameter: 'Rz',
      value: 25,
      unit: 'uin',
      lay: '=',
      process: 'ground',
    });
    expect(texture.result.summary).toContain('Rz 25 µin lay = ground');
    expect(codeOf(exec(run.document, 'add_surface_texture', { entityId: run.id, facesNear: [BOTTOM], parameter: 'Rx', value: 1 }))).toBe(
      'GDT_SURFACE_PARAMETER_UNKNOWN',
    );
    expect(codeOf(exec(run.document, 'add_surface_texture', { entityId: run.id, facesNear: [BOTTOM], parameter: 'Ra', value: 0 }))).toBe(
      'GDT_ZONE_NON_POSITIVE',
    );
    expect(codeOf(exec(run.document, 'add_surface_texture', { entityId: 'nope', facesNear: [BOTTOM], parameter: 'Ra', value: 1 }))).toBe(
      'GDT_ENTITY_NOT_SOLID',
    );
    expect(
      codeOf(exec(run.document, 'add_surface_texture', { entityId: run.id, facesNear: [[60, 40, 50]], parameter: 'Ra', value: 1 })),
    ).toBe('GDT_POINT_NOT_ON_FACE');
  });

  it('adds free and attached notes and refuses empty text', () => {
    const run = plate();
    const free = exec(run.document, 'add_pmi_note', { text: 'BREAK ALL SHARP EDGES' });
    expect(free.summary).toContain('free note');
    setGeometryKernel(null);
    expect(exec(run.document, 'add_pmi_note', { text: 'no kernel needed' }).affected).toHaveLength(1);
    setGeometryKernel(plateKernel());
    const attached = add(run, 'add_pmi_note', { text: 'DEBURR', facesNear: [BOTTOM] });
    expect(items(attached.document)[0]).toMatchObject({ kind: 'note', feature: { surface: 'plane' } });
    expect(codeOf(exec(run.document, 'add_pmi_note', { text: '  ' }))).toBe('GDT_NOTE_EMPTY');
    expect(codeOf(exec(run.document, 'add_pmi_note', { text: 'x', facesNear: [BOTTOM] }))).toBe('GDT_ENTITY_NOT_SOLID');
    expect(codeOf(exec(run.document, 'add_pmi_note', { text: 'x', entityId: run.id, facesNear: [[60, 40, 50]] }))).toBe(
      'GDT_POINT_NOT_ON_FACE',
    );
  });
});

describe('update_pmi and delete_pmi', () => {
  function scene(): Run & { a: string; b: string; size: string; fcf: string; note: string; texture: string } {
    let run = plate();
    const a = add(run, 'add_datum_feature', { facesNear: [BOTTOM], label: 'A' });
    run = a;
    const b = add(run, 'add_datum_feature', { facesNear: [FRONT], label: 'B' });
    run = b;
    const size = add(run, 'add_size_dimension', {
      facesNear: [HOLE],
      sizeKind: 'diameter',
      tolerance: { type: 'plusMinus', upper: 0.1, lower: -0.1 },
    });
    run = size;
    const fcf = add(run, 'add_geometric_tolerance', {
      characteristic: 'position',
      targetPmiId: idOf(size),
      zone: { value: 0.3, diametral: true },
      datums: [{ label: 'A' }, { label: 'B' }],
    });
    run = fcf;
    const note = add(run, 'add_pmi_note', { text: 'N' });
    const texture = add(note, 'add_surface_texture', { facesNear: [BOTTOM], parameter: 'Ra', value: 1.6 });
    return {
      document: texture.document,
      id: run.id,
      a: idOf(a),
      b: idOf(b),
      size: idOf(size),
      fcf: idOf(fcf),
      note: idOf(note),
      texture: idOf(texture),
    };
  }

  it('edits fields per kind, resets review, refuses foreign fields and unknown ids', () => {
    const s = scene();
    const tol = exec(s.document, 'update_pmi', { pmiId: s.size, tolerance: { type: 'plusMinus', upper: 0.2, lower: -0.2 } });
    expect(tol.summary).toContain('±0.2');
    expect(tol.document.pmi?.items[s.size]?.review.required).toBe(true);
    expect(exec(tol.document, 'update_pmi', { pmiId: s.size, tolerance: { type: 'plusMinus', upper: 0.2, lower: -0.2 } }).affected).toEqual(
      [],
    );
    expect(codeOf(exec(s.document, 'update_pmi', { pmiId: s.size, text: 'x' }))).toBe('GDT_FIELD_INVALID_FOR_KIND');
    expect(codeOf(exec(s.document, 'update_pmi', { pmiId: 'nope', text: 'x' }))).toBe('GDT_PMI_UNKNOWN');
    expect(codeOf(exec(s.document, 'update_pmi', { pmiId: s.size, tolerance: { type: 'limits', upper: 1, lower: 2 } }))).toBe(
      'GDT_LIMITS_INVERTED',
    );
    const zone = exec(s.document, 'update_pmi', {
      pmiId: s.fcf,
      zone: { value: 0.4, diametral: true },
      materialCondition: 'MMC',
      modifiers: [],
      datums: [{ label: 'A', boundary: 'LMB' }],
    });
    expect(zone.summary).toContain('Ø0.4 Ⓜ | A Ⓛ');
    expect(codeOf(exec(s.document, 'update_pmi', { pmiId: s.fcf, datums: [{ label: 'Q' }] }))).toBe('GDT_DATUM_UNDEFINED');
    expect(exec(s.document, 'update_pmi', { pmiId: s.note, text: 'M' }).summary).toContain('M');
    expect(codeOf(exec(s.document, 'update_pmi', { pmiId: s.note, text: ' ' }))).toBe('GDT_NOTE_EMPTY');
    expect(
      exec(s.document, 'update_pmi', { pmiId: s.texture, value: 3.2, unit: 'um', parameter: 'Rz', lay: 'M', process: 'turned' }).summary,
    ).toContain('Rz 3.2');
    expect(codeOf(exec(s.document, 'update_pmi', { pmiId: s.texture, value: -1 }))).toBe('GDT_ZONE_NON_POSITIVE');
    const target = exec(s.document, 'update_pmi', { pmiId: s.a, areaSize: 3 });
    expect(codeOf(target)).toBe('GDT_FIELD_INVALID_FOR_KIND');
  });

  it('renaming a datum rewrites the frames and targets that reference it', () => {
    const s = scene();
    const renamed = exec(s.document, 'update_pmi', { pmiId: s.a, label: 'P' });
    expect(renamed.affected).toEqual([s.a, s.fcf]);
    const fcf = renamed.document.pmi?.items[s.fcf];
    expect(fcf?.kind === 'geometric_tolerance' && fcf.datums.map((d) => d.label)).toEqual(['P', 'B']);
    expect(codeOf(exec(s.document, 'update_pmi', { pmiId: s.a, label: 'B' }))).toBe('GDT_DATUM_DUPLICATE');
    expect(codeOf(exec(s.document, 'update_pmi', { pmiId: s.a, label: 'a' }))).toBe('GDT_DATUM_LABEL_INVALID');
    const withTarget = add(s, 'add_datum_target', { label: 'A', targetKind: 'point', facesNear: [BOTTOM] });
    const moved = exec(withTarget.document, 'update_pmi', { pmiId: s.a, label: 'R' });
    expect(moved.affected).toContain(idOf(withTarget));
    const target = exec(withTarget.document, 'update_pmi', { pmiId: idOf(withTarget), targetNumber: 4, areaSize: 2 });
    expect(target.summary).toContain('A4');
  });

  it('re-attaches to other faces, recomputes automatic placement, keeps explicit placement', () => {
    const s = scene();
    const moved = exec(s.document, 'update_pmi', { pmiId: s.a, facesNear: [LEFT] });
    expect(moved.document.pmi?.items[s.a]).toMatchObject({ feature: { facesNear: [[0, 40, 6]], surface: 'plane' } });
    expect(codeOf(exec(s.document, 'update_pmi', { pmiId: s.a, facesNear: [[60, 40, 50]] }))).toBe('GDT_FEATURE_UNRESOLVED');
    setGeometryKernel(plateKernel({ thickness: 12, noFaceQuery: true }));
    expect(codeOf(exec(s.document, 'update_pmi', { pmiId: s.a, facesNear: [LEFT] }))).toBe('GDT_KERNEL_NO_TOPOLOGY');
    expect(exec(s.document, 'update_pmi', { pmiId: s.size, tolerance: { type: 'basic' } }).affected).toEqual([s.size]);
    setGeometryKernel(plateKernel());
    const placed = exec(s.document, 'update_pmi', {
      pmiId: s.a,
      placement: { origin: [1, 2, 3], normal: [0, 1, 0], xDir: [1, 0, 0], position: [4, 5] },
    });
    expect(placed.document.pmi?.items[s.a]?.placement).toMatchObject({ auto: false, plane: { origin: [1, 2, 3] } });
    const auto = exec(placed.document, 'update_pmi', { pmiId: s.a, autoPlacement: true });
    expect(auto.document.pmi?.items[s.a]?.placement.auto).toBe(true);
    const onFcf = exec(placed.document, 'update_pmi', { pmiId: s.fcf, autoPlacement: true });
    expect(onFcf.affected).toEqual([s.fcf]);
    expect(exec(s.document, 'update_pmi', { pmiId: s.note, autoPlacement: true }).affected).toEqual([s.note]);
  });

  it('deletes, cascades through sizes and datums, and cleans saved views', () => {
    const s = scene();
    const view = exec(s.document, 'create_saved_view', { name: 'V', direction: 'top', pmiIds: [s.a, s.fcf] });
    expect(codeOf(exec(view.document, 'delete_pmi', { pmiId: 'nope' }))).toBe('GDT_PMI_UNKNOWN');
    const referenced = exec(view.document, 'delete_pmi', { pmiId: s.a });
    expect(codeOf(referenced)).toBe('GDT_DATUM_REFERENCED');
    expect(referenced.error?.ids).toEqual([s.fcf]);
    const cascade = exec(view.document, 'delete_pmi', { pmiId: s.a, cascade: true });
    expect(cascade.affected).toEqual([s.a, s.fcf]);
    expect(Object.values(cascade.document.pmi?.savedViews ?? {})[0]?.pmiIds).toEqual([]);
    const size = exec(view.document, 'delete_pmi', { pmiId: s.size });
    expect(size.affected).toEqual([s.size, s.fcf]);
    expect(exec(view.document, 'delete_pmi', { pmiId: s.note }).affected).toEqual([s.note]);
    const upper = add(s, 'add_geometric_tolerance', {
      characteristic: 'position',
      targetPmiId: s.size,
      zone: { value: 0.5, diametral: true },
    });
    const lower = add(upper, 'add_geometric_tolerance', {
      characteristic: 'position',
      compositeOf: idOf(upper),
      zone: { value: 0.1, diametral: true },
    });
    expect(exec(lower.document, 'delete_pmi', { pmiId: idOf(upper) }).affected).toContain(idOf(lower));
  });
});

describe('saved views', () => {
  it('creates, edits, activates and deletes; refuses bad input', () => {
    const run = add(plate(), 'add_datum_feature', { facesNear: [BOTTOM] });
    const a = idOf(run);
    const created = exec(run.document, 'create_saved_view', {
      name: 'TOP',
      direction: 'top',
      pmiIds: [a],
      entityIds: [run.id],
      section: { direction: 'front', offset: 5 },
    });
    const id = created.affected[0] as string;
    expect(created.document.pmi?.savedViews[id]).toMatchObject({ name: 'TOP', pmiIds: [a], entityIds: [run.id], section: { offset: 5 } });
    const explicit = exec(created.document, 'create_saved_view', {
      name: 'CAM',
      camera: { target: [0, 0, 0], azimuth: 1, polar: 1, distance: 50 },
    });
    expect(explicit.document.pmi?.savedViewOrder).toHaveLength(2);
    expect(codeOf(exec(run.document, 'create_saved_view', { name: 'x' }))).toBe('GDT_FIELD_INVALID_FOR_KIND');
    expect(
      codeOf(
        exec(run.document, 'create_saved_view', {
          name: 'x',
          direction: 'top',
          camera: { target: [0, 0, 0], azimuth: 0, polar: 1, distance: 1 },
        }),
      ),
    ).toBe('GDT_FIELD_INVALID_FOR_KIND');
    expect(codeOf(exec(run.document, 'create_saved_view', { name: 'x', direction: 'top', pmiIds: ['nope'], entityIds: ['nothing'] }))).toBe(
      'GDT_VIEW_REF_UNKNOWN',
    );
    expect(exec(createEmptyDocument(), 'create_saved_view', { name: 'empty', direction: 'iso' }).document.pmi?.savedViewOrder).toHaveLength(
      1,
    );
    const updated = exec(created.document, 'update_saved_view', {
      savedViewId: id,
      name: 'TOP2',
      direction: 'front',
      pmiIds: [],
      entityIds: [],
    });
    expect(updated.document.pmi?.savedViews[id]).toMatchObject({ name: 'TOP2', pmiIds: [] });
    expect(updated.document.pmi?.savedViews[id]?.entityIds).toBeUndefined();
    expect(exec(created.document, 'update_saved_view', { savedViewId: id, name: 'TOP' }).affected).toEqual([]);
    expect(codeOf(exec(created.document, 'update_saved_view', { savedViewId: 'nope', name: 'x' }))).toBe('GDT_VIEW_REF_UNKNOWN');
    expect(codeOf(exec(created.document, 'update_saved_view', { savedViewId: id, pmiIds: ['nope'] }))).toBe('GDT_VIEW_REF_UNKNOWN');
    expect(
      codeOf(
        exec(created.document, 'update_saved_view', {
          savedViewId: id,
          direction: 'top',
          camera: { target: [0, 0, 0], azimuth: 0, polar: 1, distance: 1 },
        }),
      ),
    ).toBe('GDT_FIELD_INVALID_FOR_KIND');
    const section = exec(created.document, 'update_saved_view', {
      savedViewId: id,
      section: { direction: 'right', offset: 1 },
      camera: { target: [1, 1, 1], azimuth: 2, polar: 2, distance: 9 },
    });
    expect(section.document.pmi?.savedViews[id]?.camera.distance).toBe(9);
    const active = exec(created.document, 'activate_saved_view', { savedViewId: id });
    expect(active.document.camera).toEqual(created.document.pmi?.savedViews[id]?.camera);
    expect(active.document.pmi?.activeSavedViewId).toBe(id);
    expect(active.document.featureHistory).toHaveLength(created.document.featureHistory.length);
    expect(codeOf(exec(created.document, 'activate_saved_view', { savedViewId: 'nope' }))).toBe('GDT_VIEW_REF_UNKNOWN');
    const survives = exec(active.document, 'replay_history', {});
    expect(survives.document.pmi?.activeSavedViewId).toBe(id);
    const gone = exec(active.document, 'delete_saved_view', { savedViewId: id });
    expect(gone.document.pmi?.activeSavedViewId).toBeUndefined();
    expect(gone.document.pmi?.savedViewOrder).toEqual([]);
    expect(
      exec(created.document, 'delete_saved_view', { savedViewId: explicit.affected[0] as string }).document.pmi?.activeSavedViewId,
    ).toBeUndefined();
    expect(codeOf(exec(created.document, 'delete_saved_view', { savedViewId: 'nope' }))).toBe('GDT_VIEW_REF_UNKNOWN');
    const other = exec(active.document, 'delete_saved_view', { savedViewId: explicit.affected[0] as string });
    expect(other.document.pmi?.activeSavedViewId).toBe(id);
  });
});

describe('accept_pmi_review: the human gate (VC-GDT-57)', () => {
  const human = { verify: () => ({ signer: 'Ada Lovelace', signatureId: 'sig-1' }) };
  const withHuman = { ...defaultContext(), humanSignature: human };

  it('refuses an agent (no / boolean / unsigned confirmation) and leaves the document unchanged', () => {
    const run = add(plate(), 'add_datum_feature', { facesNear: [BOTTOM] });
    const params = { pmiIds: [idOf(run)], decision: 'accept', comment: 'ok', at: '2026-10-20' };
    const bare = exec(run.document, 'accept_pmi_review', params);
    expect(codeOf(bare)).toBe('GDT_REVIEW_HUMAN_ONLY');
    expect(bare.document).toBe(run.document);
    expect(codeOf(exec(run.document, 'accept_pmi_review', { ...params, confirmation: true }))).toBe('GDT_REVIEW_HUMAN_ONLY');
    expect(
      codeOf(
        execute(
          run.document,
          'accept_pmi_review',
          { ...params, confirmation: { nonce: 'n' } },
          { ...defaultContext(), humanSignature: null },
        ),
      ),
    ).toBe('GDT_REVIEW_HUMAN_ONLY');
  });

  it('accepts and rejects with a verified human signature', () => {
    const run = add(plate(), 'add_datum_feature', { facesNear: [BOTTOM] });
    const id = idOf(run);
    const accepted = execute(
      run.document,
      'accept_pmi_review',
      { pmiIds: [id], decision: 'accept', comment: '', at: '2026-10-20', confirmation: { nonce: 'n1' } },
      withHuman,
    );
    expect(accepted.rejected).toBeUndefined();
    expect(accepted.document.pmi?.items[id]?.review).toEqual({ required: false, acceptedBy: 'Ada Lovelace', acceptedAt: '2026-10-20' });
    expect(accepted.document.featureHistory).toHaveLength(run.document.featureHistory.length);
    const check = exec(accepted.document, 'check_pmi', {}).data as { stats: { reviewRequired: number } };
    expect(check.stats.reviewRequired).toBe(0);
    const rejected = execute(
      accepted.document,
      'accept_pmi_review',
      { pmiIds: [id], decision: 'reject', comment: 'wrong datum', at: 'x', confirmation: { nonce: 'n2' } },
      withHuman,
    );
    expect(rejected.document.pmi?.items[id]?.review).toMatchObject({ required: true });
    expect(rejected.document.pmi?.items[id]?.review.reason).toContain('wrong datum');
    const again = execute(
      run.document,
      'accept_pmi_review',
      { pmiIds: [id], decision: 'reject', comment: 'no', at: 'x', confirmation: { nonce: 'n3' } },
      withHuman,
    );
    expect(again.document.pmi?.items[id]?.review.reason).toContain('rejected by Ada Lovelace');
    const empty = execute(
      run.document,
      'accept_pmi_review',
      { pmiIds: [id], decision: 'reject', comment: ' ', at: 'x', confirmation: { nonce: 'n' } },
      withHuman,
    );
    expect(codeOf(empty)).toBe('GDT_NOTE_EMPTY');
    const unknown = execute(
      run.document,
      'accept_pmi_review',
      { pmiIds: ['nope'], decision: 'accept', comment: 'c', at: 'x', confirmation: { nonce: 'n' } },
      withHuman,
    );
    expect(codeOf(unknown)).toBe('GDT_PMI_UNKNOWN');
    const accepts = execute(
      run.document,
      'accept_pmi_review',
      { pmiIds: [id], decision: 'accept', comment: 'checked', at: 'x', confirmation: { nonce: 'n4' } },
      withHuman,
    );
    expect(accepts.document.pmi?.items[id]?.review.reason).toBe('checked');
  });
});

describe('list_pmi and check_pmi', () => {
  it('lists with filters, ASCII fallback and plane data; check reports unused datums and coverage', () => {
    let run = plate();
    run = add(run, 'add_datum_feature', { facesNear: [BOTTOM], label: 'A' });
    const size = add(run, 'add_size_dimension', {
      facesNear: [HOLE],
      sizeKind: 'diameter',
      tolerance: { type: 'plusMinus', upper: 0.1, lower: -0.1 },
    });
    const fcf = add(size, 'add_geometric_tolerance', {
      characteristic: 'position',
      targetPmiId: idOf(size),
      zone: { value: 0.3, diametral: true },
      materialCondition: 'MMC',
      datums: [{ label: 'A' }],
    });
    const list = exec(fcf.document, 'list_pmi', { ascii: true }).data as {
      items: Array<{ text: string; placement: { unit: string; plane: { normal: number[] } } }>;
      standard: string;
    };
    expect(list.items.map((i) => i.text)).toEqual(['[A]', 'Ø6.6 ±0.1', 'POSITION | Ø0.3 (M) | A']);
    expect(list.items[0]?.placement.unit).toBe('mm');
    expect(exec(fcf.document, 'list_pmi', { kind: 'datum_feature' }).summary).toContain('1 item');
    expect(exec(fcf.document, 'list_pmi', { entityId: 'other' }).summary).toContain('0 item');
    expect(exec(createEmptyDocument(), 'list_pmi', {}).summary).toContain('no PMI yet');
    const unused = exec(size.document, 'check_pmi', {}).data as { warnings: Array<{ code: string }> };
    expect(unused.warnings.map((w) => w.code)).toContain('GDT_DATUM_UNUSED');
    const coverage = exec(fcf.document, 'check_pmi', { requireCoverage: true, rules: 'builtin+table' }).data as {
      warnings: Array<{ code: string; message: string }>;
    };
    expect(coverage.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['GDT_FEATURE_UNTOLERANCED', 'GDT_TABLE_RULE', 'GDT_UNVERIFIED_INPUT']),
    );
    const noted = exec(fcf.document, 'set_pmi_standard', { standard: 'ASME_Y14.5_2018', generalToleranceNote: 'GENERAL' });
    const covered = exec(noted.document, 'check_pmi', { requireCoverage: true }).data as { warnings: Array<{ code: string }> };
    expect(covered.warnings.map((w) => w.code)).not.toContain('GDT_FEATURE_UNTOLERANCED');
    const filtered = exec(fcf.document, 'check_pmi', { entityId: 'nothing' }).data as { stats: { items: number }; status: string };
    expect(filtered.stats.items).toBe(0);
    expect(filtered.status).toBe('pass');
    expect(exec(createEmptyDocument(), 'check_pmi', {}).summary).toContain('pass');
  });

  it('finds duplicate datums, dangling targets, inverted limits, unresolved entities and unverified items in a damaged document', () => {
    const run = add(add(plate(), 'add_datum_feature', { facesNear: [BOTTOM], label: 'A' }), 'add_datum_feature', {
      facesNear: [FRONT],
      label: 'B',
    });
    const size = add(run, 'add_size_dimension', {
      facesNear: [HOLE],
      sizeKind: 'diameter',
      tolerance: { type: 'plusMinus', upper: 0.1, lower: -0.1 },
    });
    const fcf = add(size, 'add_geometric_tolerance', {
      characteristic: 'position',
      targetPmiId: idOf(size),
      zone: { value: 0.3, diametral: true },
      datums: [{ label: 'A' }],
    });
    const ids = items(fcf.document).map((i) => i.id);
    const damaged: CadDocument = JSON.parse(JSON.stringify(fcf.document)) as CadDocument;
    const pmi = damaged.pmi as unknown as { items: Record<string, Record<string, unknown>> };
    const [dA, dB, sizeId, fcfId] = ids as [string, string, string, string];
    (pmi.items[dB] as { label: string }).label = 'A';
    (pmi.items[sizeId] as { tolerance: unknown }).tolerance = { type: 'plusMinus', upper: -1, lower: 1 };
    (pmi.items[fcfId] as { target: unknown }).target = { pmiId: 'ghost' };
    (pmi.items[dA] as { unverified: unknown }).unverified = { reason: 'imported, unmapped' };
    const data = exec(damaged, 'check_pmi', {}).data as {
      status: string;
      errors: Array<{ code: string }>;
      warnings: Array<{ code: string }>;
    };
    expect(data.status).toBe('fail');
    expect(data.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(['GDT_DATUM_DUPLICATE', 'GDT_LIMITS_INVERTED', 'GDT_TARGET_DANGLING']),
    );
    expect(data.warnings.map((w) => w.code)).toContain('GDT_UNVERIFIED_INPUT');
    const gone: CadDocument = {
      ...fcf.document,
      entities: Object.fromEntries(Object.entries(fcf.document.entities).filter(([key]) => key !== run.id)),
      order: [],
    };
    const missing = exec(gone, 'check_pmi', {}).data as { errors: Array<{ code: string }> };
    expect(missing.errors.map((e) => e.code)).toContain('GDT_FEATURE_UNRESOLVED');
  });
});
