/** Fixtures of the 09 PLM M6 tests: the S3 hinge assembly (released with its children, baselined) and the GD&T plate with numbered characteristics. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { T, approveAll } from './fixtures';
import { run } from './scenarioRunner';

const HASHES = { 'LL-1001': 'b'.repeat(64), 'LL-1002': 'a'.repeat(64), 'LL-1003': 'c'.repeat(64) } as const;

/** The S3 given: assembly LL-3000 with fitting x2, pin x1, bush x2, every child bound as released. */
export function boundAssembly(): CadDocument {
  let doc = createEmptyDocument();
  for (const [componentId, name, instances] of [
    ['comp-fitting', 'Fitting', 2],
    ['comp-pin', 'Pin', 1],
    ['comp-bush', 'Bush', 2],
  ] as const) {
    const added = run(doc, 'add_box', { size: [10, 10, 10] });
    const box = added.affected[0] as string;
    doc = added.document;
    doc = run(doc, 'create_component', { name, entityIds: [box], componentId }).document;
    for (let n = 1; n < instances; n += 1) doc = run(doc, 'insert_instance', { componentId, position: [n * 20, 0, 0] }).document;
  }
  doc = run(doc, 'set_item_identity', {
    partNumber: 'LL-3000',
    name: 'Hinge assembly',
    itemType: 'assembly',
    policy: { humanSignatureRequired: false },
    at: T,
    by: 'u-1',
  }).document;
  for (const [componentId, partNumber, revision] of [
    ['comp-fitting', 'LL-1001', 'B'],
    ['comp-pin', 'LL-1002', 'A'],
    ['comp-bush', 'LL-1003', 'C'],
  ] as const)
    doc = run(doc, 'bind_component_item', {
      componentId,
      partNumber,
      revision,
      state: 'released',
      contentHash: HASHES[partNumber],
      at: T,
    }).document;
  return doc;
}

/** The assembly released as revision A (ECO-1) with the product baseline BL-PBL-0003 frozen. */
export function baselinedAssembly(): CadDocument {
  const review = run(boundAssembly(), 'submit_for_review', { at: T, by: 'u-1' }).document;
  const eco = run(review, 'create_change_order', { id: 'ECO-1', purpose: 'initial-release', at: T, by: 'u-1' }).document;
  const released = run(approveAll(eco), 'release_item', { changeOrder: 'ECO-1', at: T, by: 'u-1' }).document;
  return run(released, 'create_baseline', { id: 'BL-PBL-0003', name: 'Hinge PBL', kind: 'product', at: T, by: 'u-7' }).document;
}

interface Step {
  command: string;
  params: Record<string, unknown>;
}

/** The GD&T plate as a managed part LL-4000 with every PMI item numbered, released as revision A. Needs `plateKernel()` installed by the test. */
export function releasedPlate(): CadDocument {
  const plan = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../../docs/aerospace/03-gdt-mbd-pmi/validation/draft_plan_gdt_plate.json'), 'utf8'),
  ) as Step[];
  const actions = plan.filter((s) => s.command !== 'export_step_ap242' && s.command !== 'update_sheet' && s.command !== 'export_sheet_svg');
  const built = execute(createEmptyDocument(), 'build_project', { actions, onError: 'continue' }).document;
  const managed = run(built, 'set_item_identity', {
    partNumber: 'LL-4000',
    name: 'GD&T plate',
    itemType: 'part',
    policy: { humanSignatureRequired: false },
    at: T,
    by: 'u-1',
  }).document;
  const numbered = run(managed, 'assign_characteristic_ids', {}).document;
  const review = run(numbered, 'submit_for_review', { at: T, by: 'u-1' }).document;
  const eco = run(review, 'create_change_order', { id: 'ECO-1', purpose: 'initial-release', at: T, by: 'u-1' }).document;
  return run(approveAll(eco), 'release_item', { changeOrder: 'ECO-1', at: T, by: 'u-1' }).document;
}
