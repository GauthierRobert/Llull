/** An acceptance survives save -> load: the model hash covers constructive content only (derived and evaluated geometry is re-derived on load). */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import { acceptancePayload } from '@cae/reliability/acceptance';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { limitStateModelHash } from '@cae/reliability/modelHash';
import { derivedEntityIds } from '@core/plugins/host';
import { isRecord } from '@lib/isRecord';
import { data, type Json } from './support';
import { massModel } from './responses.support';

let kernel: GeometryKernel;
let doc: CadDocument;
beforeAll(async () => {
  kernel = await createManifoldKernel();
  doc = build();
});

const SECRET = 'sig-load';
const port: HumanSignaturePort = {
  verify: (given, payload) =>
    isRecord(given) && given['secret'] === SECRET && given['payload'] === payload ? { signer: 'alice', signatureId: 'sig-1' } : null,
  spend: () => true,
};
const ctx = (): ExecutionContext => ({ ...defaultContext(), kernel, humanSignature: port });

/** The box-mass model plus a plugin-derived slab and a kernel boolean solid (mesh + brep). */
function build(): CadDocument {
  let doc: CadDocument = { ...massModel().doc, uid: 'c'.repeat(32) };
  for (const name of ['Ground', 'Floor']) doc = execute(doc, 'add_level', { name, height: 3000, makeActive: false }, ctx()).document;
  const boundary = [
    [0, 0],
    [4000, 0],
    [4000, 3000],
    [0, 3000],
  ];
  doc = execute(doc, 'add_slab', { levelId: 'level-2', boundary, thickness: 200 }, ctx()).document;
  const a = execute(doc, 'add_box', { size: [10, 10, 10], position: [100, 100, 0] }, ctx());
  const b = execute(a.document, 'add_box', { size: [10, 10, 10], position: [105, 105, 0] }, ctx());
  const union = execute(b.document, 'boolean', { op: 'union', a: a.affected[0], b: b.affected[0] }, ctx());
  return union.document;
}

describe('acceptance across save and load', () => {
  const study = { limitState: 'mass_budget', seed: 3, samples: 100 };
  const checked = (d: CadDocument): Json => data(execute(d, 'check_probabilistic', study, ctx()));

  it('the fixture has a derived entity and a kernel solid with a mesh', () => {
    const entities = Object.values(doc.entities);
    expect(entities.some((entity) => entity.kind === 'mesh' && entity.brep !== undefined)).toBe(true);
    expect(entities.length).toBeGreaterThan(2);
    expect(derivedEntityIds(doc).size).toBeGreaterThan(0);
  });

  it('stays PRB_ACCEPTED after save and load, and the model hash is unchanged', () => {
    const resultHash = ((checked(doc)['limitStates'] as Record<string, Json>)['mass_budget'] as Json)['resultHash'] as string;
    const payload = acceptancePayload('mass_budget', resultHash, study.seed, study.samples, 'covered by test', doc.uid ?? '');
    const accepted = execute(
      doc,
      'accept_reliability_result',
      { ...study, resultHash, justification: 'covered by test', confirmation: { secret: SECRET, payload } },
      ctx(),
    );
    expect(accepted.error).toBeUndefined();
    const loaded = deserializeDocument(serializeDocument(accepted.document));
    expect(limitStateModelHash(loaded, 'mass_budget')).toBe(limitStateModelHash(accepted.document, 'mass_budget'));
    const codes = (d: CadDocument): string[] => (checked(d)['items'] as Array<{ code: string }>).map((item) => item.code);
    expect(codes(accepted.document)).toContain('PRB_ACCEPTED');
    expect(codes(loaded)).toContain('PRB_ACCEPTED');
  });
});
