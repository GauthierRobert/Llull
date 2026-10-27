/**
 * TECHNICAL_SPEC 13.11 runtime tripwire. Every registered command is run, with params generated from its schema, on a document holding an
 * asset-backed mesh whose DISPLAY arrays are wrapped in a recording Proxy. Two things must hold for each command that runs:
 *   1. a command that reads the display triangles carries `readsMeshTriangles` (so `execute` swaps in the stored mesh), unless it is listed
 *      as display-by-design;
 *   2. the asset reference stays true: a mesh keeping its asset keeps its positions, a mesh with a new asset has that asset in the store with
 *      bounds that agree, and no construction tree holds a stored mesh inline.
 * Commands whose generated params are refused (they never reach their `run`) are skipped and counted; the skip list is printed on failure.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { listCommands } from '@core/commands/commandTable';
import type { ExecutionContext, ParamItemSpec } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import { assetLeaves, mapSolidLeaves } from '@core/geometry/recipeLeaves';
import { type CadDocument, type Entity, type MeshData, type MeshSolidEntity } from '@core/model/types';
import { icosphere } from '../../helpers/meshFixtures';
import type { memoryMeshAssets } from '../../helpers/memoryMeshAssets';
import { scene } from '../../helpers/assetScene';
import { fakeKernel, TETRA } from '../../helpers/fakeKernel';

/** Commands that draw or preview the display mesh on purpose (a picture, not a number). */
const DISPLAY_BY_DESIGN: ReadonlySet<string> = new Set(['render_view', 'render_motion', 'render_walkthrough', 'set_face_color']);

const ID_LIKE = /^(id|ids|a|b|from|to|source|target|base|tool|tools)$|(Id|Ids)$/;

function sample(name: string, spec: ParamItemSpec): unknown {
  if (spec.enum !== undefined) return spec.enum[0];
  if (spec.anyOf !== undefined) return spec.anyOf[0] === undefined ? undefined : sample(name, spec.anyOf[0]);
  switch (spec.type) {
    case 'string':
      return ID_LIKE.test(name) ? 'scan' : 'x';
    case 'number':
    case 'integer':
      return 2;
    case 'boolean':
      return false;
    case 'array':
      return spec.items?.type === 'number' ? [2, 3, 4] : [sample(name, spec.items ?? { type: 'string' })];
    case 'object':
      return Object.fromEntries(
        Object.entries(spec.properties ?? {})
          .filter(([key]) => spec.required?.includes(key) === true)
          .map(([key, child]) => [key, sample(key, child)]),
      );
    default:
      return undefined;
  }
}

/** The first stack frame outside this file's trap: the code that read the array (a bare file name and function). */
Error.stackTraceLimit = 40;

function firstFrame(stack: string): string {
  return stack
    .split(String.fromCharCode(10))
    .slice(1)
    .filter((line) => !line.includes('meshAssetProbe.test.ts'))
    .slice(0, 3)
    .map((line) => line.trim().split(/[\\/]/).slice(-1).join(''))
    .join(' < ');
}

interface Fixture {
  readonly doc: CadDocument;
  readonly ctx: ExecutionContext;
  readonly reads: { count: number; on: boolean; frames: Set<string> };
  readonly display: MeshData;
  readonly assets: ReturnType<typeof memoryMeshAssets>;
}

/** Moves the record `from` of `table` to the key and id `scan`, so a generated id-like param ('scan') names the record as well as the entity. */
function rekey(table: Record<string, unknown>, from: string): void {
  const record = table[from] as Record<string, unknown>;
  delete table[from];
  table['scan'] = { ...record, id: 'scan' };
}

/**
 * `doc` plus records that name the scan: an implicit field from the solid, a CFD case and a drawing sheet with a view, each under the id 'scan'.
 * (A topology study and PMI items need a whole analysis set-up and are not seeded: they stay covered by the command-by-command source guard.)
 */
function seedRecords(doc: CadDocument, ctx: ExecutionContext): CadDocument {
  let next = doc;
  const field = execute(next, 'field_from_solid', { entityId: 'scan' }, ctx);
  next = field.document;
  const fields = (next as unknown as { implicit?: { fields: Record<string, unknown> } }).implicit?.fields;
  if (fields !== undefined) rekey(fields, field.affected[0] as string);
  next = execute(
    next,
    'create_cfd_case',
    { id: 'scan', entityIds: ['scan'], freestream: { speedMS: 1 }, reference: { areaM2: 1, lengthM: 1 } },
    ctx,
  ).document;
  const sheet = execute(next, 'create_sheet', { name: 'A' }, ctx);
  const sheetId = sheet.affected[0] as string;
  const view = execute(sheet.document, 'create_drawing_view', { sheetId, direction: 'front', entityIds: ['scan'] }, ctx);
  next = view.document;
  const sheets = next.drawings?.sheets as Record<string, unknown> | undefined;
  if (sheets !== undefined && next.drawings !== undefined) {
    rekey(sheets, sheetId);
    (next.drawings.order as string[]).splice(0, next.drawings.order.length, 'scan');
  }
  return next;
}

