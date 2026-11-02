/** Access to `doc.plant.stress` (the pipe stress models of the document). */

import type { CadDocument } from '@core/model/types';
import type { StressModel, StressSlice } from './schema';

export const EMPTY_STRESS: StressSlice = { models: {}, modelOrder: [] };

export const getStress = (doc: Pick<CadDocument, 'plant'>): StressSlice => doc.plant?.stress ?? EMPTY_STRESS;

export const withStress = (doc: CadDocument, stress: StressSlice): CadDocument => ({ ...doc, plant: { ...doc.plant, stress } });

/** The model `id`, own keys only (ids are user data). */
export const findModel = (doc: Pick<CadDocument, 'plant'>, id: string): StressModel | undefined => {
  const models = getStress(doc).models;
  return Object.hasOwn(models, id) ? models[id] : undefined;
};

/** `doc` with `model` replacing the model of the same id (appended when new). */
export function withModel(doc: CadDocument, model: StressModel): CadDocument {
  const stress = getStress(doc);
  const known = Object.hasOwn(stress.models, model.id);
  return withStress(doc, {
    models: { ...stress.models, [model.id]: model },
    modelOrder: known ? stress.modelOrder : [...stress.modelOrder, model.id],
  });
}

/** An edit of a stored model: the recorded results stay (they turn stale by hash) and the approval is dropped, as an approval covers one fixed set of results. */
export function edited(model: StressModel, patch: Partial<StressModel>): StressModel {
  const { approval, ...rest } = model;
  void approval;
  return { ...rest, ...patch };
}
