/**
 * Field DAG -> FieldProgram (05 IMP TR-IMP-03/04): walks the nodes a field depends on and emits one SSA tape with the distance-quality algebra
 * (5.1), Lipschitz bound, support box and the warnings of offset / shell / blend.
 * @invariant exact primitives stay exact through transform / offset / shell of exact sources; min / max of exact fields is a bound; smooth blends
 *   of bounds are bounds; TPMS are approximate; strut sets are bounds
 * @invariant a node is compiled once per frame (memoised), so a shared operand costs one tape segment
 * @invariant a graded law (a scalar field id) is evaluated in the frame of the node that uses it; a constant law emits the same tape as a plain number
 */

import { FieldBuilder } from '@core/geometry/field/build';
import type { FieldProgram } from '@core/geometry/field/program';
import type { CadDocument } from '@core/model/types';
import { graphPart, strutsPart, tpmsPart } from './compileLattice';
import { type CompileFailure, type CompileHost, type CompileWarning, Failure, type Part, degrade, worst } from './compileTypes';
import { type Box, type Frame, growBox, intersectBox, placeBox, placeFrame, unionBox, worldFrame } from './frame';
import { type BooleanNode, type FieldNode, type Law, fieldOf, inputsOf } from './model';
import { primitiveField } from './primitives';
import { type ScalarPart, compileScalar } from './scalar';
import { closedSolidMesh } from './solidMesh';

export type { CompileFailure, CompileWarning } from './compileTypes';

export interface Compiled {
  readonly ok: true;
  readonly program: FieldProgram;
  readonly warnings: readonly CompileWarning[];
  /** True when an input is an imported mesh without a pinned source hash. */
  readonly unverified: boolean;
  /** Smallest feature radius known to the compiler (primitive radius, wall / 2, strut radius, blend radius), or Infinity. */
  readonly minFeature: number;
  /** Field ids visited, dependencies first. */
  readonly nodes: readonly string[];
  /** Guaranteed range of a scalar field (infinite ends when unknown); absent for solid fields. */
  readonly scalarRange?: { readonly lo: number; readonly hi: number };
}

/** Setback beyond which the blend no longer moves the surface: k for quadratic / chamfer, ~4.6 k for the exponential. */
const blendReach = (kind: 'quadratic' | 'exponential' | 'chamfer', radius: number): number =>
  kind === 'exponential' ? 4.6 * radius : radius;

class Compiler implements CompileHost {
  readonly b: FieldBuilder;
  readonly warnings: CompileWarning[] = [];
  readonly visited: string[] = [];
  readonly features: number[] = [];
  unverified = false;
  private readonly memo = new Map<string, Part>();
  private readonly scalarMemo = new Map<string, ScalarPart>();

  constructor(
    readonly doc: CadDocument,
    unit: string,
  ) {
    this.b = new FieldBuilder(unit);
  }

  node(id: string, ids: readonly string[]): FieldNode {
    const found = fieldOf(this.doc, id);
    if (found === undefined) throw new Failure({ ok: false, code: 'IMP_FIELD_NOT_FOUND', message: `no field '${id}'`, ids: [id, ...ids] });
    return found;
  }

  private visit(id: string): void {
    if (!this.visited.includes(id)) this.visited.push(id);
  }

  field(id: string, frame: Frame): Part {
    const key = `${id}@${frame.key}`;
    const known = this.memo.get(key);
    if (known !== undefined) return known;
    const node = this.node(id, []);
    if (node.op === 'scalar')
      throw new Failure({ ok: false, code: 'IMP_PARAM_RANGE', message: `'${id}' is a scalar field (a law), not a solid field`, ids: [id] });
    for (const input of inputsOf(node)) this.node(input, [id]);
    const part = this.build(node, frame);
    this.memo.set(key, part);
    this.visit(id);
    return part;
  }

  law(law: Law, frame: Frame): ScalarPart {
    if (typeof law === 'number') return { reg: this.b.constant(law), lo: law, hi: law };
    const key = `${law}@${frame.key}`;
    const known = this.scalarMemo.get(key);
    if (known !== undefined) return known;
    const node = this.node(law, []);
    if (node.op !== 'scalar')
      throw new Failure({
        ok: false,
        code: 'IMP_PARAM_RANGE',
        message: `'${law}' is not a scalar field: use create_scalar_field`,
        ids: [law],
      });
    for (const input of inputsOf(node)) this.node(input, [law]);
    const part = compileScalar(this, node, frame);
    this.scalarMemo.set(key, part);
    this.visit(law);
    return part;
  }

  fieldValue(id: string, frame: Frame): number {
    return this.field(id, frame).reg;
  }

  solidDistance(entityId: string, frame: Frame): number {
    const solid = closedSolidMesh(this.doc, entityId);
    if (!solid.ok) throw new Failure({ ok: false, code: solid.code, message: solid.message, ids: [entityId] });
    this.unverified ||= solid.unpinned;
    return this.b.meshSdf(entityId, solid.mesh, frame.x, frame.y, frame.z);
  }

