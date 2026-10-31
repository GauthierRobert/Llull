/**
 * `ifc_summary` (plant 08 DAT §5.12): what an IFC file contains, read without importing anything. Counts per class, PredefinedType per class, systems with their
 * members, ports, port connections (relationships and PHYSICAL connections = unordered port pairs, so a file with two reciprocal relationships per connection and a file
 * with one report the same), open ports and duplicate tags. Pure and linear in the entities.
 */

import { readStep, stepString } from '@lib/stepRead';
import { enumOf, isProduct, predefinedIndex, refsOf, TAG_INDEX } from './ifcAccess';
import { properName, typeChain } from './ifcNames';

export interface IfcSystemSummary {
  readonly name: string;
  readonly predefinedType: string | null;
  readonly members: number;
  readonly globalId: string;
}

export interface IfcSummary {
  readonly schema: string;
  readonly entityCount: number;
  /** Entities per class (`IfcPipeSegment`); a class this reader has no proper name for keeps its STEP name. */
  readonly counts: Readonly<Record<string, number>>;
  /** `IfcPipeFitting.BEND` -> n; `None` when the PredefinedType is unset. */
  readonly predefinedTypes: Readonly<Record<string, number>>;
  readonly systems: readonly IfcSystemSummary[];
  readonly ports: number;
  readonly portsNestedInElements: number;
  readonly connections: number;
  readonly physicalConnections: number;
  readonly connectedPorts: number;
  readonly openPorts: number;
  readonly duplicateTags: readonly string[];
  /** Structure errors of the file (at most 20). */
  readonly errors: readonly string[];
}

export type SummaryOutcome = { readonly ok: true; readonly summary: IfcSummary } | { readonly ok: false; readonly message: string };

const sortedRecord = (map: ReadonlyMap<string, number>): Record<string, number> =>
  Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Summarises the IFC text. @failure not a STEP file, no FILE_SCHEMA of the IFC family, no entity -> { ok: false } */
export function summariseIfc(text: string): SummaryOutcome {
  const file = readStep(text);
  if (file.entities.size === 0)
    return {
      ok: false,
      message: `no entity was read${file.errors[0] === undefined ? '' : ` (${file.errors[0]})`}: this is not an ISO 10303-21 file`,
    };
  if (!file.schema.toUpperCase().startsWith('IFC'))
    return { ok: false, message: `FILE_SCHEMA is "${file.schema}": only IFC2X3, IFC4 and IFC4X3 files are summarised` };
  const counts = new Map<string, number>();
  const predefined = new Map<string, number>();
  const members = new Map<number, number>();
  const tags = new Map<string, number>();
  const nested = new Set<number>();
  const pairs = new Set<string>();
  const connected = new Set<number>();
  let connections = 0;
  let ports = 0;
  const x3 = file.schema.toUpperCase().startsWith('IFC4');
  for (const entity of file.entities.values()) {
    const name = properName(entity.type);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (entity.type === 'IFCDISTRIBUTIONPORT') ports++;
    if (x3) {
      const index = predefinedIndex(entity);
      if (index >= 0) {
        const key = `${name}.${enumOf(entity.args[index]) ?? 'None'}`;
        predefined.set(key, (predefined.get(key) ?? 0) + 1);
      }
      if (isProduct(entity)) {
        const tag = stepString(entity.args[TAG_INDEX]);
        if (tag !== '') tags.set(tag, (tags.get(tag) ?? 0) + 1);
      }
    }
    if (entity.type === 'IFCRELASSIGNSTOGROUP') {
      const group = refsOf(entity.args[6])[0];
      if (group !== undefined) members.set(group, (members.get(group) ?? 0) + refsOf(entity.args[4]).length);
    } else if (entity.type === 'IFCRELNESTS') for (const id of refsOf(entity.args[5])) nested.add(id);
    else if (entity.type === 'IFCRELCONNECTSPORTS') {
      const a = refsOf(entity.args[4])[0];
      const b = refsOf(entity.args[5])[0];
      connections++;
      if (a !== undefined && b !== undefined) {
        pairs.add(a < b ? `${a}-${b}` : `${b}-${a}`);
        connected.add(a);
        connected.add(b);
      }
    }
  }
  const systems = [...file.entities.values()]
    .filter((entity) => typeChain(entity.type).includes('IFCSYSTEM'))
    .map(
      (entity): IfcSystemSummary => ({
        name: stepString(entity.args[2]),
        predefinedType: entity.type === 'IFCDISTRIBUTIONSYSTEM' ? enumOf(entity.args[6]) : null,
        members: members.get(entity.id) ?? 0,
        globalId: stepString(entity.args[0]),
      }),
    );
  const portIds = [...file.entities.values()].filter((entity) => entity.type === 'IFCDISTRIBUTIONPORT').map((entity) => entity.id);
  return {
    ok: true,
    summary: {
      schema: file.schema,
      entityCount: file.entities.size,
      counts: sortedRecord(counts),
      predefinedTypes: sortedRecord(predefined),
      systems,
      ports,
      portsNestedInElements: portIds.filter((id) => nested.has(id)).length,
      connections,
      physicalConnections: pairs.size,
      connectedPorts: portIds.filter((id) => connected.has(id)).length,
      openPorts: portIds.filter((id) => !connected.has(id)).length,
      duplicateTags: [...tags.entries()]
        .filter(([, n]) => n > 1)
        .map(([tag]) => tag)
        .sort(),
      errors: file.errors.slice(0, 20),
    },
  };
}
