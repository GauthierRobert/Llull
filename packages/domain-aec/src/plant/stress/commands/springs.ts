/** `import_spring_table`, `select_spring_hangers`, `delete_spring_hanger` (07 PST M5b, TR-PST-08, FR-PST-13, VC-PST-14). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { elementsOf, getBuilding } from '../../../building/model';
import { analyzeStressModel } from '../analysis';
import { DEFAULT_MAX_VARIABILITY, pickSpring } from '../code/springs';
import { refuse } from '../codes';
import { springSizeSchema, type SpringSelection, type SpringTable, type StressModel } from '../model/schema';
import { edited, withModel } from '../model/store';
import { hangerLoads, sameLocation } from '../solve/springDesign';
import { isRefusal, modelOr } from './common';

const at = z
  .union([
    z.object({ supportId: z.string().min(1).describe('Id of a pipe support (normally a hanger) on a pipe of the model.') }),
    z.object({
      pipeId: z.string().min(1).describe('Pipe or run id in the model.'),
      atMm: z.number().min(0).describe('Arc length from the pipe start, mm.'),
    }),
  ])
  .describe('Where the hanger acts: {supportId} or {pipeId, atMm}.');

const RESIDUAL_WARN_PCT = 1;
const MAX_SIZES = 2000;
const MAX_TABLES = 50;

/**
 * @affects plant.stress.models[modelId].springTables: one table added or the one with the same tableId replaced; the approval is dropped
 * @failure unknown model -> PST_MODEL_NOT_FOUND; a size whose load range is empty or a duplicate (size, series) -> PST_TABLE_INVALID
 */
export const importSpringTable = defineCommand({
  name: 'import_spring_table',
  description:
    'Store a vendor variable-spring table in a stress model, for select_spring_hangers. Each size has a series (spring type), the working load range minN..maxN in N, the spring rate in N per mm and the working travel in mm. ' +
    'The values are the vendor data you read from the catalogue (they are never supplied by llull); `source` names the catalogue and edition and is recorded. A table with the same tableId is replaced. Returns data { modelId, tableId, sizes }.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    tableId: z.string().min(1).describe('Name of the table, e.g. "vendorX-B-series"; select_spring_hangers refers to it.'),
    source: z.string().min(3).describe('Catalogue, edition and page the values come from.'),
    sizes: z.array(springSizeSchema).min(1).describe('Spring sizes: size, series, load range minN..maxN (N), rate (N/mm), travel (mm).'),
  }),
  run: (doc, params): CommandResult => {
    const model = modelOr(doc, 'import_spring_table', params.modelId);
    if (isRefusal(model)) return model;
    if (params.sizes.length > MAX_SIZES || model.springTables.length >= MAX_TABLES)
      return refuse(
        doc,
        'import_spring_table',
        'PST_TABLE_INVALID',
        `at most ${MAX_SIZES} sizes per table and ${MAX_TABLES} tables per model`,
        [params.tableId],
        ['sizes'],
      );
    const keys = new Set<string>();
    for (const [index, size] of params.sizes.entries()) {
      const key = `${size.series}/${size.size}`;
      const problem = keys.has(key)
        ? `duplicate size ${key}`
        : !(size.minN < size.maxN)
          ? `size ${key}: minN ${size.minN} N must be below maxN ${size.maxN} N`
          : null;
      keys.add(key);
      if (problem !== null) return refuse(doc, 'import_spring_table', 'PST_TABLE_INVALID', problem, [params.tableId], [`sizes.${index}`]);
    }
    const table: SpringTable = { id: params.tableId, source: params.source, sizes: params.sizes };
    const known = model.springTables.some((entry) => entry.id === table.id);
    const springTables = known
      ? model.springTables.map((entry) => (entry.id === table.id ? table : entry))
      : [...model.springTables, table];
    return {
      ...changed(
        withModel(doc, edited(model, { springTables })),
        `import_spring_table: ${table.id} (${table.sizes.length} size(s), source: ${table.source}) ${known ? 'replaced' : 'stored'} on model ${model.id}.`,
        [model.id],
      ),
      data: { modelId: model.id, tableId: table.id, sizes: table.sizes.length },
    };
  },
});

