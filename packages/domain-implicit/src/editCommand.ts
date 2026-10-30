/**
 * edit_field: change the parameters of a field node and re-derive every body that depends on it (05 IMP 4.1, FR-IMP-01, L8). The edit re-runs the command that
 * created the node with the merged parameters, so it is validated exactly as at creation, and keeps the node id.
 */

import { defineCommand, z } from '@core/commands/schema';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { refuseImplicit } from './codes';
import { compileField, compileScalarField } from './compile';
import { type FieldNode, fieldOf, implicitOf, withField } from './model';
import { dependsOn, rederiveBodies, staleBodies } from './rederive';

type Params = Record<string, unknown>;

interface Editor {
  /** The creating command. */
  readonly creator: string;
  /** Parameters that reproduce `node` on the creating command. */
  readonly params: (node: never) => Params;
  /** Parameters (besides `name`) the caller may change. */
  readonly keys: readonly string[];
  /** Parameter names whose value is a field id (cycle check). */
  readonly refs: readonly string[];
}

const compact = (params: Params): Params => Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));

const PRIMITIVE_KEYS: Readonly<Record<string, readonly string[]>> = {
  sphere: ['radius'],
  box: ['size', 'rounding'],
  cylinder: ['radius', 'height'],
  cone: ['radius', 'height'],
  capsule: ['radius', 'height'],
  torus: ['ringRadius', 'tubeRadius'],
  plane: ['normal', 'offset'],
};

