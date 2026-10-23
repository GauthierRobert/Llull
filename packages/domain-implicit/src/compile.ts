/**
 * Field DAG -> FieldProgram (05 IMP TR-IMP-03/04): walks the nodes a field depends on and emits one SSA tape with the distance-quality algebra
 * (5.1), Lipschitz bound, support box and the warnings of offset / shell / blend.
 * @invariant exact primitives stay exact through transform / offset / shell of exact sources; min / max of exact fields is a bound; smooth blends
 *   of bounds are bounds; TPMS are approximate; strut sets are bounds
 * @invariant a node is compiled once per frame (memoised), so a shared operand costs one tape segment
 */

import { FieldBuilder } from '@core/geometry/field/build';
import type { FieldProgram, FieldQuality } from '@core/geometry/field/program';
import type { CadDocument, Vec3 } from '@core/model/types';
import { type Box, type Frame, axisFrame, growBox, intersectBox, placeBox, placeFrame, unionBox, worldFrame } from './frame';
import { type CylindricalMap, type FieldNode, type TpmsNode, fieldOf, inputsOf } from './model';
import { primitiveField } from './primitives';
import { closedSolidMesh } from './solidMesh';
import { strutGeometry } from './struts';
import { type CellCoordinates, TPMS_FACTS, cylindricalCoordinates, rectangularCoordinates, tpmsRegisters } from './tpms';

export interface CompileWarning {
  readonly code: 'IMP_OFFSET_NOT_EXACT' | 'IMP_BLEND_EXCEEDS_FEATURE';
  readonly ids: readonly string[];
  readonly message: string;
}

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
}

export interface CompileFailure {
  readonly ok: false;
  readonly code: 'IMP_FIELD_NOT_FOUND' | 'IMP_ENTITY_NOT_FOUND' | 'IMP_SOLID_NOT_CLOSED';
  readonly message: string;
  readonly ids: readonly string[];
}

interface Part {
  readonly reg: number;
  readonly quality: FieldQuality;
  readonly lipschitz: number;
  readonly box: Box | null;
}

const RANK: Readonly<Record<FieldQuality, number>> = { exact: 0, bound: 1, approximate: 2 };
const worst = (a: FieldQuality, b: FieldQuality): FieldQuality => (RANK[a] >= RANK[b] ? a : b);
const degrade = (quality: FieldQuality): FieldQuality => (quality === 'exact' ? 'bound' : quality);

/** Setback beyond which the blend no longer moves the surface: k for quadratic / chamfer, ~4.6 k for the exponential. */
const blendReach = (kind: 'quadratic' | 'exponential' | 'chamfer', radius: number): number =>
  kind === 'exponential' ? 4.6 * radius : radius;

class Failure extends Error {
  constructor(readonly failure: CompileFailure) {
    super(failure.message);
  }
}

class Compiler {
  readonly b: FieldBuilder;
  readonly warnings: CompileWarning[] = [];
  readonly visited: string[] = [];
  readonly features: number[] = [];
  unverified = false;
  private readonly memo = new Map<string, Part>();

  constructor(
    private readonly doc: CadDocument,
    unit: string,
  ) {
    this.b = new FieldBuilder(unit);
  }

  node(id: string, ids: readonly string[]): FieldNode {
    const found = fieldOf(this.doc, id);
    if (found === undefined) throw new Failure({ ok: false, code: 'IMP_FIELD_NOT_FOUND', message: `no field '${id}'`, ids: [id, ...ids] });
    return found;
  }

  field(id: string, frame: Frame): Part {
    const key = `${id}@${frame.key}`;
    const known = this.memo.get(key);
    if (known !== undefined) return known;
    const node = this.node(id, []);
    for (const input of inputsOf(node)) this.node(input, [id]);
    const part = this.build(node, frame);
    this.memo.set(key, part);
    if (!this.visited.includes(id)) this.visited.push(id);
    return part;
  }

