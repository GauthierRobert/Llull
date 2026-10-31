/**
 * Bill of material and bolting of a line (plant 05 ISO §5.7, TR-ISO-08): rows by item code (PIPE in m of centreline, not cut length, everything else by count), descriptions from the
 * PCF MATERIALS / spec, `unverified` propagated from the catalogue row (AF-32). Each flanged joint (FL-FL pair, or each FL terminal when the mating flange is assumed in scope)
 * adds one gasket and one bolt set; bolts per set and diameter come from the bundled ASME B16.5 flange table by DN and pressure class (class parsed from the flange item code). Pure.
 */

import { distance3 } from '@lib/vec3';
import { FLANGES_B16_5 } from '../catalog/data/flanges';
import { dnToNps, parseDn } from '../catalog/nominal';
import type { LineAnalysis } from './analysis';
import type { NetworkComponent } from './model';

export interface BomRow {
  readonly itemCode: string;
  readonly type: string;
  readonly description?: string;
  readonly quantity: number;
  readonly unit: 'm' | 'ea';
  readonly unverified?: true;
}

export interface BomResult {
  readonly rows: readonly BomRow[];
  /** Ids of components that name no item code (not in the rows). */
  readonly withoutItemCode: readonly string[];
}

const NO_ROW = new Set(['WELD', 'SUPPORT']);
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

/** Rows for the components `include` accepts, first-use order. */
export function bomRows(components: readonly NetworkComponent[], include: (index: number) => boolean): BomResult {
  const rows = new Map<string, { type: string; description?: string; count: number; lengthMm: number; unverified: boolean }>();
  const withoutItemCode: string[] = [];
  components.forEach((component, index) => {
    if (NO_ROW.has(component.type) || !include(index)) return;
    if (component.itemCode === undefined) {
      withoutItemCode.push(component.id);
      return;
    }
    const [start, end] = component.ends;
    const length = component.type === 'PIPE' && start !== undefined && end !== undefined ? distance3(start.xyz, end.xyz) : 0;
    const row = rows.get(component.itemCode) ?? { type: component.type, count: 0, lengthMm: 0, unverified: false };
    rows.set(component.itemCode, {
      ...row,
      ...(component.description === undefined || row.description !== undefined ? {} : { description: component.description }),
      count: row.count + 1,
      lengthMm: row.lengthMm + length,
      unverified: row.unverified || component.unverified === true,
    });
  });
  return {
    rows: [...rows.entries()].map(([itemCode, row]): BomRow => {
      const pipe = row.type === 'PIPE';
      return {
        itemCode,
        type: row.type,
        ...(row.description === undefined ? {} : { description: row.description }),
        quantity: pipe ? round6(row.lengthMm / 1000) : row.count,
        unit: pipe ? 'm' : 'ea',
        ...(row.unverified ? { unverified: true as const } : {}),
      };
    }),
    withoutItemCode,
  };
}

export interface BoltGroup {
  readonly dn: number;
  readonly pressureClass: number;
  readonly boltsPerSet: number;
  readonly boltDiameterIn: string;
  readonly sets: number;
  readonly unverified: boolean;
}

export interface Bolting {
  readonly joints: number;
  readonly gaskets: number;
  readonly studBolts: number;
  /** The one stud diameter (inch designation) when every group shares it, else null. */
  readonly diameter: string | null;
  readonly groups: readonly BoltGroup[];
  /** Flanged joints whose DN or class has no row in the bolt table (ids of the flanges): counted as joints and gaskets, no studs. */
  readonly unresolved: readonly string[];
}

const CLASS_TOKEN = /(?:^|[-_/ .])(150|300|600|900|1500|2500)(?![0-9])/;

export function boltingOf(
  analysis: LineAnalysis,
  matingFlanges: 'assume_in_scope' | 'this_side_only',
  inScope: (componentIndex: number) => boolean,
): Bolting {
  const components = analysis.read.network.components;
  const sites: Array<{ first: number; others: number[] }> = [
    ...analysis.graph.joints
      .filter((joint) => (analysis.classes.get(joint.key) ?? joint.joint) === 'bolted')
      .map((joint) => ({ first: joint.members[0] as number, others: joint.members.slice(1) })),
    ...(matingFlanges === 'assume_in_scope'
      ? analysis.graph.terminals
          .filter((terminal) => terminal.endType === 'FL')
          .map((terminal) => ({ first: terminal.componentIndex, others: [] }))
      : []),
  ].filter((site) => inScope(site.first));
  const groups = new Map<string, BoltGroup>();
  const unresolved: string[] = [];
  for (const site of sites) {
    const flange = [site.first, ...site.others]
      .map((index) => components[index] as NetworkComponent)
      .find((component) => CLASS_TOKEN.test(component.itemCode ?? ''));
    const first = components[site.first] as NetworkComponent;
    const dn = (flange ?? first).ends[0]?.boreMm ?? 0;
    const pressureClass = Number(CLASS_TOKEN.exec(flange?.itemCode ?? '')?.[1] ?? 0);
    const parsed = parseDn(dn);
    const nps = parsed === null ? null : dnToNps(parsed);
    const row = FLANGES_B16_5.find((candidate) => candidate[0] === nps?.key && candidate[1] === pressureClass);
    if (row === undefined) {
      unresolved.push(first.id);
      continue;
    }
    const key = `${dn}/${pressureClass}`;
    const group = groups.get(key);
    groups.set(key, { dn, pressureClass, boltsPerSet: row[5], boltDiameterIn: row[6], sets: (group?.sets ?? 0) + 1, unverified: !row[9] });
  }
  const list = [...groups.values()];
  const diameters = new Set(list.map((group) => group.boltDiameterIn));
  return {
    joints: sites.length,
    gaskets: sites.length,
    studBolts: list.reduce((sum, group) => sum + group.boltsPerSet * group.sets, 0),
    diameter: diameters.size === 1 ? ([...diameters][0] ?? null) : null,
    groups: list,
    unresolved,
  };
}