function editorOf(node: FieldNode): Editor {
  switch (node.op) {
    case 'primitive':
      return {
        creator: 'add_field_primitive',
        params: () =>
          compact({
            shape: node.shape,
            ...node.dims,
            rounding: node.rounding,
            position: node.position,
            rotation: node.rotation,
            name: node.name,
          }),
        keys: [...(PRIMITIVE_KEYS[node.shape] ?? []), 'position', 'rotation'],
        refs: [],
      };
    case 'solid':
      return {
        creator: 'field_from_solid',
        params: () => compact({ entityId: node.entityId, name: node.name }),
        keys: ['entityId'],
        refs: [],
      };
    case 'boolean':
      return {
        creator: 'combine_fields',
        params: () =>
          compact({
            op: node.kind,
            a: node.operands[0],
            b: node.operands.length === 2 ? node.operands[1] : node.operands.slice(1),
            blend: node.blend,
            name: node.name,
          }),
        keys: ['op', 'a', 'b', 'blend'],
        refs: ['a', 'b'],
      };
    case 'offset':
      return {
        creator: 'offset_field',
        params: () => compact({ field: node.source, distance: node.distance, name: node.name }),
        keys: ['field', 'distance'],
        refs: ['field', 'distance'],
      };
    case 'shell':
      return {
        creator: 'shell_field',
        params: () => compact({ field: node.source, thickness: node.thickness, side: node.side, name: node.name }),
        keys: ['field', 'thickness', 'side'],
        refs: ['field', 'thickness'],
      };
    case 'transform':
      return {
        creator: 'transform_field',
        params: () => compact({ field: node.source, position: node.position, rotation: node.rotation, scale: node.scale, name: node.name }),
        keys: ['field', 'position', 'rotation', 'scale'],
        refs: ['field'],
      };
    case 'tpms':
      return {
        creator: 'add_tpms_lattice',
        params: () =>
          compact({
            kind: node.kind,
            cellSize: node.cellSize,
            form: node.form,
            ...(node.relativeDensityTarget !== undefined
              ? { relativeDensity: node.relativeDensityTarget }
              : node.control.kind === 'thickness'
                ? { thickness: node.control.value }
                : { level: node.control.value }),
            normalize: node.normalize,
            ...(node.map === undefined ? { origin: node.origin, rotation: node.rotation } : { map: node.map }),
            region: node.region,
            name: node.name,
          }),
        keys: ['kind', 'cellSize', 'form', 'thickness', 'level', 'relativeDensity', 'normalize', 'origin', 'rotation', 'map', 'region'],
        refs: ['region', 'thickness', 'level'],
      };
    case 'struts':
      return {
        creator: 'add_strut_lattice',
        params: () =>
          compact({
            cell: node.cell,
            cellSize: node.cellSize,
            radius: node.radius,
            nodeRadius: node.nodeRadius,
            origin: node.origin,
            rotation: node.rotation,
            region: node.region,
            name: node.name,
          }),
        keys: ['cell', 'cellSize', 'radius', 'nodeRadius', 'origin', 'rotation', 'region'],
        refs: ['region', 'radius'],
      };
    case 'graph':
      return {
        creator: 'add_graph_lattice',
        params: () =>
          compact({
            sourceIds: node.sourceIds,
            radiusStart: node.radiusStart,
            radiusEnd: node.radiusEnd,
            cap: node.cap,
            chord: node.chord,
            mergeTolerance: node.mergeTolerance,
            region: node.region,
            name: node.name,
          }),
        keys: ['sourceIds', 'radiusStart', 'radiusEnd', 'cap', 'chord', 'mergeTolerance', 'region'],
        refs: ['region'],
      };
    case 'voronoi':
      return {
        creator: 'add_voronoi_lattice',
        params: () =>
          compact({ region: node.region, density: node.density, seed: node.seed, radius: node.radius, cap: node.cap, name: node.name }),
        keys: ['region', 'density', 'seed', 'radius', 'cap'],
        refs: ['region'],
      };
    case 'scalar':
      switch (node.kind) {
        case 'coordinate':
          return {
            creator: 'create_scalar_field',
            params: () => compact({ kind: 'coordinate', axis: node.axis, name: node.name }),
            keys: ['axis'],
            refs: [],
          };
        case 'distance': {
          const to = node.to;
          const target =
            'point' in to
              ? { toPoint: to.point }
              : 'plane' in to
                ? { toPlane: to.plane }
                : 'entityId' in to
                  ? { toEntity: to.entityId }
                  : { toField: to.field };
          return {
            creator: 'create_scalar_field',
            params: () => compact({ kind: 'distance', ...target, name: node.name }),
            keys: ['toPoint', 'toPlane', 'toEntity', 'toField'],
            refs: ['toField'],
          };
        }
        case 'ramp':
          return {
            creator: 'create_scalar_field',
            params: () =>
              compact({
                kind: 'ramp',
                input: node.input,
                inMin: node.inMin,
                inMax: node.inMax,
                outMin: node.outMin,
                outMax: node.outMax,
                clamp: node.clamp,
                easing: node.easing,
                name: node.name,
              }),
            keys: ['input', 'inMin', 'inMax', 'outMin', 'outMax', 'clamp', 'easing'],
            refs: ['input'],
          };
        case 'mix':
          return {
            creator: 'create_scalar_field',
            params: () => compact({ kind: 'mix', a: node.a, b: node.b, factor: node.factor, name: node.name }),
            keys: ['a', 'b', 'factor'],
            refs: ['a', 'b', 'factor'],
          };
        case 'arith':
          return {
            creator: 'create_scalar_field',
            params: () => compact({ kind: 'arith', operation: node.operation, a: node.a, b: node.b, name: node.name }),
            keys: ['operation', 'a', 'b'],
            refs: ['a', 'b'],
          };
        case 'noise':
          return {
            creator: 'create_scalar_field',
            params: () => compact({ kind: 'noise', seed: node.seed, frequency: node.frequency, octaves: node.octaves, name: node.name }),
            keys: ['seed', 'frequency', 'octaves'],
            refs: [],
          };
        case 'topology_density':
          return {
            creator: 'create_scalar_field',
            params: () => compact({ kind: 'topology_density', studyId: node.studyId, name: node.name }),
            keys: ['studyId'],
            refs: [],
          };
        case 'fea_result':
          return {
            creator: 'create_scalar_field',
            params: () => compact({ kind: 'fea_result', caseId: node.caseId, quantity: node.quantity, step: node.step, name: node.name }),
            keys: ['caseId', 'quantity', 'step'],
            refs: [],
          };
      }
  }
}

/** Field ids named by the reference parameters of `params`. */
function referencedIds(refs: readonly string[], params: Params): string[] {
  return refs.flatMap((key) => {
    const value = params[key];
    return typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  });
}

/**
 * @affects replaces field node `id` (same id) and re-derives every implicit body that depends on it (their meshes and content hashes change); other nodes are untouched
 * @invariant the new node passes the validation of the command that created it; no edit may make the graph cyclic; if any dependent body cannot be re-derived the edit is refused and the document is unchanged
 * @failure unknown id -> IMP_FIELD_NOT_FOUND; unknown key -> IMP_PARAM_RANGE; a reference that reaches the node itself -> IMP_FIELD_CYCLE; the creating command's own refusal codes; a dependent body refused by the engine -> its IMP_* code
 */
