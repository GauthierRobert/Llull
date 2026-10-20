/** create_lamina_material and define_rosette: the lamina data and the 0-degree reference frames of a composite design. */

import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { LaminaMaterial, Rosette } from '@core/model/composites';
import { nextId } from '@lib/id';
import { dot3, len3, normalize3, scale3, sub3 } from '@lib/vec3';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { isUnverified } from './provenance';
import { compact, compositesOf, withComposites } from './state';

const positive = z.number();
const POSITIVE_FIELDS = ['E1', 'E2', 'G12', 'G13', 'G23', 'Xt', 'Xc', 'Yt', 'Yc', 'S', 'plyThickness', 'density', 'GIc', 'GIIc'] as const;

/**
 * @affects creates or replaces doc.composites.materials[name]
 * @invariant every modulus, strength and the ply thickness > 0; nu12^2 < E1 / E2 (positive-definite compliance); -1 <= F12* <= 0
 * @failure non-positive value -> CMP_MATERIAL_NOT_POSITIVE; nu12^2 >= E1/E2 -> CMP_MATERIAL_NOT_POSITIVE_DEFINITE; F12* outside [-1, 0] -> CMP_F12_RANGE
 */
export const createLaminaMaterial = defineCommand({
  name: 'create_lamina_material',
  description:
    'Create or replace a composite lamina material record (the input of laminate analysis, zones and plies). Elastic constants E1 (fibre), E2 ' +
    '(transverse), G12 (in-plane shear) in MPa, nu12 (major Poisson ratio, dimensionless); optional strengths Xt, Xc (fibre tension / ' +
    'compression), Yt, Yc (transverse), S (in-plane shear), all MPa and positive magnitudes: failure criteria are refused when one is missing ' +
    '(no default exists). plyThickness is the cured ply thickness in document length units; density is mass per unit^3 (needed by laminate_mass). ' +
    'basis states what the numbers are: "mean" / "unknown" values or an empty source make every result computed from this material UNVERIFIED; ' +
    'use "b_basis" / "a_basis" only for cited allowables (e.g. NCAMP). source is the free-text citation. lockingAngle / warningShear (degrees) ' +
    'are fabric shear limits for drape; tsaiWuF12Star in [-1, 0] overrides the Tsai-Wu default -0.5. Refused: non-positive values, ' +
    'nu12^2 >= E1/E2 (CMP_MATERIAL_NOT_POSITIVE_DEFINITE). Next: define_rosette, create_composite_part, analyze_laminate.',
  params: z.object({
    name: z.string().min(1).describe('Unique material name, e.g. "T300_5208"; reused names replace the record.'),
    form: z
      .enum(['ud_tape', 'woven', 'core_honeycomb', 'core_foam'])
      .describe('Material form: unidirectional tape, woven fabric or a core.'),
    E1: positive.describe('Longitudinal (fibre direction) modulus, MPa; must be > 0.'),
    E2: positive.describe('Transverse modulus, MPa; must be > 0.'),
    G12: positive.describe('In-plane shear modulus, MPa; must be > 0.'),
    nu12: z.number().describe('Major Poisson ratio (dimensionless); nu12^2 must stay below E1/E2.'),
    G13: positive.describe('Optional out-of-plane shear modulus 1-3, MPa; must be > 0.').optional(),
    G23: positive.describe('Optional out-of-plane shear modulus 2-3, MPa; must be > 0.').optional(),
    Xt: positive.describe('Fibre-direction tensile strength, MPa (positive); must be > 0.').optional(),
    Xc: positive.describe('Fibre-direction compressive strength, MPa (give the magnitude, positive); must be > 0.').optional(),
    Yt: positive.describe('Transverse tensile strength, MPa; must be > 0.').optional(),
    Yc: positive.describe('Transverse compressive strength, MPa (magnitude); must be > 0.').optional(),
    S: positive.describe('In-plane shear strength, MPa; must be > 0.').optional(),
    plyThickness: positive.describe('Cured ply thickness, document length units (mm in mm documents); must be > 0.'),
    density: positive.describe('Lamina density, mass per unit^3 of the document (e.g. g/mm^3 in a mm document); must be > 0.').optional(),
    lockingAngle: z.number().min(0).max(90).describe('Fabric shear locking angle, degrees (drape limit, no default).').optional(),
    warningShear: z.number().min(0).max(90).describe('Fabric shear warning threshold, degrees.').optional(),
    tsaiWuF12Star: z
      .number()
      .describe('Tsai-Wu interaction factor F12* in [-1, 0]; default -0.5 when omitted (reported as a default).')
      .optional(),
    alpha1: z.number().describe('Coefficient of thermal expansion along the fibre, 1/K (may be slightly negative for carbon).').optional(),
    alpha2: z.number().describe('Coefficient of thermal expansion across the fibre, 1/K.').optional(),
    beta1: z
      .number()
      .describe('Moisture swelling strain along the fibre per unit moisture content (mass fraction, dimensionless).')
      .optional(),
    beta2: z
      .number()
      .describe('Moisture swelling strain across the fibre per unit moisture content (mass fraction, dimensionless).')
      .optional(),
    GIc: positive.describe('Mode I fracture toughness, N/mm (for the LaRC03 matrix-tension criterion); must be > 0.').optional(),
    GIIc: positive.describe('Mode II fracture toughness, N/mm (for the LaRC03 matrix-tension criterion); must be > 0.').optional(),
    basis: z.enum(['mean', 'b_basis', 'a_basis', 'unknown']).describe('What the values are; default "unknown" (unverified).').optional(),
    source: z.string().describe('Citation of the data (standard, report, supplier datasheet). Empty = unverified.'),
  }),
  run: (doc, params): CommandResult => {
    const { name, nu12, tsaiWuF12Star, basis = 'unknown', ...rest } = params;
    const bad = POSITIVE_FIELDS.filter((field) => params[field] !== undefined && !(params[field] > 0));
    if (bad.length > 0)
      return refuseCmp(
        doc,
        'create_lamina_material',
        'CMP_MATERIAL_NOT_POSITIVE',
        `${bad.join(', ')} must be > 0`,
        [],
        bad.map((field) => `params.${field}`),
      );
    if (!(nu12 * nu12 < params.E1 / params.E2))
      return refuseCmp(
        doc,
        'create_lamina_material',
        'CMP_MATERIAL_NOT_POSITIVE_DEFINITE',
        `nu12^2 = ${sig(nu12 * nu12)} is not below E1/E2 = ${sig(params.E1 / params.E2)}`,
        [],
        ['params.nu12'],
      );
    if (tsaiWuF12Star !== undefined && (tsaiWuF12Star < -1 || tsaiWuF12Star > 0))
      return refuseCmp(
        doc,
        'create_lamina_material',
        'CMP_F12_RANGE',
        `tsaiWuF12Star ${tsaiWuF12Star} is outside [-1, 0]`,
        [],
        ['params.tsaiWuF12Star'],
      );
    const material = compact<LaminaMaterial>({ ...rest, name, nu12, basis, tsaiWuF12Star });
    const model = compositesOf(doc);
    const replaced = Object.hasOwn(model.materials, name);
    const next = withComposites(doc, { materials: { ...model.materials, [name]: material } });
    return changed(
      next,
      `create_lamina_material: ${replaced ? 'replaced' : 'created'} "${name}" (${material.form}, E1 ${material.E1} MPa, ply ${material.plyThickness}, ${isUnverified(material) ? 'UNVERIFIED' : 'verified'} data).`,
      [name],
    );
  },
});

