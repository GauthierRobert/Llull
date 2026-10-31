/**
 * Sheet split of an isometric (plant 05 ISO §5.10, TR-ISO-12): the components of a line are assigned to sheets so that a sheet carries at most `maxPipePiecesPerSheet`
 * PIPE pieces, a cut lies only at a weld joint (or, with splitAt flange, a bolted joint), never inside a component, and every sheet stays connected. Stability on re-issue:
 * a component with a stored sheet keeps it, a new component takes the sheet of its upstream neighbour, and a sheet that overflows through new components spills them to a
 * new sheet appended at the end. The spool style assigns one sheet per spool. Every joint whose components lie on different sheets is a continuation. Pure, deterministic.
 */

import type { Vec3 } from '@core/model/vectors';
import type { LineAnalysis } from '../analysis';
import { isoIssue } from '../codes';
import { isWeldJoint, nodeKey, type JointClass, type JointNode } from '../joints';
import type { IsoDefinition, IsoIssue } from '../model';

export type SheetMode =
  | {
      readonly kind: 'budget';
      readonly budget?: number;
      readonly splitAt: 'weld' | 'flange';
      readonly stored?: Readonly<Record<string, number>>;
    }
  | { readonly kind: 'spool' };

export interface SheetInfo {
  /** 1-based, consecutive. */
  readonly index: number;
  /** Indices into `network.components`. */
  readonly indices: readonly number[];
  readonly componentIds: readonly string[];
  readonly pipes: number;
  readonly spool?: string;
}

/** A joint whose components lie on two sheets: printed on both with "CONT. ON / FROM SHEET n - W<number>". */
export interface SheetJoint {
  readonly key: string;
  readonly xyz: Vec3;
  /** Stored or provisional weld number; null for a bolted or other joint. */
  readonly weld: string | null;
  readonly joint: JointClass;
  readonly fromSheet: number;
  readonly toSheet: number;
  readonly componentIds: readonly string[];
}

export interface SheetPlan {
  readonly sheets: readonly SheetInfo[];
  /** Component id -> sheet, every component of the line. */
  readonly assignment: Readonly<Record<string, number>>;
  readonly crossings: readonly SheetJoint[];
  readonly warnings: readonly IsoIssue[];
}

export interface ContinuationMark {
  /** The other sheet. */
  readonly sheet: number;
  readonly weld: string | null;
  readonly joint: JointClass;
  readonly at: Vec3;
  readonly key: string;
  readonly componentIds: readonly string[];
}