export const editField = defineCommand({
  name: 'edit_field',
  annotations: { readsMeshTriangles: true },
  description:
    'Change parameters of an existing implicit field node by id (design intent: radii, sizes, cell size, laws, blend radius...) and re-derive every implicit body built on it, so the bodies follow the edit. ' +
    '`changes` holds only what changes, named exactly as the parameters of the creating command: add_field_primitive (radius, size, height, ringRadius, tubeRadius, normal, offset, rounding, position, rotation), ' +
    'combine_fields (op, a, b, blend), offset_field (field, distance), shell_field (field, thickness, side), transform_field (field, position, rotation, scale), add_tpms_lattice (kind, cellSize, form, thickness, level, relativeDensity, normalize, origin, rotation, map, region; thickness and level may be a scalar-field id: a graded law), ' +
    'add_strut_lattice (cell, cellSize, radius, nodeRadius, origin, rotation, region; radius may be a scalar-field id), add_graph_lattice (sourceIds, radiusStart, radiusEnd, cap, chord, mergeTolerance, region), add_voronoi_lattice (region, density, seed, radius, cap), field_from_solid (entityId), create_scalar_field (the parameters of its kind). ' +
    'null removes an optional value (region, blend, map, nodeRadius). The shape, kind or lattice family of a node cannot be switched into another operation: create a new node. The node is validated like a new one; an edit that would make the graph cyclic, or that a dependent body cannot realise, is refused with the document unchanged. ' +
    'Next: implicit_properties / check_implicit on the re-derived bodies.',
  params: z.object({
    id: z.string().describe('Id of the field node to edit (from the command that created it).'),
    changes: z
      .record(z.string(), z.unknown())
      .describe("Parameters to change, as an object of the creating command's parameter names; unchanged parameters are kept."),
  }),
  run: (doc, { id, changes }, ctx): CommandResult => {
    const node = fieldOf(doc, id);
    if (node === undefined) return refuseImplicit(doc, 'edit_field', 'IMP_FIELD_NOT_FOUND', `no field '${id}'`, [id], ['params.id']);
    const editor = editorOf(node);
    const unknown = Object.keys(changes).find((key) => key !== 'name' && !editor.keys.includes(key));
    if (unknown !== undefined)
      return refuseImplicit(
        doc,
        'edit_field',
        'IMP_PARAM_RANGE',
        `'${unknown}' is not editable on a ${node.op}${node.op === 'primitive' ? ` ${node.shape}` : ''} node (editable: ${[...editor.keys, 'name'].join(', ')})`,
        [id],
        [`params.changes.${unknown}`],
      );
    const merged: Params = { ...editor.params(node as never), ...changes };
    if (editor.creator === 'add_tpms_lattice' && ('thickness' in changes || 'level' in changes)) delete merged['relativeDensity'];
    if (editor.creator === 'add_tpms_lattice' && 'relativeDensity' in changes) {
      delete merged['thickness'];
      delete merged['level'];
    }
    for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
    const model = implicitOf(doc);
    const cyclic = referencedIds(editor.refs, merged).find((ref) => ref === id || dependsOn(model, ref, id));
    if (cyclic !== undefined)
      return refuseImplicit(
        doc,
        'edit_field',
        'IMP_FIELD_CYCLE',
        `'${cyclic}' is, or depends on, '${id}': the edit would make the field graph cyclic`,
        [id, cyclic],
      );
    const created = execute(doc, editor.creator, merged, ctx);
    if (created.error !== undefined) return refuseImplicit(doc, 'edit_field', created.error.code, created.summary, [id]);
    const replaced = { ...fieldOf(created.document, created.affected[0] as string), id } as FieldNode;
    const next: CadDocument = withField(doc, replaced);
    const compiled = replaced.op === 'scalar' ? compileScalarField(next, id) : compileField(next, id);
    if (!compiled.ok) return refuseImplicit(doc, 'edit_field', compiled.code, compiled.message, compiled.ids);
    const stale = staleBodies(implicitOf(next), new Set([id]));
    const rederived = rederiveBodies(next, stale, ctx);
    if (!rederived.ok) return refuseImplicit(doc, 'edit_field', rederived.code, rederived.message, rederived.ids);
    const changedKeys = Object.keys(changes);
    return {
      document: rederived.document,
      summary: `edit_field: ${id} (${node.op}) changed ${changedKeys.join(', ')}; ${rederived.changed.length === 0 ? 'no implicit body depends on it' : `re-derived ${rederived.changed.length} body(ies): ${rederived.changed.join(', ')}`}.`,
      affected: [id, ...rederived.changed],
      data: {
        id,
        op: node.op,
        changed: changedKeys,
        rederivedBodies: rederived.changed,
        unchangedBodies: rederived.unchanged,
        distanceQuality: compiled.program.quality,
        warnings: compiled.warnings.map(({ code, ids, message }) => ({ code, ids, message })),
        unit: doc.units,
      },
    };
  },
});
