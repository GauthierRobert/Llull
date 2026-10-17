// Turns one analysis case into the glyphs the viewport draws on the model: supports, mechanical loads, thermal boundary conditions and
// result probes, each with its pill label. Pure: a function of the document and the case, so the overlay only renders the list.

import type { CadDocument, Vec3 } from '@core/model/types';
import type { AnalysisCase, FeaTarget, ProbeQuantity, UnitSystem } from '@core/model/analysis';
import { boundsCenter, boundsExtent, entityBoundsInDoc, mergeBounds, type Bounds } from '@core/geometry/bounds';

type FeaGlyphKind = 'support' | 'force' | 'pressure' | 'gravity' | 'moment' | 'thermal' | 'probe';
/** cube: fixed support; cone: other supports (tip into the face); arrow: head AT the position, shaft trailing back; disc: flat marker on the face. */
type FeaGlyphShape = 'cube' | 'cone' | 'arrow' | 'disc' | 'diamond';

export interface FeaGlyph {
  readonly id: string;
  readonly kind: FeaGlyphKind;
  readonly shape: FeaGlyphShape;
  readonly position: Vec3;
  /** Unit vector the glyph points along (arrow/cone tip direction; disc/cube: the outward face normal reversed). */
  readonly direction: Vec3;
  readonly color: string;
  readonly label: string;
  /** 0-based index among glyphs sharing this position: the label is staggered by it so pills never overlap. */
  readonly stack: number;
  /** Relative arrow length in 0..1 (loads scale to the case's largest); 1 for non-load glyphs. */
  readonly strength: number;
}

const FEA_COLORS = {
  support: '#1fbf9a',
  limit: '#ff9100',
  ultimate: '#ff3d3d',
  heat: '#ff5252',
  temperature: '#4d8dff',
  convection: '#22d3ee',
  probe: '#ffd54a',
} as const;

const FORCE_UNIT: Readonly<Record<UnitSystem, string>> = { 'N-mm-t-s': 'N', 'N-m-kg-s': 'N', 'lbf-in-slinch-s': 'lbf' };
const PRESSURE_UNIT: Readonly<Record<UnitSystem, string>> = { 'N-mm-t-s': 'MPa', 'N-m-kg-s': 'Pa', 'lbf-in-slinch-s': 'psi' };
const ACCELERATION_UNIT: Readonly<Record<UnitSystem, string>> = { 'N-mm-t-s': 'mm/s²', 'N-m-kg-s': 'm/s²', 'lbf-in-slinch-s': 'in/s²' };
const MOMENT_UNIT: Readonly<Record<UnitSystem, string>> = { 'N-mm-t-s': 'N·mm', 'N-m-kg-s': 'N·m', 'lbf-in-slinch-s': 'lbf·in' };
const QUANTITY_LABEL: Readonly<Record<ProbeQuantity, string>> = {
  temperature: 'T',
  heat_flux: 'q',
  u_mag: '|u|',
  u_x: 'ux',
  u_y: 'uy',
  u_z: 'uz',
  von_mises: 'von Mises',
  s_xx: 'σxx',
  s_yy: 'σyy',
  s_zz: 'σzz',
};

const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);

/** Compact number: up to 4 significant digits, no trailing zeros, exponent for very large/small values. */
export function formatValue(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e6 || abs < 1e-3) return value.toExponential(2);
  return String(Number(value.toPrecision(4)));
}

function unitVector(v: Vec3, fallback: Vec3): Vec3 {
  const length = norm(v);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : fallback;
}

/** Nearest axis-aligned outward direction from the part centre to `point` (a face-plane guess for the usual prismatic parts). */
function outwardNormal(point: Vec3, center: Vec3): Vec3 {
  const d: Vec3 = [point[0] - center[0], point[1] - center[1], point[2] - center[2]];
  const axis = [0, 1, 2].reduce((best, i) => (Math.abs(d[i] ?? 0) > Math.abs(d[best] ?? 0) ? i : best), 0);
  const out: [number, number, number] = [0, 0, 0];
  out[axis] = (d[axis] ?? 0) >= 0 ? 1 : -1;
  return out;
}

