import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { toMetres } from '@core/model/units';
import { horizontalVolume, verticalHeight, verticalVolume } from '../geometry/partialVolume';
import { headVolume, resolveHead, type HeadRefusal, type ResolvedHead } from '../geometry/heads';
import { headSpecSchema, refuse, type HeadSpec } from '../model';

const isRefusal = (value: ResolvedHead | HeadRefusal): value is HeadRefusal => 'error' in value;

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant volumes come from closed forms (Jones), never from meshes; levels are measured from the lowest inside point; nozzle bores and
 *   internals are not subtracted; a grade B/C head standard row makes the answer `unverified: true`
 * @failure invalid head -> EQP_HEAD_INVALID; level above the inside height -> EQP_LEVEL_OUT_OF_RANGE; horizontal torispherical head at
 *   a partial level -> EQP_HEAD_NOT_COVERED; refusals leave the document unchanged
 */
export const vesselVolume = defineCommand({
  name: 'vessel_volume',
  description:
    'Query: inside volume of a cylindrical vessel with two formed heads, and the liquid volume at given levels (closed forms of D. Jones, ' +
    'tank-volume geometry). Describe the vessel by its inside diameter, tangent-to-tangent length and the two heads (ellipsoidal 2:1, ' +
    'torispherical by standard or radii, hemispherical, flat, conical). Levels count up from the lowest inside point: the apex of the ' +
    'first (bottom) head for a vertical vessel, the bottom of the shell for a horizontal one. Lengths are in document units; volumes are ' +
    'returned in m3. Nozzle bores, trays and other internals are not subtracted. Returns totalVolumeM3, insideHeight, headDepths, ' +
    'levels[{ level, liquidVolumeM3, percent }], method, assumptions, sources and unverified (true when a grade B/C head standard was used). ' +
    'Refusals: EQP_HEAD_INVALID, EQP_LEVEL_OUT_OF_RANGE, EQP_HEAD_NOT_COVERED (horizontal torispherical heads at a partial level, V1). ' +
    'Does not modify the document.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    orientation: z
      .enum(['vertical', 'horizontal'])
      .describe('Axis of the cylinder: vertical (heads bottom / top) or horizontal (heads left / right).'),
    insideDiameter: z.number().positive().describe('Inside diameter of the cylinder, document units.'),
    tangentLength: z.number().positive().describe('Tangent-to-tangent length of the cylindrical part, document units (heads excluded).'),
    heads: z
      .object({
        first: headSpecSchema.describe('Bottom head (vertical) or left head (horizontal).'),
        second: headSpecSchema.describe('Top head (vertical) or right head (horizontal).'),
      })
      .describe('The two formed heads.'),
    levels: z
      .array(z.number().min(0))
      .max(200)
      .optional()
      .describe('Liquid levels from the lowest inside point, document units, each in 0..insideHeight. Omit for the total volume only.'),
  }),
  run: (doc, { orientation, insideDiameter, tangentLength, heads, levels }) => {
    const unit = toMetres(doc, 1);
    const radius = toMetres(doc, insideDiameter) / 2;
    const length = toMetres(doc, tangentLength);
    const metric = (spec: HeadSpec): HeadSpec => ({
      ...spec,
      ...(spec.crownRadius === undefined ? {} : { crownRadius: toMetres(doc, spec.crownRadius) }),
      ...(spec.knuckleRadius === undefined ? {} : { knuckleRadius: toMetres(doc, spec.knuckleRadius) }),
    });
    const resolved = [
      resolveHead(metric(heads.first), radius, 'heads.first'),
      resolveHead(metric(heads.second), radius, 'heads.second'),
    ] as const;
    for (const head of resolved) {
      if (isRefusal(head)) return refuse(doc, 'vessel_volume', 'EQP_HEAD_INVALID', `vessel_volume: ${head.error}`, [], [head.path]);
    }
    const [first, second] = resolved as readonly [ResolvedHead, ResolvedHead];
    const height = orientation === 'vertical' ? verticalHeight(first.shape, second.shape, length) : 2 * radius;
    const total = Math.PI * radius * radius * length + headVolume(first.shape, radius) + headVolume(second.shape, radius);
    const rows: { level: number; liquidVolumeM3: number; percent: number }[] = [];
    for (const [index, level] of (levels ?? []).entries()) {
      const metres = toMetres(doc, level);
      if (metres > height * (1 + 1e-12)) {
        const message = `vessel_volume: levels[${index}] = ${level} is above the inside height ${height / unit}`;
        return refuse(doc, 'vessel_volume', 'EQP_LEVEL_OUT_OF_RANGE', message, [], [`levels.${index}`]);
      }
      const clamped = Math.min(metres, height);
      const volume =
        orientation === 'vertical'
          ? verticalVolume(radius, length, first.shape, second.shape, clamped)
          : horizontalVolume(radius, length, first.shape, second.shape, clamped);
      if (volume === null) {
        const message = `vessel_volume: levels[${index}] = ${level}: a torispherical head of a horizontal vessel has no closed form at a partial level`;
        return refuse(doc, 'vessel_volume', 'EQP_HEAD_NOT_COVERED', message, [], [`levels.${index}`]);
      }
      rows.push({ level, liquidVolumeM3: volume, percent: (100 * volume) / total });
    }
    const sources = [first.source, second.source].filter((source): source is string => source !== undefined);
    const unverified = first.unverified || second.unverified;
    const data = {
      orientation,
      totalVolumeM3: total,
      insideHeight: height / unit,
      headDepths: { first: first.shape.depth / unit, second: second.shape.depth / unit },
      levels: rows,
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
    return report(
      doc,
      `vessel_volume: ${orientation} vessel D ${insideDiameter} x ${tangentLength}: total ${total.toPrecision(8)} m3, ${rows.length} level(s)${flag}.`,
      data,
    );
  },
});