function fixture(): Fixture {
  const stored = icosphere(10, 2);
  const triangles = stored.indices.length / 3;
  const base = scene([
    { id: 'scan', fullMesh: stored, claimed: triangles },
    { id: 'part', fullMesh: stored, claimed: triangles },
  ]);
  const assets = base.ctx.meshAssets as ReturnType<typeof memoryMeshAssets>;
  const reads = { count: 0, on: false, frames: new Set<string>() };
  const watch = (array: ReadonlyArray<number>): number[] =>
    new Proxy(array as number[], {
      get(target, key, receiver): unknown {
        if (reads.on && (typeof key === 'symbol' ? key === Symbol.iterator : /^[0-9]+$/.test(key))) {
          const frame = firstFrame(new Error().stack ?? '');
          const code = frame.split(' < ').find((part) => part.includes('.ts')) ?? '';
          if (!/^(guard|jcs).ts/.test(code)) {
            reads.count++;
            reads.frames.add(frame);
          }
        }
        return Reflect.get(target, key, receiver);
      },
    });
  const watched = (entity: Entity): Entity =>
    entity.kind === 'mesh' ? { ...entity, mesh: { positions: watch(entity.mesh.positions), indices: watch(entity.mesh.indices) } } : entity;
  const box = execute({ ...base.doc, entities: {} }, 'add_box', { size: [1, 1, 1] }).document;
  const withBox: CadDocument = {
    ...base.doc,
    entities: { ...box.entities, ...base.doc.entities },
    order: [...box.order, ...base.doc.order],
  };
  const made = execute(withBox, 'create_component', { name: 'part', entityIds: ['part'] });
  const component = Object.values(made.document.components)[0];
  const doc: CadDocument = {
    ...made.document,
    entities: { ...made.document.entities, scan: watched(made.document.entities['scan'] as Entity) },
    components:
      component === undefined
        ? made.document.components
        : { [component.id]: { ...component, entities: { part: watched(component.entities['part'] as Entity) } } },
  };
  // A scaled and a non-uniformly scaled instance of the asset component: expansions that reshape a stored mesh must go through the store.
  const placed = Object.values(doc.entities).find((entity) => entity.kind === 'instance');
  const instances: Record<string, Entity> =
    placed === undefined
      ? {}
      : {
          'inst-scaled': { ...placed, id: 'inst-scaled', scale: [2, 2, 2] } as Entity,
          'inst-skew': { ...placed, id: 'inst-skew', scale: [2, 1, 1] } as Entity,
        };
  const records = seedRecords(
    { ...doc, entities: { ...doc.entities, ...instances }, order: [...doc.order, ...Object.keys(instances)] },
    base.ctx,
  );
  const fake = fakeKernel({ solid: TETRA, boolean: TETRA, shell: TETRA, fillet: TETRA, chamfer: TETRA });
  // A real kernel reads the triangles of every mesh leaf it builds; so does this one.
  const kernel: GeometryKernel = {
    ...fake,
    evaluate: (recipe) => {
      mapSolidLeaves(recipe, (leaf) => {
        if (leaf.kind === 'mesh') for (const value of leaf.mesh.positions) void value;
        return undefined;
      });
      return fake.evaluate(recipe);
    },
  };
  return { doc: records, ctx: { ...base.ctx, kernel }, reads, display: (doc.entities['scan'] as MeshSolidEntity).mesh, assets };
}

const sameNumbers = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function extent(mesh: MeshData): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  mesh.positions.forEach((value, index) => {
    min[index % 3] = Math.min(min[index % 3] as number, value);
    max[index % 3] = Math.max(max[index % 3] as number, value);
  });
  return { min, max };
}

