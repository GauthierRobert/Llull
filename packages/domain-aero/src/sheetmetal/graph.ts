/** Read and edit helpers of the sheet-metal model (`CadDocument.sheetMetal`): lookups, node queries, immutable updates. */

import type { CadDocument } from '@core/model/types';
import type { SheetMetalModel, SheetMetalPart, SheetMetalRule, SheetNode } from '@core/model/sheetMetal';

export type FlatNode = Extract<SheetNode, { type: 'flat' }>;
export type BendNode = Extract<SheetNode, { type: 'bend' }>;
export type JoggleNode = Extract<SheetNode, { type: 'joggle' }>;
export type ReliefNode = Extract<SheetNode, { type: 'relief' }>;
export type FormNode = Extract<SheetNode, { type: 'form' }>;
export type HemNode = Extract<SheetNode, { type: 'hem' }>;

const EMPTY_MODEL: SheetMetalModel = { rules: {}, parts: {}, radiusTable: [] };

export const getModel = (doc: Pick<CadDocument, 'sheetMetal'>): SheetMetalModel => doc.sheetMetal ?? EMPTY_MODEL;

export const withModel = (doc: CadDocument, sheetMetal: SheetMetalModel): CadDocument => ({ ...doc, sheetMetal });

export const ruleOfPart = (model: SheetMetalModel, part: SheetMetalPart): SheetMetalRule | undefined => model.rules[part.rule];

export const flatsOf = (part: SheetMetalPart): FlatNode[] =>
  part.order.flatMap((id) => {
    const node = part.nodes[id];
    return node?.type === 'flat' ? [node] : [];
  });

export const bendsOf = (part: SheetMetalPart): BendNode[] =>
  part.order.flatMap((id) => {
    const node = part.nodes[id];
    return node?.type === 'bend' ? [node] : [];
  });

export const joggleNodes = (part: SheetMetalPart): JoggleNode[] =>
  part.order.flatMap((id) => {
    const node = part.nodes[id];
    return node?.type === 'joggle' ? [node] : [];
  });

export const reliefNodes = (part: SheetMetalPart): ReliefNode[] =>
  part.order.flatMap((id) => {
    const node = part.nodes[id];
    return node?.type === 'relief' ? [node] : [];
  });

export const formsOf = (part: SheetMetalPart): FormNode[] =>
  part.order.flatMap((id) => {
    const node = part.nodes[id];
    return node?.type === 'form' ? [node] : [];
  });

export const hemsOf = (part: SheetMetalPart): HemNode[] =>
  part.order.flatMap((id) => {
    const node = part.nodes[id];
    return node?.type === 'hem' ? [node] : [];
  });

export const flatOf = (part: SheetMetalPart, id: string): FlatNode | undefined => {
  const node = part.nodes[id];
  return node?.type === 'flat' ? node : undefined;
};

export const bendOf = (part: SheetMetalPart, id: string): BendNode | undefined => {
  const node = part.nodes[id];
  return node?.type === 'bend' ? node : undefined;
};

/** Bends whose parent is `flatId`, in creation order. */
export const childBends = (part: SheetMetalPart, flatId: string): BendNode[] => bendsOf(part).filter((bend) => bend.from === flatId);

/** The bend that leads into `flatId` (undefined for the root). */
export const parentBend = (part: SheetMetalPart, flatId: string): BendNode | undefined => bendsOf(part).find((bend) => bend.to === flatId);

type NodePrefix = 'f' | 'b' | 'j' | 'r' | 'c' | 'm' | 'h';

/** Next free node id with the given prefix (`f1`, `f2`, … / `b1` …). */
export function nextNodeId(part: SheetMetalPart, prefix: NodePrefix): string {
  let n = 1;
  while (part.nodes[`${prefix}${n}`] !== undefined) n += 1;
  return `${prefix}${n}`;
}

/** The next `count` free node ids with the given prefix. */
export function nextNodeIds(part: SheetMetalPart, prefix: NodePrefix, count: number): string[] {
  const ids: string[] = [];
  for (let n = 1; ids.length < count; n += 1) if (part.nodes[`${prefix}${n}`] === undefined) ids.push(`${prefix}${n}`);
  return ids;
}

/** Part with `nodes` merged in (insertion appended to `order`, replacement keeps its place). */
export function withNodes(part: SheetMetalPart, nodes: readonly SheetNode[]): SheetMetalPart {
  const merged: Record<string, SheetNode> = { ...part.nodes };
  const order = [...part.order];
  for (const node of nodes) {
    if (merged[node.id] === undefined) order.push(node.id);
    merged[node.id] = node;
  }
  return { ...part, nodes: merged, order };
}

export const withPart = (model: SheetMetalModel, part: SheetMetalPart): SheetMetalModel => ({
  ...model,
  parts: { ...model.parts, [part.id]: part },
});