function partBounds(doc: CadDocument, ids: readonly string[]): Bounds | null {
  let merged: Bounds | null = null;
  for (const id of ids) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    if (entity === undefined) continue;
    const next = entityBoundsInDoc(doc, entity);
    merged = merged === null ? next : mergeBounds(merged, next);
  }
  return merged;
}

/** Size of the analysed parts (document units) so glyphs read at any scale; 1 when nothing resolves. */
export function analysedSize(doc: CadDocument, analysis: AnalysisCase): number {
  const bounds = partBounds(doc, Object.keys(analysis.parts));
  const extent = bounds === null ? 0 : boundsExtent(bounds);
  return extent > 0 ? extent : 1;
}

interface Anchor {
  readonly position: Vec3;
  readonly normal: Vec3;
}

/** Points a target names (faces, then edges, then vertices); the part centre when it names none. */
function anchorsOf(doc: CadDocument, target: FeaTarget | undefined, fallbackIds: readonly string[]): Anchor[] {
  const bounds = partBounds(doc, target === undefined ? fallbackIds : [target.entityId]);
  const center: Vec3 = bounds === null ? [0, 0, 0] : boundsCenter(bounds);
  const points = [...(target?.facesNear ?? []), ...(target?.edgesNear ?? []), ...(target?.pointsNear ?? [])];
  if (points.length === 0 && target?.intersectPlane !== undefined) points.push(target.intersectPlane.point);
  if (points.length === 0) return [{ position: center, normal: [0, 0, 1] }];
  return points.map((position) => ({ position, normal: outwardNormal(position, center) }));
}

const negate = (v: Vec3): Vec3 => [0 - v[0], 0 - v[1], 0 - v[2]];

class GlyphList {
  readonly glyphs: FeaGlyph[] = [];
  private readonly seen = new Map<string, number>();

  add(glyph: Omit<FeaGlyph, 'stack' | 'strength'> & { strength?: number }): void {
    const key = glyph.position.map((c) => c.toFixed(6)).join(',');
    const stack = this.seen.get(key) ?? 0;
    this.seen.set(key, stack + 1);
    this.glyphs.push({ strength: 1, ...glyph, stack });
  }
}

function addSupports(list: GlyphList, doc: CadDocument, analysis: AnalysisCase): void {
  for (const id of analysis.constraintOrder) {
    const constraint = analysis.constraints[id];
    if (constraint === undefined) continue;
    anchorsOf(doc, constraint.target, []).forEach((anchor, i) => {
      list.add({
        id: `support:${id}:${i}`,
        kind: 'support',
        shape: constraint.kind === 'fixed' ? 'cube' : 'cone',
        position: anchor.position,
        direction: negate(anchor.normal),
        color: FEA_COLORS.support,
        label: `${constraint.name} · ${constraint.kind}`,
      });
    });
  }
}

function loadValue(
  unitSystem: UnitSystem,
  kind: 'force' | 'pressure' | 'gravity' | 'moment',
  vector: Vec3 | undefined,
  magnitude: number | undefined,
): string {
  const unit = { force: FORCE_UNIT, pressure: PRESSURE_UNIT, gravity: ACCELERATION_UNIT, moment: MOMENT_UNIT }[kind][unitSystem];
  const amount = kind === 'pressure' ? (magnitude ?? 0) : vector === undefined ? (magnitude ?? 0) : norm(vector);
  return `${formatValue(amount)} ${unit}`;
}

