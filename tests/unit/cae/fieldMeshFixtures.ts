/** A static analysis of one implicit body (14 FLL-M1): field sphere or box, a support and a load on faces, a probe, mesh source implicit_field. */

import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

function step(doc: CadDocument, name: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, name, params);
  if (result.rejected === true) throw new Error(`${name} failed: ${result.summary}`);
  return { doc: result.document, id: result.affected[0] ?? '' };
}

export interface ImplicitAnalysis {
  readonly doc: CadDocument;
  readonly bodyId: string;
  readonly fieldId: string;
  readonly analysisId: string;
}

/** A field sphere of radius 10 (or a 20 x 8 x 6 box), body at voxel 1 of material petg, fixed at -z / -x, pulled at +z / +x, a probe at the centre. */
export function implicitAnalysis(shape: 'sphere' | 'box' = 'sphere', meshControls: Record<string, unknown> = {}): ImplicitAnalysis {
  let doc = step(createEmptyDocument(), 'create_material', {
    name: 'petg',
    density: 0.00127,
    color: '#88aacc',
    metalness: 0,
    roughness: 0.6,
  }).doc;
  const field = step(doc, 'add_field_primitive', shape === 'sphere' ? { shape, radius: 10 } : { shape, size: [20, 8, 6] });
  doc = field.doc;
  const body = step(doc, 'create_implicit_body', { field: field.id, voxel: 1, material: 'petg' });
  doc = body.doc;
  const analysis = step(doc, 'create_analysis', { name: 'field', analysisType: 'static' });
  doc = analysis.doc;
  const analysisId = analysis.id;
  doc = step(doc, 'set_part_idealization', { analysisId, entityId: body.id, idealization: 'solid' }).doc;
  const [fixAt, pullAt] =
    shape === 'sphere'
      ? [
          [0, 0, -10],
          [0, 0, 10],
        ]
      : [
          [-10, 0, 0],
          [10, 0, 0],
        ];
  doc = step(doc, 'add_fea_constraint', { analysisId, name: 'root', kind: 'fixed', target: { entityId: body.id, facesNear: [fixAt] } }).doc;
  doc = step(doc, 'add_fea_load', {
    analysisId,
    name: 'pull',
    kind: 'force',
    loadCase: 'LC1',
    category: 'limit',
    target: { entityId: body.id, facesNear: [pullAt] },
    vector: [0, 0, 100],
    distribution: 'total',
  }).doc;
  doc = step(doc, 'add_result_probe', { analysisId, name: 'centre', point: [0, 0, 0], quantity: 'von_mises' }).doc;
  doc = step(doc, 'set_mesh_controls', { analysisId, source: 'implicit_field', globalSize: 2, ...meshControls }).doc;
  return { doc, bodyId: body.id, fieldId: field.id, analysisId };
}
