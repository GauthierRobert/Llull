import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { validateDocumentValues } from '@core/commands/persistenceValidation';

const base = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(createEmptyDocument())) as Record<string, unknown>;

const withSection = (section: string, value: unknown): string[] =>
  validateDocumentValues({ ...base(), [section]: value });

const mateRef = { instanceId: 'inst-1', frame: 'origin' };
const joint = {
  id: 'j1',
  kind: 'revolute',
  a: mateRef,
  b: mateRef,
  axis: 'z',
  angle: 0,
};

describe('validateDocumentValues section guards', () => {
  it('accepts an empty document', () => {
    expect(validateDocumentValues(base())).toEqual([]);
  });

  it('accepts well-formed joints, constraints, drive relations and recipes', () => {
    expect(withSection('joints', { j1: joint })).toEqual([]);
    expect(
      withSection('joints', {
        j2: { ...joint, id: 'j2', kind: 'prismatic', axis: [1, 0, 0], displacement: 2 },
      }),
    ).toEqual([]);
    expect(
      withSection('constraints', {
        c1: {
          id: 'c1',
          kind: 'distance',
          a: { entityId: 'e1', kind: 'start' },
          b: { entityId: 'e2' },
          value: 5,
        },
      }),
    ).toEqual([]);
    expect(
      withSection('driveRelations', {
        d1: { id: 'd1', driver: 'j1', driven: 'j2', ratio: 2, offset: 0.5 },
      }),
    ).toEqual([]);
    expect(
      withSection('recipes', { r1: { name: 'r1', steps: [{ id: 'step-1', name: 'add_box' }] } }),
    ).toEqual([]);
  });

  it.each([
    ['joint is not an object', 'joints', { j1: 5 }, 'is not an object'],
    ['joint kind unknown', 'joints', { j1: { ...joint, kind: 'ball' } }, "unknown kind 'ball'"],
    ['joint mate ref missing', 'joints', { j1: { ...joint, a: 3 } }, 'a must be an object'],
    [
      'joint mate instanceId empty',
      'joints',
      { j1: { ...joint, b: { instanceId: '' } } },
      'b.instanceId must be a non-empty string',
    ],
    [
      'joint mate frame invalid',
      'joints',
      { j1: { ...joint, a: { instanceId: 'i', frame: 'diagonal' } } },
      'a.frame must be',
    ],
    ['joint axis invalid', 'joints', { j1: { ...joint, axis: [1, 0] } }, 'axis must be'],
    [
      'revolute angle not finite',
      'joints',
      { j1: { ...joint, angle: 'x' } },
      'angle must be a finite number',
    ],
    [
      'prismatic displacement missing',
      'joints',
      { j1: { ...joint, kind: 'prismatic' } },
      'displacement must be a finite number',
    ],
    ['constraint not an object', 'constraints', { c1: null }, 'is not an object'],
    [
      'constraint kind unknown',
      'constraints',
      { c1: { id: 'c1', kind: 'warp', a: {}, b: {} } },
      "unknown kind 'warp'",
    ],
    [
      'constraint ref entityId missing',
      'constraints',
      { c1: { id: 'c1', kind: 'coincident', a: {}, b: { entityId: 'e' } } },
      'a.entityId must be a non-empty string',
    ],
    [
      'constraint ref kind invalid',
      'constraints',
      {
        c1: {
          id: 'c1',
          kind: 'coincident',
          a: { entityId: 'e', kind: 'top' },
          b: { entityId: 'e' },
        },
      },
      'a.kind must be start|end|center|mid',
    ],
    [
      'distance constraint value missing',
      'constraints',
      { c1: { id: 'c1', kind: 'distance', a: { entityId: 'e' }, b: { entityId: 'f' } } },
      'value must be a number or string',
    ],
    ['drive relation not an object', 'driveRelations', { d1: 1 }, 'is not an object'],
    [
      'drive relation driver empty',
      'driveRelations',
      { d1: { id: 'd1', driver: '', driven: 'b', ratio: 1 } },
      'driver must be a non-empty string',
    ],
    [
      'drive relation ratio not finite',
      'driveRelations',
      { d1: { id: 'd1', driver: 'a', driven: 'b', ratio: 'fast' } },
      'ratio must be a finite number',
    ],
    [
      'drive relation offset not finite',
      'driveRelations',
      { d1: { id: 'd1', driver: 'a', driven: 'b', ratio: 1, offset: 'x' } },
      'offset must be a finite number',
    ],
    ['recipe not an object', 'recipes', { r1: 'nope' }, 'is not an object'],
    [
      'recipe steps not an array',
      'recipes',
      { r1: { name: 'r1', steps: 3 } },
      'steps must be an array',
    ],
    [
      'recipe step malformed',
      'recipes',
      { r1: { name: 'r1', steps: [{ id: 'step-1' }] } },
      'steps[0].name must be a string',
    ],
  ])('rejects %s', (_label, section, value, fragment) => {
    const errors = withSection(section, value);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain(fragment);
  });
});