export function planSheets(analysis: LineAnalysis, mode: SheetMode): SheetPlan {
  const components = analysis.read.network.components;
  const memberList = analysis.graph.members;
  const jointsOf = new Map<number, JointNode[]>();
  for (const joint of analysis.graph.joints)
    for (const member of joint.members) jointsOf.set(member, [...(jointsOf.get(member) ?? []), joint]);
  const classOf = (joint: JointNode): JointClass => analysis.classes.get(joint.key) ?? joint.joint;
  const earlier = (index: number): number[] => [
    ...new Set((jointsOf.get(index) ?? []).flatMap((joint) => joint.members.filter((other) => other < index))),
  ];
  const sheetOf: number[] = components.map(() => 0);
  const isPipe = (index: number): boolean => components[index]?.type === 'PIPE';

  if (mode.kind === 'spool') for (const index of memberList) sheetOf[index] = (analysis.spools.spoolOf.get(index) ?? 0) + 1;
  else {
    const stored = mode.stored ?? {};
    const storedIndices = new Set(memberList.filter((index) => stored[components[index]?.id ?? ''] !== undefined));
    const lastStored = new Map<number, number>();
    for (const index of storedIndices) {
      const sheet = stored[components[index]?.id ?? ''] as number;
      lastStored.set(sheet, Math.max(lastStored.get(sheet) ?? -1, index));
    }
    const sequence = new Map<number, number[]>();
    const pipes = new Map<number, number>();
    let count = 1;
    const place = (index: number, sheet: number): void => {
      sheetOf[index] = sheet;
      sequence.set(sheet, [...(sequence.get(sheet) ?? []), index]);
      if (isPipe(index)) pipes.set(sheet, (pipes.get(sheet) ?? 0) + 1);
    };
    const allowed = (joint: JointNode): boolean => (mode.splitAt === 'weld' ? isWeldJoint(classOf(joint)) : classOf(joint) === 'bolted');
    const valid = (moved: readonly number[], last: number): boolean => {
      const inside = new Set(moved);
      const connected = moved.every((member, at) => at === 0 || earlier(member).some((other) => inside.has(other)));
      if (!connected) return false;
      return moved.every((member) =>
        (jointsOf.get(member) ?? []).every((joint) => allowed(joint) || joint.members.every((other) => other > last || inside.has(other))),
      );
    };
    const tryBreak = (index: number): void => {
      const sheet = sheetOf[index] as number;
      if ((lastStored.get(sheet) ?? -1) > index) return;
      const list = sequence.get(sheet) ?? [];
      for (let from = list.length - 1; from >= 1; from--) {
        const moved = list.slice(from);
        if (moved.some((member) => storedIndices.has(member))) return;
        if (!valid(moved, index)) continue;
        count += 1;
        sequence.set(sheet, list.slice(0, from));
        for (const member of moved) {
          sheetOf[member] = 0;
          if (isPipe(member)) pipes.set(sheet, (pipes.get(sheet) ?? 1) - 1);
          place(member, count);
        }
        return;
      }
    };
    for (const index of memberList) {
      const given = stored[components[index]?.id ?? ''];
      const parent = Math.max(-1, ...earlier(index));
      const sheet = given ?? (parent < 0 ? 1 : (sheetOf[parent] as number));
      count = Math.max(count, sheet);
      place(index, sheet);
      if (given === undefined && mode.budget !== undefined && isPipe(index) && (pipes.get(sheet) ?? 0) > mode.budget) tryBreak(index);
    }
  }

  components.forEach((component, index) => {
    if (sheetOf[index] !== 0) return;
    const first = component.ends[0];
    const joint = first === undefined ? undefined : analysis.graph.byKey.get(nodeKey(first.xyz));
    const owner = joint?.members.map((member) => sheetOf[member] ?? 0).find((sheet) => sheet > 0);
    sheetOf[index] = owner ?? (index > 0 ? (sheetOf[index - 1] as number) : 0) ?? 1;
    if (sheetOf[index] === 0) sheetOf[index] = 1;
  });

  const used = [...new Set(sheetOf)].sort((a, b) => a - b);
  const renumber = new Map(used.map((sheet, at) => [sheet, at + 1]));
  const final = sheetOf.map((sheet) => renumber.get(sheet) ?? 1);
  const assignment = Object.fromEntries(components.map((component, index) => [component.id, final[index] as number]));
  const sheets: SheetInfo[] = used.map((_sheet, at) => {
    const indices = components.flatMap((_component, index) => (final[index] === at + 1 ? [index] : []));
    const spool = mode.kind === 'spool' ? analysis.spools.spools[(used[at] as number) - 1]?.name : undefined;
    return {
      index: at + 1,
      indices,
      componentIds: indices.map((index) => components[index]?.id ?? ''),
      pipes: indices.filter(isPipe).length,
      ...(spool === undefined ? {} : { spool }),
    };
  });

  const numbers = new Map(analysis.numbering.entries.map((entry) => [entry.joint.key, entry.record.number]));
  const crossings: SheetJoint[] = [];
  for (const joint of analysis.graph.joints) {
    const onSheets = [...new Set(joint.members.map((member) => final[member] as number))].sort((a, b) => a - b);
    const low = onSheets[0] as number;
    for (const other of onSheets.slice(1))
      crossings.push({
        key: joint.key,
        xyz: joint.xyz,
        weld: numbers.get(joint.key) ?? null,
        joint: classOf(joint),
        fromSheet: low,
        toSheet: other,
        componentIds: joint.members.map((member) => components[member]?.id ?? ''),
      });
  }
  const warnings: IsoIssue[] = [];
  if (mode.kind === 'budget' && mode.budget !== undefined) {
    const over = sheets.filter((sheet) => sheet.pipes > (mode.budget as number));
    if (over.length > 0)
      warnings.push(
        isoIssue(
          'ISO_SHEET_OVERFLOW',
          'warning',
          `sheet(s) ${over.map((sheet) => `${sheet.index} (${sheet.pipes} pipe pieces)`).join(', ')} exceed ${mode.budget} pipe pieces: no ${mode.splitAt} joint allows a cut`,
          [analysis.lineId],
        ),
      );
  }
  return { sheets, assignment, crossings, warnings };
}

/** The continuation marks of sheet `index`: previous = to a lower sheet, next = to a higher one (the first of each, with `all` in full). */
export function continuationOf(
  plan: SheetPlan,
  index: number,
): { readonly previous?: ContinuationMark; readonly next?: ContinuationMark; readonly all: readonly ContinuationMark[] } {
  const mark = (crossing: SheetJoint, other: number): ContinuationMark => ({
    sheet: other,
    weld: crossing.weld,
    joint: crossing.joint,
    at: crossing.xyz,
    key: crossing.key,
    componentIds: crossing.componentIds,
  });
  const all = plan.crossings
    .flatMap((crossing) =>
      crossing.fromSheet === index
        ? [mark(crossing, crossing.toSheet)]
        : crossing.toSheet === index
          ? [mark(crossing, crossing.fromSheet)]
          : [],
    )
    .sort((a, b) => a.sheet - b.sheet || a.key.localeCompare(b.key));
  const previous = all.find((entry) => entry.sheet < index);
  const next = all.find((entry) => entry.sheet > index);
  return { ...(previous === undefined ? {} : { previous }), ...(next === undefined ? {} : { next }), all };
}

/** The sheet plan a stored definition gives for a line (its stored assignment keeps a re-issue stable), or null when the line has no definition. */
export function definedPlan(analysis: LineAnalysis, definition: IsoDefinition | undefined): SheetPlan | null {
  if (definition === undefined) return null;
  return planSheets(
    analysis,
    definition.style === 'spool'
      ? { kind: 'spool' }
      : {
          kind: 'budget',
          splitAt: definition.splitAt,
          stored: definition.sheetAssignment,
          ...(definition.maxPipePiecesPerSheet === undefined ? {} : { budget: definition.maxPipePiecesPerSheet }),
        },
  );
}
