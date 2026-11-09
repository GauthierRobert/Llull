import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

/** VC-PRB-06 fixture: parametric box w x h x d = 40 x 20 x 10 mm of density 0.0027 g/mm^3 (mass 21.6 g), sizes bound to the parameters. */
export function boxDoc(): { doc: CadDocument; boxId: string } {
  const built = execute(createEmptyDocument(), 'build_project', {
    actions: [
      { command: 'set_units', params: { units: 'mm' } },
      { command: 'set_parameter', params: { name: 'w', expression: '40' } },
      { command: 'set_parameter', params: { name: 'h', expression: '20' } },
      { command: 'set_parameter', params: { name: 'd', expression: '10' } },
      { command: 'add_box', params: { size: ['=w', '=h', '=d'], position: [0, 0, 0], anchor: 'min' }, as: 'box' },
      { command: 'create_material', params: { name: 'test_al', density: 0.0027, color: '#b8bcc2', metalness: 1, roughness: 0.4 } },
      { command: 'assign_material', params: { materialName: 'test_al', entityIds: ['$box'] } },
    ],
  });
  const boxId = Object.keys(built.document.entities)[0] ?? '';
  return { doc: built.document, boxId };
}

const massQuery = (entityId: string): Record<string, unknown> => ({
  command: 'mass_properties',
  params: { entityId },
  pointer: '/data/mass',
});
const bound = (parameter: string, name: string, mean: number, sd: number): Record<string, unknown> => ({
  name,
  unit: 'mm',
  binding: { kind: 'parameter', parameter },
  distribution: { kind: 'normal', mean, sd },
  citation: { text: 'test input (validation case)' },
});

/** VC-PRB-06: box mass response, w / h / d random (sd 0.1, 0.1, 0.05 mm), limit state `mass_budget` = 22 - mass. */
export function massModel(): { doc: CadDocument; boxId: string } {
  const { doc: base, boxId } = boxDoc();
  let doc = execute(base, 'define_response', { name: 'mass', unit: 'g', query: massQuery(boxId) }).document;
  for (const variable of [bound('w', 'w_rv', 40, 0.1), bound('h', 'h_rv', 20, 0.1), bound('d', 'd_rv', 10, 0.05)])
    doc = execute(doc, 'define_random_variable', variable).document;
  doc = execute(doc, 'define_limit_state', { name: 'mass_budget', expression: '22 - mass', unit: 'g' }).document;
  return { doc, boxId };
}
