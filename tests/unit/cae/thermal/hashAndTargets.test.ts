import { describe, expect, it } from 'vitest';
import { analysisInputHash } from '@cae/hash/inputHash';
import { keyedTargets } from '@cae/hash/targets';
import { addBc, caseOf, must, thermalFixture } from './fixtures';

describe('thermal inputs in the analysis hashes', () => {
  it('a recorded disposition leaves the input hashes alone, a limit or a BC change moves the full hash only', () => {
    const fixture = thermalFixture();
    const sink = addBc(fixture, {
      name: 'T',
      kind: 'temperature',
      value: 20,
      unit: 'degC',
      target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] },
    });
    const full = (doc: Parameters<typeof analysisInputHash>[0]): string => analysisInputHash(doc, fixture.analysisId, 'full');
    const mesh = (doc: Parameters<typeof analysisInputHash>[0]): string => analysisInputHash(doc, fixture.analysisId, 'mesh');
    const withLimit = must(sink.doc, 'add_temperature_limit', {
      analysisId: fixture.analysisId,
      name: 'l',
      entityId: fixture.boxId,
      max: { value: 85, unit: 'degC' },
      source: { citation: 'datasheet' },
    }).document;
    expect(full(withLimit)).not.toBe(full(sink.doc));
    expect(mesh(withLimit)).toBe(mesh(sink.doc));
    const analysisCase = caseOf(withLimit, fixture.analysisId);
    const disposed = {
      ...withLimit,
      analysis: {
        ...withLimit.analysis!,
        cases: {
          [fixture.analysisId]: {
            ...analysisCase,
            thermal: {
              ...analysisCase.thermal!,
              dispositions: {
                'tl-1.1:max': { decision: 'accepted' as const, justification: 'j', resultsHash: 'h', signer: 's', signatureId: 'x' },
              },
            },
          },
        },
      },
    };
    expect(full(disposed)).toBe(full(withLimit));
    const changed = must(withLimit, 'update_thermal_bc', { analysisId: fixture.analysisId, bcId: sink.id, value: 30 }).document;
    expect(full(changed)).not.toBe(full(withLimit));
  });

  it('keys cavity faces V_<cavityId>_<index> so the mesher resolves them', () => {
    const fixture = thermalFixture();
    const faces = [
      { target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] }, emissivity: 0.9 },
      { target: { entityId: fixture.boxId, facesNear: [[1, 1, 0.05]] }, emissivity: 0.8 },
    ];
    const cavity = must(fixture.doc, 'add_cavity_radiation', { analysisId: fixture.analysisId, name: 'C1', faces });
    const id = cavity.affected[0] ?? '';
    const targets = keyedTargets(caseOf(cavity.document, fixture.analysisId));
    expect(targets.map((target) => target.key)).toEqual([`V_${id}_0`, `V_${id}_1`]);
    expect(targets[1]).toMatchObject({ entityId: fixture.boxId, facesNear: [[1, 1, 0.05]] });
  });

  it('keys the two faces of a thermal contact K_<contactId>_M / _S and the mesh hash moves with the contact faces', () => {
    const fixture = thermalFixture();
    const second = must(fixture.doc, 'add_box', { size: [1, 1, 0.05], position: [0, 0, 0.05] });
    const otherId = second.affected[0] ?? '';
    const parted = must(second.document, 'set_part_idealization', { analysisId: fixture.analysisId, entityId: otherId });
    const contact = must(parted.document, 'add_thermal_contact', {
      analysisId: fixture.analysisId,
      name: 'iface',
      master: { entityId: fixture.boxId, facesNear: [[0.5, 0.5, 0.05]] },
      slave: { entityId: otherId, facesNear: [[0.5, 0.5, 0.05]] },
      conductance: { value: 2000, unit: 'W/(m^2*K)' },
    });
    const id = contact.affected[0] ?? '';
    const targets = keyedTargets(caseOf(contact.document, fixture.analysisId));
    expect(targets.map((target) => target.key)).toEqual([`K_${id}_M`, `K_${id}_S`]);
    expect(targets[1]).toMatchObject({ entityId: otherId, facesNear: [[0.5, 0.5, 0.05]] });
    expect(analysisInputHash(contact.document, fixture.analysisId, 'mesh')).not.toBe(
      analysisInputHash(parted.document, fixture.analysisId, 'mesh'),
    );
  });
});
