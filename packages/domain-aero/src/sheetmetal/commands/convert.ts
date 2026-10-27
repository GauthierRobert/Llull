import { defineCommand, z, vec3 } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { is3D } from '@core/model/types';
import type { SheetMetalPart } from '@core/model/sheetMetal';
import type { FtrCode } from '@core/model/manufacturing';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { nextId } from '@lib/id';
import { getModel, withModel, withPart } from '../graph';
import { fixed, refuse } from '../result';
import { unfoldPart } from '../unfold';
import { buildGraph, estimateThickness, hasPartner, isFailure } from '../convert/graph';
import { readSolid } from '../convert/faces';
import { recogniseJoggles } from '../convert/joggles';

/** Relative disagreement allowed between the solid's volume and thickness x developed area. */
const VOLUME_TOLERANCE = 5e-3;

/**
 * @affects adds 1 sheet-metal part (flats, bends, recognised joggles) describing the solid; the solid stays as is (no derived folded solid)
 * @invariant thickness is constant: the part's volume equals thickness x developed area (K = 0.5) within 0.5 %; bends are coaxial cylinder pairs R / R + T
 * @failure no exact kernel / face-query port / B-rep (FTR_NEEDS_EXACT_KERNEL), cones, tori or splines (FTR_NON_DEVELOPABLE), non-constant thickness or non-cylindrical bends (FTR_NOT_SHEET_METAL) -> rejected with error.code
 */
