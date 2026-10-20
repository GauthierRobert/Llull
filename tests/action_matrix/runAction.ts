/**
 * Runs one matrix action through `execute` and classifies it: ok / refused / unsupported / error. An `ok` result is checked for a sound
 * solid (finite numbers, closed mesh, volume relation to its operands); the input document is checked for purity.
 */

import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import { isClosedMesh } from '@core/geometry/meshClosure';
import { type CadDocument, type Entity, is3D } from '@core/model/types';
import type { ErrorKind, MatrixRow, Outcome } from './types';

/** How the volume of an `ok` result must relate to the volumes of its operands. */
type VolumeRelation = 'none' | 'union' | 'subtract' | 'intersect' | 'reduces';

export interface ActionSpec {
  readonly command: string;
  readonly params: Record<string, unknown>;
  /** Target label inside the design, part of the baseline key. */
  readonly target: string;
  /** Entity ids the action reads (operands), in order. */
  readonly operands: readonly string[];
  readonly relation: VolumeRelation;
}

export const UNSUPPORTED =
  /does not support|needs the exact B-rep|no exact (B-rep|kernel)|no B-rep|KRN_NO_EXACT_KERNEL|has no exact B-rep|mesh-only/i;
const KERNEL_OPS: Readonly<Record<string, 'fillet' | 'chamfer' | 'shell'>> = {
  fillet_edge: 'fillet',
  chamfer_edge: 'chamfer',
  shell_solid: 'shell',
};
/** Relative slack of the volume relations: closed-form volumes of curved primitives differ from their tessellation by ~1e-3. */
const RELATION_SLACK = 2e-2;

const firstLine = (text: string): string => (text.split('\n')[0] ?? '').slice(0, 240);