  /** `reg + sign * law`; a constant law becomes a literal shift (the tape of a plain number). */
  private shifted(reg: number, law: ScalarPart, sign: 1 | -1): number {
    return law.lo === law.hi ? this.b.shift(reg, sign * law.lo) : sign === 1 ? this.b.add(reg, law.reg) : this.b.sub(reg, law.reg);
  }

  private build(node: Exclude<FieldNode, { op: 'scalar' }>, frame: Frame): Part {
    const b = this.b;
    switch (node.op) {
      case 'primitive': {
        const local = placeFrame(b, frame, node.position, node.rotation, 1);
        const { reg, box } = primitiveField(b, node, local);
        this.features.push(...primitiveFeatures(node));
        return { reg, quality: 'exact', lipschitz: 1, box: box === null ? null : placeBox(box, node.position, node.rotation, 1) };
      }
      case 'solid': {
        const solid = closedSolidMesh(this.doc, node.entityId);
        if (!solid.ok) throw new Failure({ ok: false, code: solid.code, message: solid.message, ids: [node.entityId, node.id] });
        this.unverified ||= solid.unpinned;
        const lo: [number, number, number] = [Infinity, Infinity, Infinity];
        const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        const coords = solid.mesh.positions;
        for (let i = 0; i < coords.length; i += 1) {
          const value = coords[i] as number;
          const axis = i % 3;
          if (value < (lo[axis] as number)) lo[axis] = value;
          if (value > (hi[axis] as number)) hi[axis] = value;
        }
        const quality = solid.exactTessellation ? 'exact' : 'bound';
        return { reg: b.meshSdf(node.entityId, solid.mesh, frame.x, frame.y, frame.z), quality, lipschitz: 1, box: { min: lo, max: hi } };
      }
      case 'boolean':
        return this.combine(node, frame);
      case 'offset': {
        const source = this.field(node.source, frame);
        if (source.quality !== 'exact') this.warnNotExact(node.id, node.source, 'offset');
        const distance = this.law(node.distance, frame);
        return {
          ...source,
          reg: this.shifted(source.reg, distance, -1),
          box: source.box === null || !Number.isFinite(distance.hi) ? null : growBox(source.box, Math.max(distance.hi, 0)),
        };
      }
      case 'shell': {
        const source = this.field(node.source, frame);
        if (source.quality !== 'exact') this.warnNotExact(node.id, node.source, 'shell');
        const t = this.law(node.thickness, frame);
        if (Number.isFinite(t.lo)) this.features.push(t.lo / 2);
        const reg =
          node.side === 'inside'
            ? b.max(source.reg, this.shifted(b.neg(source.reg), t, -1))
            : node.side === 'outside'
              ? b.max(b.neg(source.reg), this.shifted(source.reg, t, -1))
              : this.shifted(
                  b.abs(source.reg),
                  t.lo === t.hi ? { ...t, lo: t.lo / 2, hi: t.hi / 2 } : { ...t, reg: b.scale(t.reg, 0.5) },
                  -1,
                );
        const reach = node.side === 'outside' ? t.hi : node.side === 'centred' ? t.hi / 2 : 0;
        return { ...source, reg, box: source.box === null || !Number.isFinite(reach) ? null : growBox(source.box, reach) };
      }
      case 'transform': {
        const local = placeFrame(b, frame, node.position, node.rotation, node.scale);
        const source = this.field(node.source, local);
        return {
          reg: b.scale(source.reg, node.scale),
          quality: source.quality,
          lipschitz: source.lipschitz,
          box: source.box === null ? null : placeBox(source.box, node.position, node.rotation, node.scale),
        };
      }
      case 'tpms':
        return tpmsPart(this, node, frame);
      case 'struts':
        return strutsPart(this, node, frame);
      case 'graph':
        return graphPart(this, node, frame);
      case 'voronoi':
        return graphPart(this, node, frame);
    }
  }

