import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { stepTargets } from '@core/commands/brep/stepTargets';
import { collectExportTriangles } from '@core/geometry/entityTriangles';
import { buildFeatureProgram } from '@core/codegen/featureProgram';
import { getCommand } from '@core/commands/commandTable';
import { cylinderSurface } from '../../helpers/revolvedSurfaces';

const sheet = (): { doc: CadDocument; id: string } => {
  const surface = cylinderSurface(1, 4);
  const result = execute(createEmptyDocument(), 'create_nurbs_surface', {
    degreeU: surface.degreeU,
    degreeV: surface.degreeV,
    poles: surface.poles,
    weights: surface.weights,
    knotsU: surface.knotsU,
    multiplicitiesU: surface.multiplicitiesU,
    knotsV: surface.knotsV,
    multiplicitiesV: surface.multiplicitiesV,
  });
  return { doc: result.document, id: result.affected[0]! };
};

describe('surface sheets in the consumers that used to drop them silently', () => {
  it('mesh exports tessellate a sheet instead of calling it 2D', () => {
    const { doc } = sheet();
    expect(collectExportTriangles(doc, undefined).tris.length).toBeGreaterThan(100);
    const stl = execute(doc, 'export_stl', {});
    expect(stl.summary).not.toMatch(/2D/);
    expect(stl.summary).toMatch(/[1-9]\d* triangles/);
  });

  it('mesh exports say what kind of entity they skipped (curve)', () => {
    const curve = execute(createEmptyDocument(), 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 0, 0],
        [1, 0, 0],
      ],
    });
    const stl = execute(curve.document, 'export_stl', {});
    expect(stl.summary).toMatch(/non-solid.*3D curves/);
  });

  it('STEP export collects a sheet as a face to write (a kernel that cannot build it names it as skipped)', () => {
    const { doc, id } = sheet();
    const targets = stepTargets(doc, [id]);
    expect(targets.sheets.map((entity) => entity.id)).toEqual([id]);
    expect(targets.solids).toEqual([]);
    expect(targets.skipped).toEqual([]);
  });

  it('code export says that sheets and curves were not exported', () => {
    const { doc, id } = sheet();
    const program = buildFeatureProgram(doc, getCommand);
    expect(program.notes.join(' ')).toContain(id);
    expect(program.notes.join(' ')).toMatch(/surface sheets/);
  });

  it('frontal_area measures a closed sheet such as a fuselage (cylinder end view = circle area)', () => {
    const stations = [
      { fs: 0, section: { type: 'point', wl: 0 } },
      { fs: 1, section: { type: 'circle', radius: 1, wl: 0 } },
      { fs: 3, section: { type: 'circle', radius: 1, wl: 0 } },
      { fs: 4, section: { type: 'point', wl: 0 } },
    ];
    const body = execute(createEmptyDocument(), 'loft_fuselage', { stations, degreeV: 1 });
    const doc = execute(body.document, 'set_units', { units: 'm' }).document;
    const result = execute(doc, 'frontal_area', { entityIds: [body.affected[0]!] });
    expect(result.error).toBeUndefined();
    expect((result.data as { frontalAreaM2: number }).frontalAreaM2).toBeCloseTo(Math.PI, 1);
  });
});