/** Every non-finite number reachable from `value` (typed arrays included), or null. */
export function findNonFinite(value: unknown, trail = '$', depth = 0): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${trail}=${value}`;
  if (value === null || typeof value !== 'object' || depth > 8) return null;
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as ArrayLike<number>;
    for (let i = 0; i < view.length; i++) if (!Number.isFinite(view[i])) return `${trail}[${i}]=${view[i]}`;
    return null;
  }
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  for (const [key, child] of entries) {
    const found = findNonFinite(child, `${trail}.${key}`, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

const volumeOf = (doc: CadDocument, id: string): number | null => {
  const volume = (execute(doc, 'mass_properties', { entityId: id }).data as { volume?: unknown } | undefined)?.volume;
  return typeof volume === 'number' ? volume : null;
};

/** The IEEE-754 bit pattern of `value` in hex (null stays null): the determinism mode compares volumes bit for bit. */
export function bitsOf(value: number | null): string | null {
  if (value === null) return null;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}

const solidIds = (doc: CadDocument, ids: readonly string[]): string[] =>
  ids.filter((id) => {
    const entity = doc.entities[id];
    return entity !== undefined && is3D(entity) && entity.kind !== 'instance';
  });

/** Why an `ok` result is not a sound solid, or null. */
function unsoundness(before: CadDocument, after: CadDocument, spec: ActionSpec, affected: readonly string[]): string | null {
  const operandVolumes = solidIds(before, spec.operands).map((id) => volumeOf(before, id) ?? 0);
  const reference = Math.max(0, ...operandVolumes);
  for (const id of solidIds(after, affected)) {
    const entity = after.entities[id] as Entity;
    const bad = findNonFinite(entity);
    if (bad !== null) return `non-finite number in '${id}' at ${bad}`;
    if (entity.kind === 'mesh') {
      if (entity.mesh.indices.length === 0) return `'${id}' has an empty mesh`;
      if (!isClosedMesh(entity.mesh)) return `'${id}' has an open (not watertight) mesh`;
    }
    const volume = volumeOf(after, id);
    if (volume === null) continue;
    if (!Number.isFinite(volume)) return `'${id}' has a non-finite volume (${volume})`;
    if (volume < 0 || (reference > 0 && spec.relation !== 'none' && volume <= 0)) return `'${id}' has volume ${volume}`;
  }
  return relationProblem(before, after, spec, affected);
}

function relationProblem(before: CadDocument, after: CadDocument, spec: ActionSpec, affected: readonly string[]): string | null {
  if (spec.relation === 'none') return null;
  const [a, b] = spec.operands.map((id) => volumeOf(before, id));
  const result = solidIds(after, affected)
    .map((id) => volumeOf(after, id))
    .find((v): v is number => v !== null);
  if (a === null || a === undefined || result === undefined) return null;
  const slack = RELATION_SLACK * Math.max(a, b ?? 0, 1e-9);
  switch (spec.relation) {
    case 'reduces':
      return result > a + slack ? `volume grew from ${a} to ${result}` : null;
    case 'subtract':
      return result > a + slack ? `a - b = ${result} exceeds a = ${a}` : null;
    case 'union':
      if (b === null || b === undefined) return null;
      if (result > a + b + slack) return `a + b = ${result} exceeds ${a} + ${b}`;
      return result < Math.max(a, b) - slack ? `a + b = ${result} is below max(${a}, ${b})` : null;
    case 'intersect':
      if (b === null || b === undefined) return null;
      return result > Math.min(a, b) + slack ? `a & b = ${result} exceeds min(${a}, ${b})` : null;
  }
}

function classifyRefusal(spec: ActionSpec, summary: string, kernel: GeometryKernel | null, code: string | undefined): Outcome {
  const op = KERNEL_OPS[spec.command];
  if (op !== undefined && kernel !== null && !kernel.supports(op)) return 'unsupported';
  return code === 'KRN_NO_EXACT_KERNEL' || UNSUPPORTED.test(summary) ? 'unsupported' : 'refused';
}

const quietWarn = <T>(work: () => T): T => {
  const original = console.warn;
  console.warn = () => undefined;
  try {
    return work();
  } finally {
    console.warn = original;
  }
};

/** Runs `spec` on `doc` (never mutated) and returns its row. Does not throw. */
export function runAction(doc: CadDocument, designId: string, spec: ActionSpec, kernel: GeometryKernel | null): MatrixRow {
  const key = `${designId}|${spec.command}|${spec.target}`;
  const base = { key, design: designId, command: spec.command, target: spec.target };
  const row = (outcome: Outcome, detail: string, extra: Partial<MatrixRow> = {}): MatrixRow => ({
    ...base,
    outcome,
    detail: firstLine(detail),
    volumeBits: null,
    volume: null,
    affected: [],
    ...extra,
  });
  const failure = (errorKind: ErrorKind, detail: string, extra: Partial<MatrixRow> = {}): MatrixRow =>
    row('error', detail, { errorKind, ...extra });
  const snapshot = JSON.stringify(doc);
  let result: ReturnType<typeof execute>;
  try {
    result = quietWarn(() => execute(doc, spec.command, spec.params));
  } catch (error) {
    return failure('throw', error instanceof Error ? error.message : String(error));
  }
  if (JSON.stringify(doc) !== snapshot) return failure('purity', `${spec.command} mutated its input document`);
  if (result.error?.code === 'CMD_THREW') return failure('throw', result.summary);
  const changed = result.affected.length > 0 && result.rejected !== true;
  if (!changed) {
    if (result.document !== doc && JSON.stringify(result.document) !== snapshot)
      return failure('refused_changed', `${spec.command} returned a different document without affecting anything: ${result.summary}`);
    return row(classifyRefusal(spec, result.summary, kernel, result.error?.code), result.summary);
  }
  const problem = quietWarn(() => unsoundness(doc, result.document, spec, result.affected));
  const measured = solidIds(result.document, result.affected)[0];
  const volume = measured === undefined ? null : quietWarn(() => volumeOf(result.document, measured));
  const extra = { volume, volumeBits: bitsOf(volume), affected: result.affected };
  if (problem !== null) return failure(problem.includes('non-finite') ? 'nonfinite' : 'invalid_solid', problem, extra);
  return row('ok', result.summary, extra);
}