/**
 * @affects plant.stress.models[modelId].springs: one selection per hanger point (replacing the one at the same place); the support's rigid rest is replaced by the spring; the approval is dropped
 * @invariant 1 restrained-weight solve (hanger points rigid in Z) gives the hot load, 2 operating solve with the hangers as their hot load as an upward force gives the travel d (up positive), 3 smallest size of the table whose range holds the load and the travel with V = |k d| / P_hot within the limit, 4 the model is re-analysed with the springs as preloaded linear springs (P_cold = P_hot + k d) and the operating load error is reported
 * @failure unknown model / table -> PST_MODEL_NOT_FOUND / PST_SPRING_TABLE_MISSING; no conditions / OPE case -> PST_CONDITIONS_MISSING / PST_LOADCASE_INVALID; no size covers the load and travel -> PST_SPRING_NO_SIZE; sizes cover but all vary too much -> PST_SPRING_VARIABILITY (both only without the constant-effort fallback); support or pipe outside the model -> PST_SUPPORT_NOT_FOUND / PST_POINT_OFF_PIPE
 */
export const selectSpringHangers = defineCommand({
  name: 'select_spring_hangers',
  description:
    'Select variable spring hangers for hanger points of a stress model (needs conditions, an OPE case that includes the weight W, and a table from import_spring_table). Steps: the hanger points are held rigid in Z under the weight W to get each hot load P_hot; ' +
    'the operating case is solved with every hanger carrying its P_hot as an upward force to get the vertical travel d (up positive); the smallest table size whose load range holds P_hot and whose travel holds |d| is chosen with cold load P_cold = P_hot + k d and variability V = |k d| / P_hot within maxVariability ' +
    '(default 0.25, grade B; use 0.15 near rotating equipment). When no variable size fits and constantEffortFallback is true (default) a constant-effort hanger of load P_hot is stored instead and listed in the warnings; with false the refusal is PST_SPRING_NO_SIZE (no size covers load and travel) or PST_SPRING_VARIABILITY. ' +
    'The selection replaces the rigid rest of a hanger support at that place: afterwards the analysis treats it as a linear spring (rate k) with preload P_cold, and the result reports the operating load of each spring against P_hot (residualPct; above 1 percent the warning PST_SPRING_LOAD_DEVIATION). ' +
    'Loads N, rates N/mm, travel mm. Returns data { modelId, operatingCase, springs[{ id, kind, size, series, rateNPerMm, hotLoadN, coldLoadN, travelUpMm, variability, operatingLoadN, residualPct }], warnings, defaulted }.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    hangers: z.array(at).min(1).max(200).describe('The hanger points to design, each {supportId} or {pipeId, atMm}.'),
    tableId: z.string().min(1).describe('Spring table of the model (import_spring_table).'),
    maxVariability: z
      .number()
      .positive()
      .max(1)
      .describe('Largest variability V (fraction). Default 0.25; 0.15 near rotating equipment.')
      .optional(),
    constantEffortFallback: z
      .boolean()
      .describe('When no variable size fits, store a constant-effort hanger (load P_hot) instead of refusing. Default true.')
      .optional(),
    operatingCase: z.string().min(1).describe('Name of the OPE load case that gives the travel. Default: the first OPE case.').optional(),
  }),
  run: (doc, params): CommandResult => {
    const model = modelOr(doc, 'select_spring_hangers', params.modelId);
    if (isRefusal(model)) return model;
    const fail = (code: string, message: string, ids: readonly string[], paths: readonly string[]): CommandResult =>
      refuse(doc, 'select_spring_hangers', code, message, ids, paths);
    const table = model.springTables.find((entry) => entry.id === params.tableId);
    if (table === undefined)
      return fail(
        'PST_SPRING_TABLE_MISSING',
        `model ${model.id} has no spring table "${params.tableId}" (tables: ${model.springTables.map((entry) => entry.id).join(', ') || 'none'}); import_spring_table first`,
        [params.tableId],
        ['tableId'],
      );
    if (model.conditions === undefined)
      return fail('PST_CONDITIONS_MISSING', `model ${model.id} has no operating conditions`, [model.id], ['conditions']);
    for (const [index, place] of params.hangers.entries()) {
      if ('supportId' in place) {
        const support = elementsOf(getBuilding(doc), 'pipeSupport').find((candidate) => candidate.id === place.supportId);
        if (support === undefined || !model.scope.ids.includes(support.pipeId))
          return fail(
            'PST_SUPPORT_NOT_FOUND',
            `no pipe support ${place.supportId} on the pipes of model ${model.id}`,
            [place.supportId],
            [`hangers.${index}`],
          );
      } else if (!model.scope.ids.includes(place.pipeId))
        return fail('PST_POINT_OFF_PIPE', `pipe ${place.pipeId} is not in model ${model.id}`, [place.pipeId], [`hangers.${index}`]);
      if (params.hangers.slice(0, index).some((earlier) => sameLocation(earlier, place)))
        return fail('PST_PARAM_INVALID', `hanger ${index} repeats an earlier hanger point`, [model.id], [`hangers.${index}`]);
    }
    const limit = params.maxVariability ?? DEFAULT_MAX_VARIABILITY;
    const fallback = params.constantEffortFallback ?? true;
    const defaulted = [
      ...(params.maxVariability === undefined ? [`maxVariability=${DEFAULT_MAX_VARIABILITY}`] : []),
      ...(params.constantEffortFallback === undefined ? ['constantEffortFallback=true'] : []),
    ];
    const targets = params.hangers.map((place) => ({
      id: model.springs.find((spring) => sameLocation(spring.at, place))?.id ?? nextId('spring'),
      at: place,
    }));
    const design = hangerLoads(doc, model, model.conditions, targets, params.operatingCase);
    if (!design.ok) return fail(design.code, design.message, design.ids, design.paths);
    const selections: SpringSelection[] = [];
    const warnings: { code: string; message: string; ids: string[] }[] = [];
    for (const load of design.loads) {
      const target = targets.find((entry) => entry.id === load.id) as (typeof targets)[number];
      const choice = pickSpring(table.sizes, load.hotLoadN, load.travelUpMm, limit);
      if (choice.kind === 'size')
        selections.push({
          id: load.id,
          at: target.at,
          kind: 'variable',
          tableId: table.id,
          size: choice.size.size,
          series: choice.size.series,
          rateNPerMm: choice.size.rateNPerMm,
          hotLoadN: load.hotLoadN,
          coldLoadN: choice.coldLoadN,
          travelUpMm: load.travelUpMm,
          variability: choice.variability,
        });
      else if (fallback) {
        selections.push({
          id: load.id,
          at: target.at,
          kind: 'constant',
          rateNPerMm: 0,
          hotLoadN: load.hotLoadN,
          coldLoadN: load.hotLoadN,
          travelUpMm: load.travelUpMm,
          variability: 0,
        });
        warnings.push({
          code: 'PST_SPRING_CONSTANT_EFFORT',
          message: `hanger ${load.id}: no variable size of ${table.id} fits P_hot ${load.hotLoadN.toFixed(1)} N and travel ${load.travelUpMm.toFixed(2)} mm (${choice.reason}); a constant-effort hanger is stored`,
          ids: [load.id],
        });
      } else
        return choice.reason === 'no-size'
          ? fail(
              'PST_SPRING_NO_SIZE',
              `no size of ${table.id} holds P_hot ${load.hotLoadN.toFixed(1)} N and travel ${load.travelUpMm.toFixed(2)} mm for hanger ${load.id}`,
              [load.id],
              ['tableId'],
            )
          : fail(
              'PST_SPRING_VARIABILITY',
              `hanger ${load.id}: the sizes that hold P_hot ${load.hotLoadN.toFixed(1)} N and travel ${load.travelUpMm.toFixed(2)} mm vary by at least ${((choice.lowestVariability ?? 0) * 100).toFixed(1)} % (limit ${limit * 100} %)`,
              [load.id],
              ['maxVariability'],
            );
    }
    const next: StressModel = edited(model, {
      springs: [...model.springs.filter((spring) => !targets.some((target) => sameLocation(target.at, spring.at))), ...selections],
    });
    const nextDoc = withModel(doc, next);
    const analysis = analyzeStressModel(nextDoc, next);
    if (!analysis.ok) return fail(analysis.code, `with the springs: ${analysis.message}`, analysis.ids, analysis.paths);
    const state = analysis.states.find((entry) => entry.name === design.operatingCase);
    const springs = selections.map((spring) => {
      const node = (analysis.built.springs.find((entry) => entry.id === spring.id) as { node: number }).node;
      const operatingLoadN = state === undefined ? Number.NaN : (state.reactions[node * 6 + 2] as number);
      const residualPct = ((operatingLoadN - spring.hotLoadN) / spring.hotLoadN) * 100;
      if (Math.abs(residualPct) > RESIDUAL_WARN_PCT)
        warnings.push({
          code: 'PST_SPRING_LOAD_DEVIATION',
          message: `spring ${spring.id}: operating load ${operatingLoadN.toFixed(1)} N differs from the hot load ${spring.hotLoadN.toFixed(1)} N by ${residualPct.toFixed(2)} % (target 1 %)`,
          ids: [spring.id],
        });
      return { ...spring, operatingLoadN, residualPct };
    });
    return {
      ...changed(
        withModel(doc, next),
        `select_spring_hangers: ${springs.map((spring) => `${spring.id} ${spring.kind === 'variable' ? `${spring.series}/${spring.size} k ${spring.rateNPerMm} N/mm, cold ${spring.coldLoadN.toFixed(0)} N, V ${spring.variability.toFixed(3)}` : 'constant-effort'} (hot ${spring.hotLoadN.toFixed(0)} N, d ${spring.travelUpMm.toFixed(2)} mm, operating error ${spring.residualPct.toFixed(2)} %)`).join('; ')}${warnings.length > 0 ? `; warnings ${[...new Set(warnings.map((warning) => warning.code))].join(', ')}` : ''}${defaulted.length > 0 ? `; defaulted ${defaulted.join(', ')}` : ''}.`,
        [model.id, ...selections.map((spring) => spring.id)],
      ),
      data: { modelId: model.id, operatingCase: design.operatingCase, springs, warnings, defaulted, reviewRequired: true, grade: 'B' },
    };
  },
});