  private combine(node: BooleanNode, frame: Frame): Part {
    const b = this.b;
    const parts = node.operands.map((id) => this.field(id, frame));
    const first = parts[0];
    if (first === undefined)
      throw new Failure({ ok: false, code: 'IMP_FIELD_NOT_FOUND', message: 'a boolean needs operands', ids: [node.id] });
    const blend = node.blend;
    const radius = blend === undefined ? null : this.law(blend.radius, frame);
    const smin = (x: number, y: number): number => {
      if (blend === undefined || radius === null) return b.min(x, y);
      return b.op(blend.kind === 'quadratic' ? 'smin_quad' : blend.kind === 'exponential' ? 'smin_exp' : 'chamfer_min', x, y, radius.reg);
    };
    const merge = (list: readonly Part[]): Part =>
      list
        .slice(1)
        .reduce(
          (acc, part) => ({
            reg: smin(acc.reg, part.reg),
            quality: worst(degrade(acc.quality), degrade(part.quality)),
            lipschitz: Math.max(acc.lipschitz, part.lipschitz),
            box: acc.box === null || part.box === null ? null : unionBox(acc.box, part.box),
          }),
          list[0] ?? first,
        );
    if (radius !== null && Number.isFinite(radius.lo)) this.features.push(radius.lo);
    if (radius !== null && typeof node.blend?.radius === 'string') this.warnSteepLaw(node.id, node.blend.radius);
    const reach = blend === undefined || radius === null ? 0 : blendReach(blend.kind, radius.hi);
    const pad = (box: Box | null): Box | null => (box === null || !Number.isFinite(reach) ? null : growBox(box, reach));
    const quality = (merged: Part): Part => (radius !== null && radius.lo !== radius.hi ? { ...merged, quality: 'approximate' } : merged);
    if (node.kind === 'union') {
      const merged = quality(merge(parts));
      return { ...merged, box: pad(merged.box) };
    }
    if (node.kind === 'intersect') {
      const negated = parts.map((part) => ({ ...part, reg: b.neg(part.reg) }));
      const merged = quality(merge(negated));
      const box = parts.reduce<Box | null>(
        (acc, part) => (acc === null ? part.box : part.box === null ? acc : intersectBox(acc, part.box)),
        null,
      );
      return { ...merged, reg: b.neg(merged.reg), box: pad(box) };
    }
    const cutters = merge(parts.slice(1).length === 0 ? [first] : parts.slice(1));
    const reg = blend === undefined ? b.max(first.reg, b.neg(cutters.reg)) : b.neg(smin(b.neg(first.reg), cutters.reg));
    return quality({
      reg,
      quality: worst(degrade(first.quality), degrade(cutters.quality)),
      lipschitz: Math.max(first.lipschitz, cutters.lipschitz),
      box: pad(first.box),
    });
  }

  private warnNotExact(id: string, source: string, what: string): void {
    this.warnings.push({
      code: 'IMP_OFFSET_NOT_EXACT',
      ids: [id, source],
      message: `${what} of '${source}', whose distance is not exact: the iso-surface is not the true ${what}; expect non-uniform walls (measure with lattice_properties)`,
    });
  }

  private warnSteepLaw(id: string, law: string): void {
    this.warnings.push({
      code: 'IMP_BLEND_LAW_STEEP',
      ids: [id, law],
      message: `blend radius '${law}' varies with position: the blend is an approximation where its gradient reaches 1 (keep |grad k| < 1)`,
    });
  }
}

function primitiveFeatures(node: Extract<FieldNode, { op: 'primitive' }>): number[] {
  const get = (key: string): number => (typeof node.dims[key] === 'number' ? (node.dims[key] as number) : Infinity);
  switch (node.shape) {
    case 'sphere':
      return [get('radius')];
    case 'box': {
      const size = node.dims['size'];
      return Array.isArray(size) ? [Math.min(...(size as number[])) / 2] : [];
    }
    case 'cylinder':
    case 'cone':
      return [Math.min(get('radius'), get('height') / 2)];
    case 'capsule':
      return [get('radius')];
    case 'torus':
      return [get('tubeRadius')];
    case 'plane':
      return [];
  }
}

function finishCompile(compiler: Compiler, root: () => Part | ScalarPart): Compiled | CompileFailure {
  try {
    const part = root();
    const solid = 'quality' in part;
    const program = compiler.b.finish(part.reg, {
      bounds: solid && part.box !== null ? { min: part.box.min, max: part.box.max } : null,
      lipschitz: solid ? part.lipschitz : 1,
      quality: solid ? part.quality : 'approximate',
    });
    return {
      ok: true,
      program,
      warnings: compiler.warnings,
      unverified: compiler.unverified,
      minFeature: compiler.features.length === 0 ? Infinity : Math.min(...compiler.features),
      nodes: compiler.visited,
      ...(solid ? {} : { scalarRange: { lo: part.lo, hi: part.hi } }),
    };
  } catch (error) {
    if (error instanceof Failure) return error.failure;
    throw error;
  }
}

/** Compile `fieldId` of `doc` into a program (see the file header). */
export function compileField(doc: CadDocument, fieldId: string): Compiled | CompileFailure {
  const compiler = new Compiler(doc, doc.units);
  return finishCompile(compiler, () => compiler.field(fieldId, worldFrame(compiler.b)));
}

/** Program whose output is the value of the scalar field (law) `scalarId` at the point; no bounds, quality approximate. */
export function compileScalarField(doc: CadDocument, scalarId: string): Compiled | CompileFailure {
  const compiler = new Compiler(doc, doc.units);
  return finishCompile(compiler, () => compiler.law(scalarId, worldFrame(compiler.b)));
}