  private build(node: FieldNode, frame: Frame): Part {
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
        return {
          ...source,
          reg: b.shift(source.reg, -node.distance),
          box: source.box === null ? null : growBox(source.box, Math.max(node.distance, 0)),
        };
      }
      case 'shell': {
        const source = this.field(node.source, frame);
        if (source.quality !== 'exact') this.warnNotExact(node.id, node.source, 'shell');
        const t = node.thickness;
        this.features.push(t / 2);
        const reg =
          node.side === 'inside'
            ? b.max(source.reg, b.shift(b.neg(source.reg), -t))
            : node.side === 'outside'
              ? b.max(b.neg(source.reg), b.shift(source.reg, -t))
              : b.shift(b.abs(source.reg), -t / 2);
        const reach = node.side === 'outside' ? t : node.side === 'centred' ? t / 2 : 0;
        return { ...source, reg, box: source.box === null ? null : growBox(source.box, reach) };
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
        return this.lattice(node, frame);
      case 'struts': {
        const local = placeFrame(b, frame, node.origin, node.rotation, 1);
        const { set } = strutGeometry(node.cell, node.cellSize, node.radius, node.nodeRadius);
        this.features.push(node.radius);
        const reg = b.strutSet(set, local.x, local.y, local.z, null);
        return this.clip({ reg, quality: 'bound', lipschitz: 1, box: null }, node.region, frame);
      }
    }
  }

  private lattice(node: TpmsNode, frame: Frame): Part {
    const b = this.b;
    const cell =
      node.map === undefined
        ? rectangularCoordinates(b, node.cellSize, placeFrame(b, frame, node.origin, node.rotation, 1))
        : this.wrapped(node.map, node.cellSize, frame);
    const { field, gradient } = tpmsRegisters(b, node.kind, cell);
    const value = node.control.value;
    const smallest = Math.min(...node.cellSize);
    let reg: number;
    if (node.form === 'network') {
      reg = node.normalize === 'gradient' ? b.div(b.shift(field, -value), gradient) : b.shift(field, -value);
      this.features.push(smallest / 4);
    } else if (node.normalize === 'gradient') {
      reg = b.shift(b.div(b.abs(field), gradient), -value / 2);
      this.features.push(value / 2);
    } else {
      reg = b.shift(b.abs(field), -value);
      this.features.push(smallest / 8);
    }
    const lipschitz = node.normalize === 'gradient' ? 2 : (2 * Math.PI * TPMS_FACTS[node.kind].gradBound) / smallest;
    return this.clip({ reg, quality: 'approximate', lipschitz, box: null }, node.region, frame);
  }

  private wrapped(map: CylindricalMap, cellSize: Vec3, frame: Frame): CellCoordinates {
    return cylindricalCoordinates(this.b, axisFrame(this.b, frame, map.origin, map.axis), map.cellsAround, cellSize[2], map.radialCellSize);
  }

  private clip(part: Part, region: string | undefined, frame: Frame): Part {
    if (region === undefined) return part;
    const bounds = this.field(region, frame);
    return {
      reg: this.b.max(part.reg, bounds.reg),
      quality: worst(degrade(part.quality), degrade(bounds.quality)),
      lipschitz: Math.max(part.lipschitz, bounds.lipschitz),
      box: bounds.box,
    };
  }

  private combine(node: Extract<FieldNode, { op: 'boolean' }>, frame: Frame): Part {
    const b = this.b;
    const parts = node.operands.map((id) => this.field(id, frame));
    const first = parts[0];
    if (first === undefined)
      throw new Failure({ ok: false, code: 'IMP_FIELD_NOT_FOUND', message: 'a boolean needs operands', ids: [node.id] });
    const blend = node.blend;
    const k = blend === undefined ? null : b.constant(blend.radius);
    const smin = (x: number, y: number): number => {
      if (blend === undefined || k === null) return b.min(x, y);
      return b.op(blend.kind === 'quadratic' ? 'smin_quad' : blend.kind === 'exponential' ? 'smin_exp' : 'chamfer_min', x, y, k);
    };
    const merge = (list: readonly Part[]): Part =>
      list
        .slice(1)
        .reduce(
          (acc, part) => ({
            reg: smin(acc.reg, part.reg),
            quality:
              blend === undefined ? worst(degrade(acc.quality), degrade(part.quality)) : worst(degrade(acc.quality), degrade(part.quality)),
            lipschitz: Math.max(acc.lipschitz, part.lipschitz),
            box: acc.box === null || part.box === null ? null : unionBox(acc.box, part.box),
          }),
          list[0] ?? first,
        );
    if (blend !== undefined) this.features.push(blend.radius);
    const reach = blend === undefined ? 0 : blendReach(blend.kind, blend.radius);
    const pad = (box: Box | null): Box | null => (box === null ? null : growBox(box, reach));
    if (node.kind === 'union') {
      const merged = merge(parts);
      return { ...merged, box: pad(merged.box) };
    }
    if (node.kind === 'intersect') {
      const negated = parts.map((part) => ({ ...part, reg: b.neg(part.reg) }));
      const merged = merge(negated);
      const box = parts.reduce<Box | null>(
        (acc, part) => (acc === null ? part.box : part.box === null ? acc : intersectBox(acc, part.box)),
        null,
      );
      return { ...merged, reg: b.neg(merged.reg), box: pad(box) };
    }
    const cutters = merge(parts.slice(1).length === 0 ? [first] : parts.slice(1));
    const reg = blend === undefined ? b.max(first.reg, b.neg(cutters.reg)) : b.neg(smin(b.neg(first.reg), cutters.reg));
    return {
      reg,
      quality: worst(degrade(first.quality), degrade(cutters.quality)),
      lipschitz: Math.max(first.lipschitz, cutters.lipschitz),
      box: pad(first.box),
    };
  }

  private warnNotExact(id: string, source: string, what: string): void {
    this.warnings.push({
      code: 'IMP_OFFSET_NOT_EXACT',
      ids: [id, source],
      message: `${what} of '${source}', whose distance is not exact: the iso-surface is not the true ${what}; expect non-uniform walls (measure with lattice_properties)`,
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

/** Compile `fieldId` of `doc` into a program (see the file header). */
export function compileField(doc: CadDocument, fieldId: string): Compiled | CompileFailure {
  const compiler = new Compiler(doc, doc.units);
  try {
    const part = compiler.field(fieldId, worldFrame(compiler.b));
    const program = compiler.b.finish(part.reg, {
      bounds: part.box === null ? null : { min: part.box.min, max: part.box.max },
      lipschitz: part.lipschitz,
      quality: part.quality,
    });
    return {
      ok: true,
      program,
      warnings: compiler.warnings,
      unverified: compiler.unverified,
      minFeature: compiler.features.length === 0 ? Infinity : Math.min(...compiler.features),
      nodes: compiler.visited,
    };
  } catch (error) {
    if (error instanceof Failure) return error.failure;
    throw error;
  }
}
