/** `set_hot_modulus`: the operating cases of a stress model use E(T) of a document material instead of the single stated E (07 PST §5.2). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { isRefused, resolvePropertyModel } from '@core/model/propertyModelEval';
import { refuse } from '../codes';
import { edited, withModel } from '../model/store';
import { isRefusal, modelOr } from './common';

/**
 * @affects plant.stress.models[modelId].hotModulus: set or cleared; recorded results turn stale by hash and the approval is dropped
 * @invariant only OPE cases with a T primitive use E at their largest temperature (SUS, OCC, HYD and the stated-E frame are unchanged); data comes from the `E` property model of the material (never invented, never extrapolated); every such analysis carries a PST_HOT_MODULUS warning
 * @failure unknown model -> PST_MODEL_NOT_FOUND; unknown material -> PST_MATERIAL_NOT_FOUND; material without an E model -> PST_MATERIAL_NO_DATA; an OPE temperature outside the E table -> PST_TEMPERATURE_OUT_OF_TABLE when analysing
 */
export const setHotModulus = defineCommand({
  name: 'set_hot_modulus',
  description:
    'Use the temperature-dependent Young modulus E(T) in the OPERATING cases of a stress model. By default one stated E (youngsModulusMPa, the installation-temperature value) is used in every case, the B31.3 practice for displacement stress ranges. ' +
    'With materialId set, each OPE load case that has a temperature primitive (T1..T9) is solved with E read at the largest of its temperatures from the `E` property model of that document material (import_pipe_material_data with EGPa rows creates it); SUS, OCC and HYD cases keep the stated E. ' +
    'Outside the table range the analysis is refused (PST_TEMPERATURE_OUT_OF_TABLE, never extrapolated); table values stay unverified. An EXP case OPE - SUS then mixes the two moduli: every analysis reports PST_HOT_MODULUS. Omit materialId to clear the setting. Returns data { modelId, materialId }.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    materialId: z
      .string()
      .min(1)
      .describe('Document material (name) whose E property model gives E(T) in degC. Omit to return to the single stated E.')
      .optional(),
  }),
  run: (doc, { modelId, materialId }): CommandResult => {
    const model = modelOr(doc, 'set_hot_modulus', modelId);
    if (isRefusal(model)) return model;
    if (materialId === undefined) {
      const { hotModulus, ...rest } = model;
      void hotModulus;
      return {
        ...changed(withModel(doc, edited(rest as typeof model, {})), `set_hot_modulus: ${model.id} back to the stated E.`, [model.id]),
        data: { modelId: model.id },
      };
    }
    const material = doc.materials !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
    if (material === undefined)
      return refuse(doc, 'set_hot_modulus', 'PST_MATERIAL_NOT_FOUND', `no document material "${materialId}"`, [materialId], ['materialId']);
    const found = resolvePropertyModel(
      { name: materialId, ...(material.propertyModels === undefined ? {} : { propertyModels: material.propertyModels }) },
      { property: 'E' },
    );
    if (isRefused(found))
      return refuse(
        doc,
        'set_hot_modulus',
        'PST_MATERIAL_NO_DATA',
        `${materialId} has no usable E model (${found.code})`,
        [materialId],
        ['materialId'],
      );
    return {
      ...changed(
        withModel(doc, edited(model, { hotModulus: { materialId } })),
        `set_hot_modulus: ${model.id} operating cases use E(T) of ${materialId} (model ${found.id}).`,
        [model.id],
      ),
      data: { modelId: model.id, materialId },
    };
  },
});
