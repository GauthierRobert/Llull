/** Read/replace helpers for the durability slice (`doc.analysis.durability`); pure, every write returns a new document. */

import type { Crack, CrackGrowthCase, DurabilityModel, FatigueCase, LoadHistory } from '@core/model/durability';
import type { CadDocument } from '@core/model/types';
import { analysisOf } from '../shared/access';

const EMPTY: DurabilityModel = {
  histories: {},
  historyOrder: [],
  fatigueCases: {},
  fatigueCaseOrder: [],
  cracks: {},
  crackOrder: [],
  crackGrowthCases: {},
  crackGrowthCaseOrder: [],
};

export const durabilityOf = (doc: CadDocument): DurabilityModel => doc.analysis?.durability ?? EMPTY;

function withDurability(doc: CadDocument, durability: DurabilityModel): CadDocument {
  return { ...doc, analysis: { ...analysisOf(doc), durability } };
}

const pick = <T>(bag: Readonly<Record<string, T>>, id: string): T | undefined => (Object.hasOwn(bag, id) ? bag[id] : undefined);
const without = <T>(bag: Readonly<Record<string, T>>, id: string): Record<string, T> =>
  Object.fromEntries(Object.entries(bag).filter(([key]) => key !== id));

export const historyOf = (doc: CadDocument, id: string): LoadHistory | undefined => pick(durabilityOf(doc).histories, id);
export const fatigueCaseOf = (doc: CadDocument, id: string): FatigueCase | undefined => pick(durabilityOf(doc).fatigueCases, id);
export const crackOf = (doc: CadDocument, id: string): Crack | undefined => pick(durabilityOf(doc).cracks, id);
export const growthCaseOf = (doc: CadDocument, id: string): CrackGrowthCase | undefined => pick(durabilityOf(doc).crackGrowthCases, id);

export function withHistory(doc: CadDocument, history: LoadHistory): CadDocument {
  const d = durabilityOf(doc);
  const order = d.historyOrder.includes(history.id) ? d.historyOrder : [...d.historyOrder, history.id];
  return withDurability(doc, { ...d, histories: { ...d.histories, [history.id]: history }, historyOrder: order });
}

export function withoutHistory(doc: CadDocument, id: string): CadDocument {
  const d = durabilityOf(doc);
  return withDurability(doc, { ...d, histories: without(d.histories, id), historyOrder: d.historyOrder.filter((key) => key !== id) });
}

export function withFatigueCase(doc: CadDocument, fatigueCase: FatigueCase): CadDocument {
  const d = durabilityOf(doc);
  const order = d.fatigueCaseOrder.includes(fatigueCase.id) ? d.fatigueCaseOrder : [...d.fatigueCaseOrder, fatigueCase.id];
  return withDurability(doc, { ...d, fatigueCases: { ...d.fatigueCases, [fatigueCase.id]: fatigueCase }, fatigueCaseOrder: order });
}

export function withoutFatigueCase(doc: CadDocument, id: string): CadDocument {
  const d = durabilityOf(doc);
  return withDurability(doc, {
    ...d,
    fatigueCases: without(d.fatigueCases, id),
    fatigueCaseOrder: d.fatigueCaseOrder.filter((key) => key !== id),
  });
}

export function withCrack(doc: CadDocument, crack: Crack): CadDocument {
  const d = durabilityOf(doc);
  const order = d.crackOrder.includes(crack.id) ? d.crackOrder : [...d.crackOrder, crack.id];
  return withDurability(doc, { ...d, cracks: { ...d.cracks, [crack.id]: crack }, crackOrder: order });
}

export function withoutCrack(doc: CadDocument, id: string): CadDocument {
  const d = durabilityOf(doc);
  return withDurability(doc, { ...d, cracks: without(d.cracks, id), crackOrder: d.crackOrder.filter((key) => key !== id) });
}

export function withGrowthCase(doc: CadDocument, growthCase: CrackGrowthCase): CadDocument {
  const d = durabilityOf(doc);
  const order = d.crackGrowthCaseOrder.includes(growthCase.id) ? d.crackGrowthCaseOrder : [...d.crackGrowthCaseOrder, growthCase.id];
  return withDurability(doc, {
    ...d,
    crackGrowthCases: { ...d.crackGrowthCases, [growthCase.id]: growthCase },
    crackGrowthCaseOrder: order,
  });
}

export function withoutGrowthCase(doc: CadDocument, id: string): CadDocument {
  const d = durabilityOf(doc);
  return withDurability(doc, {
    ...d,
    crackGrowthCases: without(d.crackGrowthCases, id),
    crackGrowthCaseOrder: d.crackGrowthCaseOrder.filter((key) => key !== id),
  });
}