/** What is wrong with the asset-backed meshes of `after`, relative to `before` (empty = consistent). */
function assetProblems(before: CadDocument, after: CadDocument, assets: Fixture['assets']): string[] {
  const problems: string[] = [];
  for (const [id, entity] of Object.entries(after.entities)) {
    if (entity.kind !== 'mesh') continue;
    for (const leaf of entity.brep === undefined ? [] : assetLeaves(entity.brep))
      if (leaf.mesh.positions.length > 3 * 100 && !leaf.mesh.positions.every((value) => Number.isFinite(value)))
        problems.push(`${id}: a tree leaf holds a malformed mesh`);
    if (entity.asset === undefined) continue;
    const previous = before.entities[id];
    if (previous?.kind === 'mesh' && previous.asset?.key === entity.asset.key) {
      if (!sameNumbers(previous.mesh.positions.slice(), entity.mesh.positions.slice()))
        problems.push(`${id}: positions changed but the asset reference is kept (stale)`);
      continue;
    }
    const stored = assets.readMesh(entity.asset.key);
    if (stored === null) problems.push(`${id}: its asset is not in the store`);
    else {
      const { min, max } = extent(stored);
      if (!sameNumbers(min, entity.asset.bounds.min) || !sameNumbers(max, entity.asset.bounds.max))
        problems.push(`${id}: asset bounds disagree with the stored mesh`);
    }
  }
  return problems;
}

describe('every command on an asset-backed mesh (TECHNICAL_SPEC 13.11 tripwire)', () => {
  /** Calls whose params the schema cannot generate: the commands that bake or copy an instance, on the scaled and the non-uniformly scaled one. */
  const explicit: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['explode_instance', { id: 'inst-scaled' }],
    ['explode_instance', { id: 'inst-skew' }],
    ['mass_properties', { entityId: 'inst-scaled' }],
  ];
  const generated = (command: ReturnType<typeof listCommands>[number]): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(command.paramsSchema.properties)
        .filter(([key]) => command.paramsSchema.required.includes(key))
        .map(([key, spec]) => [key, sample(key, spec)]),
    );
  const calls = [
    ...listCommands().map((command) => ({ command, params: generated(command) })),
    ...explicit.flatMap(([name, params]) => {
      const command = listCommands().find((candidate) => candidate.name === name);
      return command === undefined ? [] : [{ command, params }];
    }),
  ];
  const outcomes = calls.map(({ command, params }) => {
    const { doc, ctx, reads, assets } = fixture();
    reads.count = 0;
    reads.frames.clear();
    reads.on = true;
    let result: ReturnType<typeof execute> | null = null;
    let threw = false;
    try {
      result = execute(doc, command.name, params, ctx);
    } catch {
      threw = true;
    }
    reads.on = false;
    const ran = result !== null && result.rejected !== true;
    return {
      name: command.name,
      ran,
      threw,
      reads: reads.count,
      frames: [...reads.frames],
      annotated: command.annotations?.readsMeshTriangles !== undefined && command.annotations.readsMeshTriangles !== false,
      problems: result === null ? [] : assetProblems(doc, result.document, assets),
    };
  });

  it('runs a meaningful share of the registry (the rest is refused before its run and skipped)', () => {
    const ran = outcomes.filter((outcome) => outcome.ran).length;
    const skipped = outcomes.filter((outcome) => !outcome.ran).map((outcome) => outcome.name);
    expect(ran, `skipped: ${skipped.join(' ')}`).toBeGreaterThan(100);
  });

  it('an unannotated command never reads the display triangles', () => {
    const offenders = outcomes
      .filter((o) => o.reads > 0 && !o.annotated && !DISPLAY_BY_DESIGN.has(o.name))
      .map((o) => `${o.name} <- ${o.frames.join(' | ')}`);
    expect(offenders).toEqual([]);
  });

  it('no command leaves a stale or inconsistent asset reference', () => {
    const offenders = outcomes.filter((o) => o.problems.length > 0).map((o) => `${o.name}: ${o.problems.join('; ')}`);
    expect(offenders).toEqual([]);
  });

  it('the recording Proxy records an indexed read and an iteration (a regex regression fails here)', () => {
    const { doc, reads } = fixture();
    const mesh = (doc.entities['scan'] as MeshSolidEntity).mesh;
    reads.count = 0;
    reads.on = true;
    void mesh.positions[3];
    expect(reads.count).toBe(1);
    for (const value of mesh.indices) void value;
    reads.on = false;
    expect(reads.count).toBeGreaterThan(mesh.indices.length);
  });

  it('the fixture records resolve: the generated id-like params reach a field, a CFD case and a sheet', () => {
    const { doc } = fixture();
    const slices = doc as unknown as { implicit?: { fields: Record<string, unknown> }; cfd?: { cases: Record<string, unknown> } };
    expect(Object.keys(slices.implicit?.fields ?? {})).toContain('scan');
    expect(Object.keys(slices.cfd?.cases ?? {})).toContain('scan');
    expect(Object.keys(doc.drawings?.sheets ?? {})).toContain('scan');
  });

  it('the display-by-design list names real commands', () => {
    const names = new Set(listCommands().map((command) => command.name));
    for (const name of DISPLAY_BY_DESIGN) expect(names.has(name), name).toBe(true);
  });
});