export const convertToSheetMetal = defineCommand({
  name: 'convert_to_sheet_metal',
  description:
    'Convert an exact solid (an imported STEP from import_step_exact, or any solid with a B-rep under the OCC kernel) into a sheet-metal part so flat_pattern, check_sheet_metal and export_flat_pattern_dxf work on it. ' +
    'The thickness T is measured from the face graph (parallel planes one T apart, coaxial bend cylinders R and R + T); `rule` (create_sheet_metal_rule) supplies the explicit K-factor and design thresholds and must have the same thickness. ' +
    'stationaryFace is a world point on one planar skin face: that face is the fixed reference of the unfolding (material lies behind it). Lengths are in the document length unit. ' +
    'Refusals: FTR_NEEDS_EXACT_KERNEL (use --kernel occt-native and import_step_exact), FTR_RULE_NOT_FOUND, FTR_FACE_NOT_FOUND, FTR_FACE_NOT_PLANAR, FTR_NON_DEVELOPABLE (cone / torus / spline faces), ' +
    'FTR_NOT_SHEET_METAL (non-constant thickness or non-cylindrical bend: model it as a machined part). Joggles are recognised. Next: flat_pattern, check_sheet_metal.',
  annotations: { readsMeshTriangles: true, requiresKernel: true },
  params: z.object({
    id: z.string().describe('Id of an exact solid entity (mesh with a B-rep, e.g. from import_step_exact).'),
    stationaryFace: z
      .object({ near: vec3('World point [x, y, z] on the planar skin face that stays fixed in the unfolding (document length unit).') })
      .describe('Reference face selector.'),
    rule: z.string().describe('Name of a sheet-metal rule with the same thickness as the solid; supplies the K-factor and thresholds.'),
  }),
  run: (doc, { id, stationaryFace, rule: ruleName }, ctx): CommandResult => {
    const fail = (code: FtrCode, why: string, fix: string, where: Parameters<typeof refuse>[5] = {}): CommandResult =>
      refuse(doc, 'convert_to_sheet_metal', code, why, fix, where);
    const entity = doc.entities[id];
    if (entity === undefined || !is3D(entity))
      return fail('FTR_PARAM_INVALID', `no 3D solid "${id}"`, 'Pass the id of an imported or modelled solid.', { paths: ['id'] });
    const model = getModel(doc);
    const rule = model.rules[ruleName];
    if (rule === undefined)
      return fail('FTR_RULE_NOT_FOUND', `no rule "${ruleName}"`, 'Create it with create_sheet_metal_rule first.', { paths: ['rule'] });
    const exact = 'run with --kernel occt-native; for imported parts use import_step_exact';
    const kernel = ctx?.kernel ?? null;
    if (kernel === null || kernel.faceQuery === undefined || (entity.kind === 'mesh' && entity.brep === undefined))
      return fail('FTR_NEEDS_EXACT_KERNEL', `solid ${id} has no exact B-rep or the kernel has no face-query port`, `Rerun ${exact}.`, {
        ids: [id],
      });
    const shape = kernel.evaluate(recipeOf(entity));
    const graph = shape === null ? null : kernel.faceQuery.faceGraph(shape);
    const topology = shape === null ? null : kernel.topology(shape);
    if (shape === null || graph === null || topology === null)
      return fail('FTR_NEEDS_EXACT_KERNEL', `the kernel could not build the face graph of ${id}`, `Rerun ${exact}.`, { ids: [id] });

    const facts = readSolid(graph, topology);
    const faceList = (faces: readonly number[]): string[] => faces.map((face) => `faces[${face}]`);
    if (facts.other.length > 0)
      return fail(
        'FTR_NON_DEVELOPABLE',
        `faces ${facts.other.join(', ')} are not planar or cylindrical`,
        'Flat pattern not possible for cones, tori and splines; use an area estimate.',
        { ids: [id], paths: faceList(facts.other) },
      );
    const thickness = estimateThickness(facts);
    if (thickness === null)
      return fail(
        'FTR_NOT_SHEET_METAL',
        'no pair of parallel faces one thickness apart',
        'The part is not sheet metal; model it as a machined part.',
        { ids: [id] },
      );
    if (Math.abs(thickness - rule.thickness) > 1e-3 * thickness)
      return fail(
        'FTR_PARAM_INVALID',
        `measured thickness ${fixed(thickness)} differs from rule "${rule.name}" thickness ${fixed(rule.thickness)}`,
        `Create a rule with thickness ${fixed(thickness)} (document length unit).`,
        { ids: [id], paths: ['rule'] },
      );

    const nearest = kernel.faceQuery.distance(shape, [stationaryFace.near])?.[0];
    const picked = nearest === undefined ? undefined : facts.planes.get(nearest.face);
    if (nearest === undefined)
      return fail('FTR_FACE_NOT_FOUND', `no face near ${JSON.stringify(stationaryFace.near)}`, 'Pick a point on a planar face.', {
        ids: [id],
        paths: ['stationaryFace.near'],
      });
    if (picked === undefined)
      return fail(
        'FTR_FACE_NOT_PLANAR',
        `face ${nearest.face} is not planar`,
        'Pick a point on a flat skin face (inspect_faces lists faces).',
        { ids: [id], paths: ['stationaryFace.near'] },
      );
    if (!hasPartner(facts, picked, thickness, 1e-3 * thickness))
      return fail(
        'FTR_NOT_SHEET_METAL',
        `face ${picked.index} has no parallel face one thickness behind it (an edge face?)`,
        'Pick a point on a large skin face of the sheet.',
        { ids: [id], paths: faceList([picked.index]) },
      );

    const built = buildGraph(facts, picked, thickness);
    if (isFailure(built)) return fail(built.code, built.why, built.remediation, { ids: [id], paths: faceList(built.faces) });
    const partId = nextId('sm');
    const nodes = [...built.nodes, ...recogniseJoggles(built.nodes, thickness)];
    const part: SheetMetalPart = {
      id: partId,
      rule: rule.name,
      root: 'f1',
      side: 'up',
      nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
      order: nodes.map((node) => node.id),
      sourceEntity: id,
    };
    const unfolded = unfoldPart(part, { ...rule, k: { standard: 'ansi', value: 0.5 } });
    const developed = unfolded === null ? Number.NaN : unfolded.area * thickness;
    if (!(Math.abs(developed - topology.volume) <= VOLUME_TOLERANCE * topology.volume))
      return fail(
        'FTR_NOT_SHEET_METAL',
        `volume ${fixed(topology.volume)} does not match thickness x developed area ${fixed(developed)} (non-constant thickness or unsupported features)`,
        'The part is not sheet metal; model it as a machined part.',
        { ids: [id] },
      );
    const next = withModel(doc, withPart(model, part));
    const flats = nodes.filter((node) => node.type === 'flat').length;
    const joggles = nodes.filter((node) => node.type === 'joggle').length;
    return changed(
      next,
      `convert_to_sheet_metal: solid ${id} -> part "${partId}": thickness ${fixed(thickness)}, ${flats} flat(s), ${built.radii.length} bend(s) (inside radii ${built.radii.map(fixed).join(', ') || 'none'}), ${joggles} joggle(s); reference face ${picked.index}. Volume check ${fixed(topology.volume)} vs ${fixed(developed)}.`,
      [partId],
    );
  },
});