/**
 * @affects creates doc.composites.rosettes[rosette-<step>.<k>]
 * @invariant axis0 is re-orthogonalised against the normal; both stored as unit vectors
 * @failure zero vectors or axis0 parallel to the normal -> CMP_ROSETTE_DEGENERATE
 */
export const defineRosette = defineCommand({
  name: 'define_rosette',
  description:
    'Define a rosette: the reference frame that gives every ply angle its 0-degree direction. origin is a point [x, y, z] in document ' +
    'units, axis0 the 0-degree fibre direction and normal the laminate normal (both direction vectors, any length). axis0 is projected ' +
    'perpendicular to the normal. method "translational" (default) projects axis0 onto a plane tool face (the part frame x axis); ' +
    '"cylindrical" and "radial" measure 0 degrees along the axis / meridian of a cylinder or cone tool face (give `axis` for cylindrical); ' +
    '"edge" is reserved. Ply angles are degrees counter-clockwise about the face normal. Returns the rosette id; use it (or its name) in ' +
    'create_composite_part. Refused: zero vectors, axis0 parallel to the normal.',
  params: z.object({
    name: z.string().min(1).describe('Unique rosette name, e.g. "R0".'),
    origin: vec3('Rosette origin [x, y, z] in document units; the part frame origin is its projection on the tool face.'),
    axis0: vec3('0-degree direction [x, y, z] (any non-zero length).'),
    normal: vec3('Laminate normal [x, y, z] (any non-zero length).'),
    method: z.enum(['translational', 'cylindrical', 'radial', 'edge']).describe('Orientation method; default "translational".').optional(),
    axis: vec3('Cylinder / cone axis [x, y, z] for method "cylindrical".').optional(),
  }),
  run: (doc, { name, origin, axis0, normal, method = 'translational', axis }): CommandResult => {
    const n = normalize3(normal);
    const along = sub3(axis0, scale3(n, dot3(axis0, n)));
    if (len3(normal) < 1e-12 || len3(axis0) < 1e-12 || len3(along) < 1e-9 * len3(axis0))
      return refuseCmp(
        doc,
        'define_rosette',
        'CMP_ROSETTE_DEGENERATE',
        'axis0 is zero or parallel to the normal',
        [],
        ['params.axis0', 'params.normal'],
      );
    const id = nextId('ros');
    const rosette: Rosette = {
      id,
      name,
      origin,
      axis0: normalize3(along),
      normal: n,
      method,
      ...(axis === undefined ? {} : { axis: normalize3(axis) }),
    };
    const model = compositesOf(doc);
    const taken = Object.values(model.rosettes).some((existing) => existing.name === name);
    const next = withComposites(doc, { rosettes: { ...model.rosettes, [id]: rosette } });
    return changed(
      next,
      `define_rosette: created rosette "${name}" (${id}, ${method}, 0-degree axis [${rosette.axis0.map((c) => sig(c)).join(', ')}]).${taken ? ' A rosette with this name already existed; references by name resolve to the first.' : ''}`,
      [id],
    );
  },
});
