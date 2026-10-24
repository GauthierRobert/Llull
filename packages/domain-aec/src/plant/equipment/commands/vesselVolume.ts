import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { toMetres } from '@core/model/units';
import { getBuilding } from '../../../building/model';
import { horizontalVolume, verticalHeight, verticalVolume } from '../geometry/partialVolume';
import { headVolume, resolveHead, type HeadRefusal, type ResolvedHead } from '../geometry/heads';
import { headSpecSchema, refuse, type HeadSpec } from '../model';
import type { VesselDesignData } from '../plantData';
import { equipmentRefParam, findEquipment } from './equipmentRef';

const isRefusal = (value: ResolvedHead | HeadRefusal): value is HeadRefusal => 'error' in value;

const volumeParams = z.object({
  equipment: equipmentRefParam.optional().describe('Tag or id of a vessel. Replaces the inline description below.'),
  orientation: z
    .enum(['vertical', 'horizontal'])
    .optional()
    .describe('Inline form: axis of the cylinder, vertical (heads bottom / top) or horizontal (heads left / right).'),
  insideDiameter: z.number().positive().optional().describe('Inline form: inside diameter of the cylinder, document units.'),
  tangentLength: z
    .number()
    .positive()
    .optional()
    .describe('Inline form: tangent-to-tangent length of the cylindrical part, document units (heads excluded).'),
  heads: z
    .object({
      first: headSpecSchema.describe('Bottom head (vertical) or left head (horizontal).'),
      second: headSpecSchema.describe('Top head (vertical) or right head (horizontal).'),
    })
    .optional()
    .describe('Inline form: the two formed heads.'),
  levels: z
    .array(z.number().min(0))
    .max(200)
    .optional()
    .describe('Liquid levels from the lowest inside point, document units, each in 0..insideHeight. Omit for the total volume only.'),
});

type VolumeParams = z.infer<typeof volumeParams>;

interface Geometry {
  readonly orientation: 'vertical' | 'horizontal';
  readonly insideDiameter: number;
  readonly tangentLength: number;
  readonly first: HeadSpec;
  readonly second: HeadSpec;
}

type Source = { readonly geometry: Geometry; readonly liquid?: VesselDesignData['operatingLiquid'] } | { readonly result: CommandResult };

const INLINE_FIELDS = ['orientation', 'insideDiameter', 'tangentLength', 'heads'] as const;

/** The geometry of the `equipment` form or of the inline form, or the coded refusal. */
function geometryOf(doc: CadDocument, params: VolumeParams): Source {
  const inline = INLINE_FIELDS.filter((name) => params[name] !== undefined);
  const refusal = (code: string, message: string, path: string, ids: string[] = []): Source => ({
    result: refuse(doc, 'vessel_volume', code, message, ids, [path]),
  });
  if (params.equipment !== undefined) {
    if (inline.length > 0) return refusal('EQP_PARAM_INVALID', 'give equipment OR the inline geometry, not both', inline[0] as string);
    const element = findEquipment(getBuilding(doc), params.equipment);
    if (element === undefined) return refusal('EQP_NOT_FOUND', `no equipment with tag or id '${params.equipment}'`, 'equipment');
    const template = element.plant?.template;
    if (template?.kind !== 'vessel')
      return refusal('EQP_NOT_PARAMETRIC', `${element.mark} (${element.id}) is not a parametric vessel`, 'equipment', [element.id]);
    const { orientation, insideDiameter, tangentLength, heads } = template;
    return {
      geometry: { orientation, insideDiameter, tangentLength, first: heads.first, second: heads.second },
      liquid: element.plant?.design?.operatingLiquid,
    };
  }
  const { orientation, insideDiameter, tangentLength, heads } = params;
  if (orientation === undefined)
    return refusal('EQP_PARAM_INVALID', 'give equipment, or the inline geometry (orientation is missing)', 'orientation');
  if (insideDiameter === undefined) return refusal('EQP_PARAM_INVALID', 'inline geometry: insideDiameter is missing', 'insideDiameter');
  if (tangentLength === undefined) return refusal('EQP_PARAM_INVALID', 'inline geometry: tangentLength is missing', 'tangentLength');
  if (heads === undefined) return refusal('EQP_PARAM_INVALID', 'inline geometry: heads is missing', 'heads');
  return { geometry: { orientation, insideDiameter, tangentLength, first: heads.first, second: heads.second } };
}

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant volumes come from closed forms (Jones), never from meshes; levels are measured from the lowest inside point; nozzle bores and
 *   internals are not subtracted; a grade B/C head standard row makes the answer `unverified: true`; the equipment form reads the stored template
 * @failure invalid head -> EQP_HEAD_INVALID; level above the inside height -> EQP_LEVEL_OUT_OF_RANGE; horizontal torispherical head at
 *   a partial level -> EQP_HEAD_NOT_COVERED; unknown / legacy equipment -> EQP_NOT_FOUND / EQP_NOT_PARAMETRIC; refusals leave the document unchanged
 */