/**
 * @affects plant.stress.models[modelId].springs: the selection removed (the support acts as modelled again); the approval is dropped
 * @failure unknown model -> PST_MODEL_NOT_FOUND; unknown spring -> PST_SPRING_NOT_FOUND
 */
export const deleteSpringHanger = defineCommand({
  name: 'delete_spring_hanger',
  description:
    'Remove a spring hanger selection (select_spring_hangers) from a stress model: the support at that place acts as it was modelled before (a hanger is a rigid one-way rest again). Returns data { modelId, springId }.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    springId: z.string().min(1).describe('Id of the spring selection (data.springs[].id of select_spring_hangers).'),
  }),
  run: (doc, { modelId, springId }): CommandResult => {
    const model = modelOr(doc, 'delete_spring_hanger', modelId);
    if (isRefusal(model)) return model;
    if (!model.springs.some((entry) => entry.id === springId))
      return refuse(
        doc,
        'delete_spring_hanger',
        'PST_SPRING_NOT_FOUND',
        `model ${modelId} has no spring ${springId}`,
        [springId],
        ['springId'],
      );
    return {
      ...changed(
        withModel(doc, edited(model, { springs: model.springs.filter((entry) => entry.id !== springId) })),
        `delete_spring_hanger: ${springId} removed from ${modelId}.`,
        [modelId],
      ),
      data: { modelId, springId },
    };
  },
});
