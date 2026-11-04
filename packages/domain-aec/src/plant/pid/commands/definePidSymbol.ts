import { defineCommand, looseVec2, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import type { Entity } from '@core/model/types';
import type { Vec2 } from '@core/model/vectors';
import { refusePid } from '../dexpi/codes';
import { PID_CONVENTIONS, type PidConvention, type PidProjectSymbol } from '../model';
import { getPid, withPid } from '../state';
import { normalise, SYMBOL_LIMITS, shapeProblems, symbolFamilyOf, targetBox } from '../symbols/projectSymbol';

const ARC_SEGMENTS = 16;
const SUPPORTED = 'line, polyline, rectangle, circle, arc and text';

/** The shapes of one 2D entity in the symbol frame (the entity's plan position and z rotation applied), or the reason it cannot be a symbol shape. */
function shapesOfEntity(entity: Entity): Record<string, unknown>[] | string {
  const [px, py] = entity.position;
  const [rx, ry, rz] = entity.rotation;
  if (Math.abs(rx) > 1e-9 || Math.abs(ry) > 1e-9) return 'it is not drawn in the XY plane';
  const move = (p: Vec2): Vec2 => [px + p[0] * Math.cos(rz) - p[1] * Math.sin(rz), py + p[0] * Math.sin(rz) + p[1] * Math.cos(rz)];
  switch (entity.kind) {
    case 'line':
      return [{ t: 'line', pts: [move(entity.start), move(entity.end)] }];
    case 'polyline':
      return [{ t: 'line', pts: entity.points.map(move), closed: entity.closed }];
    case 'rectangle':
      return [
        {
          t: 'line',
          pts: (
            [
              [0, 0],
              [entity.width, 0],
              [entity.width, entity.height],
              [0, entity.height],
            ] as Vec2[]
          ).map(move),
          closed: true,
        },
      ];
    case 'circle':
      return [{ t: 'circle', c: move(entity.center), r: entity.radius }];
    case 'arc': {
      let end = entity.endAngle;
      while (end <= entity.startAngle) end += 2 * Math.PI;
      const pts = Array.from({ length: ARC_SEGMENTS + 1 }, (_, i): Vec2 => {
        const angle = entity.startAngle + ((end - entity.startAngle) * i) / ARC_SEGMENTS;
        return move([entity.center[0] + entity.radius * Math.cos(angle), entity.center[1] + entity.radius * Math.sin(angle)]);
      });
      return [{ t: 'line', pts }];
    }
    case 'text':
      return [{ t: 'text', at: move([0, 0]), h: entity.height, s: entity.content }];
    default:
      return `a ${entity.kind} cannot become a symbol shape (supported: ${SUPPORTED})`;
  }
}

const shapeSchema = z
  .object({
    t: z.enum(['line', 'circle', 'text']).describe('Shape type: line (polyline or polygon), circle, text.'),
    pts: z.array(looseVec2('A point [x, y] of the line, millimetres.')).optional().describe('line: at least 2 points, at most 200.'),
    closed: z.boolean().optional().describe('line: true closes it to a polygon.'),
    fill: z.boolean().optional().describe('line (closed) or circle: true paints it solid.'),
    style: z.enum(['visible', 'thin', 'hidden']).optional().describe('line or circle stroke: visible (default), thin or hidden.'),
    c: looseVec2('circle: centre [x, y], millimetres.').optional(),
    r: z.number().optional().describe('circle: radius > 0, millimetres.'),
    at: looseVec2('text: anchor [x, y], millimetres.').optional(),
    h: z.number().optional().describe('text: character height in (0, 100] millimetres.'),
    s: z.string().optional().describe('text: 1 to 24 characters, no control characters and none of < > & " \'.'),
  })
  .describe('One shape of the symbol in its own frame: millimetres, +y up. Only the fields of the chosen t are read.');

/**
 * @affects plant.pid.symbols[class] (one project symbol: graphics normalised into the box of the built-in class, the conventions it applies to); no item changes
 * @invariant the definition is untrusted and validated before it is stored (shape count, points, coordinates, radii, text, finite numbers); graphics are centred and scaled uniformly to fit the half extents of the built-in class, so nozzle and inline ports stay valid; a project symbol replaces the built-in one for the conventions it names in the drawing, SVG and list_pid_symbols (source "project"); only classes of the library have symbols
 * @failure unknown class / not an equipment or piping class -> PID_CLASS_UNKNOWN; both or neither of fromEntities / shapes, an entity that is missing, 3D or unsupported, a shape that fails validation, graphics with no extent -> PID_SYMBOL_INVALID / PID_PARAM_INVALID; remove of an undefined symbol -> PID_SYMBOL_NOT_FOUND; document unchanged
 */
export const definePidSymbol = defineCommand({
  name: 'define_pid_symbol',
  description:
    'Define the project\'s own symbol for a P&ID library class (equipment such as Tank / CentrifugalPump, or an inline piping component such as BallValve): the graphics replace the built-in symbol on the sheet, in export_pid_svg, in the 2D view and in list_pid_symbols (source "project"). ' +
    'Give the graphics either as fromEntities (ids of 2D entities you drew: line, polyline, rectangle, circle, arc, text; their plan position and z rotation are applied) or as shapes ' +
    '(inline: line { pts, closed?, fill?, style? }, circle { c, r, fill?, style? }, text { at, h, s }; millimetres, +y up). The definition is validated as untrusted data (at most 64 shapes, 200 points per line, coordinates within +/-1000 mm, text of 1 to 24 characters). ' +
    'The graphics are centred on their bounding box and scaled uniformly to fit the box of the built-in class (equipment: its half extents, e.g. Tank 25 x 25; inline components: 5 x 3.2), so the nozzle ports of equipment and the ports of inline items stay where authoring put them: ports cannot be redefined. ' +
    '`conventions` limits it to ISA-5.1 and/or ISO-10628-2 (default both). A second call for the same class replaces the symbol; remove: true deletes it (built-in again). Instrument bubbles, actuators and connectors have no project symbols. ' +
    'Returns data = { class, family, name, conventions, shapes (count), halfWidth, halfHeight, replaced }. Refusals (document unchanged): PID_CLASS_UNKNOWN, PID_SYMBOL_INVALID, PID_SYMBOL_NOT_FOUND, PID_PARAM_INVALID.',
  params: z.object({
    class: z
      .string()
      .trim()
      .min(1)
      .describe('The library class the symbol is for, exactly as list_pid_symbols prints it (e.g. "Tank", "BallValve").'),
    name: z.string().trim().min(1).max(SYMBOL_LIMITS.name).optional().describe('Display name of the symbol. Default: the class name.'),
    conventions: z
      .array(z.enum(PID_CONVENTIONS))
      .min(1)
      .optional()
      .describe('Conventions the symbol applies to. Default both ISA-5.1 and ISO-10628-2.'),
    fromEntities: z
      .array(z.string().min(1))
      .min(1)
      .max(SYMBOL_LIMITS.shapes)
      .optional()
      .describe('Ids of 2D entities (line, polyline, rectangle, circle, arc, text) to copy as the graphics. Give fromEntities OR shapes.'),
    shapes: z.array(shapeSchema).min(1).max(SYMBOL_LIMITS.shapes).optional().describe('The graphics inline. Give fromEntities OR shapes.'),
    remove: z
      .boolean()
      .optional()
      .describe('true deletes the project symbol of the class (the built-in one is used again). Give no graphics with it.'),
  }),
  run: (doc, params): CommandResult => {
    const pid = getPid(doc);
    const fail = (code: string, message: string, paths: readonly string[], ids: readonly string[] = []): CommandResult =>
      refusePid(doc, 'define_pid_symbol', code, message, ids, paths);
    const family = symbolFamilyOf(params.class);
    if (family === null)
      return fail(
        'PID_CLASS_UNKNOWN',
        `"${params.class}" is not an equipment or piping component class of the library (list_pid_symbols)`,
        ['class'],
      );
    const existing = pid.symbols !== undefined && Object.hasOwn(pid.symbols, params.class) ? pid.symbols[params.class] : undefined;
    if (params.remove === true) {
      if (params.fromEntities !== undefined || params.shapes !== undefined)
        return fail('PID_PARAM_INVALID', 'remove takes no graphics: leave fromEntities and shapes out', ['remove']);
      if (existing === undefined) return fail('PID_SYMBOL_NOT_FOUND', `class ${params.class} has no project symbol`, ['class']);
      const { [params.class]: _removed, ...rest } = pid.symbols ?? {};
      const remaining = Object.keys(rest).length === 0 ? undefined : rest;
      const { symbols: _symbols, ...others } = pid;
      return {
        document: withPid(doc, remaining === undefined ? others : { ...others, symbols: remaining }),
        summary: `define_pid_symbol: project symbol of ${params.class} removed (built-in again)`,
        affected: [],
        data: { class: params.class, family, removed: true },
      };
    }
    if ((params.fromEntities === undefined) === (params.shapes === undefined))
      return fail('PID_PARAM_INVALID', 'give the graphics as fromEntities OR shapes (exactly one)', ['shapes']);
    let raw: Record<string, unknown>[] = [];
    if (params.fromEntities !== undefined) {
      for (const [index, id] of params.fromEntities.entries()) {
        const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
        if (entity === undefined) return fail('PID_SYMBOL_INVALID', `entity "${id}" does not exist`, [`fromEntities.${index}`]);
        const shapes = shapesOfEntity(entity);
        if (typeof shapes === 'string') return fail('PID_SYMBOL_INVALID', `entity ${id}: ${shapes}`, [`fromEntities.${index}`], [id]);
        raw = [...raw, ...shapes];
      }
    } else raw = (params.shapes ?? []).map((shape) => Object.fromEntries(Object.entries(shape).filter(([, value]) => value !== undefined)));
    const problems = shapeProblems(raw, params.fromEntities === undefined ? 'shapes' : 'graphics');
    if (problems.length > 0)
      return fail('PID_SYMBOL_INVALID', problems.slice(0, 5).join('; '), [params.fromEntities === undefined ? 'shapes' : 'fromEntities']);
    const box = targetBox(params.class);
    const fitted = normalise(raw, box);
    if (typeof fitted === 'string')
      return fail('PID_SYMBOL_INVALID', fitted, [params.fromEntities === undefined ? 'shapes' : 'fromEntities']);
    const conventions: PidConvention[] = [...new Set(params.conventions ?? PID_CONVENTIONS)];
    const symbol: PidProjectSymbol = { class: params.class, name: params.name ?? params.class, conventions, shapes: fitted };
    return {
      document: withPid(doc, { ...pid, symbols: { ...pid.symbols, [params.class]: symbol } }),
      summary: `define_pid_symbol: project symbol of ${params.class} (${fitted.length} shape(s), ${conventions.join(' + ')}) fitted to ${box[0] * 2} x ${box[1] * 2} mm${existing === undefined ? '' : ', replacing the previous one'}`,
      affected: [],
      data: {
        class: params.class,
        family,
        name: symbol.name,
        conventions,
        shapes: fitted.length,
        halfWidth: box[0],
        halfHeight: box[1],
        replaced: existing !== undefined,
      },
    };
  },
});