function addLoads(list: GlyphList, doc: CadDocument, analysis: AnalysisCase): void {
  const partIds = Object.keys(analysis.parts);
  const loads = analysis.loadOrder.flatMap((id) => (analysis.loads[id] === undefined ? [] : [analysis.loads[id]]));
  const amountOf = (v: Vec3 | undefined, m: number | undefined): number => Math.abs(v === undefined ? (m ?? 0) : norm(v));
  const largest = Math.max(1e-12, ...loads.map((load) => amountOf(load.vector, load.magnitude)));
  for (const load of loads) {
    const strength = Math.min(1, amountOf(load.vector, load.magnitude) / largest);
    anchorsOf(doc, load.target, partIds).forEach((anchor, i) => {
      const direction =
        load.kind === 'pressure' || load.vector === undefined ? negate(anchor.normal) : unitVector(load.vector, negate(anchor.normal));
      list.add({
        id: `load:${load.id}:${i}`,
        kind: load.kind,
        shape: 'arrow',
        position: anchor.position,
        direction,
        color: load.category === 'ultimate' ? FEA_COLORS.ultimate : FEA_COLORS.limit,
        label: `${load.name} · ${loadValue(analysis.unitSystem, load.kind, load.vector, load.magnitude)}`,
        strength,
      });
    });
  }
}

function addThermal(list: GlyphList, doc: CadDocument, analysis: AnalysisCase): void {
  const thermal = analysis.thermal;
  if (thermal === undefined) return;
  for (const id of thermal.bcOrder) {
    const record = thermal.bcs[id];
    if (record === undefined) continue;
    const { bc } = record;
    const target = bc.kind === 'heat_generation' ? { entityId: bc.entityId } : bc.target;
    const quantity = (q: { value: number; unit: string }): string => `${formatValue(q.value)} ${q.unit}`;
    const spec: { shape: FeaGlyphShape; color: string; value: string } = (() => {
      switch (bc.kind) {
        case 'temperature':
          return { shape: 'disc', color: FEA_COLORS.temperature, value: quantity(bc.value) };
        case 'surface_flux':
        case 'concentrated_flux':
          return { shape: 'arrow', color: FEA_COLORS.heat, value: quantity(bc.value) };
        case 'heat_generation':
          return { shape: 'diamond', color: FEA_COLORS.heat, value: `${quantity(bc.value)} ${bc.mode}` };
        case 'film':
          return {
            shape: 'disc',
            color: FEA_COLORS.convection,
            value: `h${'value' in bc.filmCoefficient ? ` ${quantity(bc.filmCoefficient)}` : ' table'} → ${quantity(bc.sinkTemperature)}`,
          };
        case 'radiation':
          return {
            shape: 'disc',
            color: FEA_COLORS.convection,
            value: `ε${typeof bc.emissivity === 'number' ? ` ${formatValue(bc.emissivity)}` : ''} → ${quantity(bc.sinkTemperature)}`,
          };
      }
    })();
    anchorsOf(doc, target, []).forEach((anchor, i) => {
      list.add({
        id: `thermal:${id}:${i}`,
        kind: 'thermal',
        shape: spec.shape,
        position: anchor.position,
        direction: negate(anchor.normal),
        color: spec.color,
        label: `${record.name} · ${spec.value}`,
      });
    });
  }
}

function addProbes(list: GlyphList, analysis: AnalysisCase): void {
  for (const [id, probe] of Object.entries(analysis.probes)) {
    list.add({
      id: `probe:${id}`,
      kind: 'probe',
      shape: 'diamond',
      position: probe.point,
      direction: [0, 0, 1],
      color: FEA_COLORS.probe,
      label: `${probe.name} · ${QUANTITY_LABEL[probe.quantity]}`,
    });
  }
}

/** Every glyph of `analysis` in draw order: supports, loads, thermal BCs, probes. */
export function feaSetupGlyphs(doc: CadDocument, analysis: AnalysisCase): FeaGlyph[] {
  const list = new GlyphList();
  addSupports(list, doc, analysis);
  addLoads(list, doc, analysis);
  addThermal(list, doc, analysis);
  addProbes(list, analysis);
  return list.glyphs;
}