export const vesselVolume = defineCommand({
  name: 'vessel_volume',
  description:
    'Query: inside volume of a cylindrical vessel with two formed heads, and the liquid volume at given levels (closed forms of D. Jones, ' +
    'tank-volume geometry). Give EITHER `equipment` (tag or id of a vessel from add_vessel; its design.operatingLiquid is also reported as `operating`) ' +
    'OR the vessel inline: orientation, insideDiameter, tangentLength and the two heads (ellipsoidal 2:1, torispherical by standard or radii, ' +
    'hemispherical, flat, conical). Levels count up from the lowest inside point: the apex of the first (bottom) head for a vertical vessel, the ' +
    'bottom of the shell for a horizontal one. Lengths are in document units; volumes are returned in m3. Nozzle bores, trays and other internals ' +
    'are not subtracted. Returns totalVolumeM3, insideHeight, headDepths, levels[{ level, liquidVolumeM3, percent }], operating (equipment form with an ' +
    'operating liquid: { levelAboveBottomTangent, liquidVolumeM3, percent, liquidMassKg }), method, assumptions, sources and unverified (true when ' +
    'a grade B/C head standard was used). Refusals: EQP_NOT_FOUND, EQP_NOT_PARAMETRIC, EQP_PARAM_INVALID, EQP_HEAD_INVALID, EQP_LEVEL_OUT_OF_RANGE, ' +
    'EQP_HEAD_NOT_COVERED (horizontal torispherical heads at a partial level, V1). Does not modify the document.',
  annotations: { readOnly: true, idempotent: true },
  params: volumeParams,
  run: (doc, params): CommandResult => {
    const source = geometryOf(doc, params);
    if ('result' in source) return source.result;
    const { orientation, insideDiameter, tangentLength } = source.geometry;
    const unit = toMetres(doc, 1);
    const radius = toMetres(doc, insideDiameter) / 2;
    const length = toMetres(doc, tangentLength);
    const metric = (spec: HeadSpec): HeadSpec => ({
      ...spec,
      ...(spec.crownRadius === undefined ? {} : { crownRadius: toMetres(doc, spec.crownRadius) }),
      ...(spec.knuckleRadius === undefined ? {} : { knuckleRadius: toMetres(doc, spec.knuckleRadius) }),
    });
    const resolved = [
      resolveHead(metric(source.geometry.first), radius, 'heads.first'),
      resolveHead(metric(source.geometry.second), radius, 'heads.second'),
    ] as const;
    for (const head of resolved) {
      if (isRefusal(head)) return refuse(doc, 'vessel_volume', 'EQP_HEAD_INVALID', `vessel_volume: ${head.error}`, [], [head.path]);
    }
    const [first, second] = resolved as readonly [ResolvedHead, ResolvedHead];
    const height = orientation === 'vertical' ? verticalHeight(first.shape, second.shape, length) : 2 * radius;
    const total = Math.PI * radius * radius * length + headVolume(first.shape, radius) + headVolume(second.shape, radius);
    const volumeAt = (metres: number): number | null =>
      orientation === 'vertical'
        ? verticalVolume(radius, length, first.shape, second.shape, metres)
        : horizontalVolume(radius, length, first.shape, second.shape, metres);
    const rows: { level: number; liquidVolumeM3: number; percent: number }[] = [];
    for (const [index, level] of (params.levels ?? []).entries()) {
      const metres = toMetres(doc, level);
      if (metres > height * (1 + 1e-12)) {
        const message = `vessel_volume: levels[${index}] = ${level} is above the inside height ${height / unit}`;
        return refuse(doc, 'vessel_volume', 'EQP_LEVEL_OUT_OF_RANGE', message, [], [`levels.${index}`]);
      }
      const volume = volumeAt(Math.min(metres, height));
      if (volume === null) {
        const message = `vessel_volume: levels[${index}] = ${level}: a torispherical head of a horizontal vessel has no closed form at a partial level`;
        return refuse(doc, 'vessel_volume', 'EQP_HEAD_NOT_COVERED', message, [], [`levels.${index}`]);
      }
      rows.push({ level, liquidVolumeM3: volume, percent: (100 * volume) / total });
    }
    const liquid = source.liquid;
    const liquidMetres =
      liquid === undefined ? 0 : toMetres(doc, liquid.levelAboveBottomTangent) + (orientation === 'vertical' ? first.shape.depth : 0);
    const operatingVolume = liquid === undefined ? null : volumeAt(Math.min(liquidMetres, height));
    const operating =
      liquid === undefined || operatingVolume === null
        ? null
        : {
            levelAboveBottomTangent: liquid.levelAboveBottomTangent,
            liquidVolumeM3: operatingVolume,
            percent: (100 * operatingVolume) / total,
            specificGravity: liquid.specificGravity,
            liquidMassKg: operatingVolume * liquid.specificGravity * 1000,
          };
    const sources = [first.source, second.source].filter((value): value is string => value !== undefined);
    const unverified = first.unverified || second.unverified;
    const data = {
      orientation,
      totalVolumeM3: total,
      insideHeight: height / unit,
      headDepths: { first: first.shape.depth / unit, second: second.shape.depth / unit },
      levels: rows,
      ...(operating === null ? {} : { operating }),
      method: 'Jones closed forms (cylinder + heads); torispherical heads by the dish / knuckle / full branches; volumes in m3',
      assumptions: [
        'inside dimensions, ideal geometry',
        'levels measured from the lowest inside point (vertical: first-head apex; horizontal: shell bottom)',
        'nozzle bores, trays, baffles and other internals not subtracted',
      ],
      unverified,
      sources,
    };
    const flag = unverified ? ' (unverified: head standard below grade A)' : '';
    const extra = operating === null ? '' : `, operating ${operating.liquidVolumeM3.toPrecision(8)} m3`;
    return report(
      doc,
      `vessel_volume: ${orientation} vessel D ${insideDiameter} x ${tangentLength}: total ${total.toPrecision(8)} m3, ${rows.length} level(s)${extra}${flag}.`,
      data,
    );
  },
});
