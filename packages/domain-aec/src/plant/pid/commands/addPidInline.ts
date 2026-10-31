import { defineCommand, vec2, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { pipingClassName, isValveClass } from '../authoring/classes';
import { INLINE_HALF_LENGTH, nearestLeg, splitRoute, SNAP_DISTANCE, type LegHit } from '../authoring/geometry';
import { Draft, checkTag, fail, findLine, isFail, refuse, segmentsOf, mintFree } from '../authoring/refs';
import { splitSegmentAt } from '../authoring/split';
import { attributesParam, toValues } from '../authoring/values';
import type { PidInline, PidSegment, PidValue } from '../model';
import { getPid, withPid } from '../state';

/**
 * @affects plant.pid (one inline item; the segment under it is split in two: the first piece keeps its id, a new segment takes the second piece and the old end; tee references follow)
 * @invariant the item sits on the nearest segment leg (snapped, <= 5 mm away) with its two ports 5 mm either side; pieces inherit line, dn, class, flow, primary; dn / class default from the segment and are flagged `defaulted`; delete_pid_item heal restores the route exactly
 * @failure line unknown -> PID_ITEM_NOT_FOUND; class unknown -> PID_CLASS_UNKNOWN; point > 5 mm off the line or < 5 mm from a bend / end of its run -> PID_POINT_OFF_LINE; tag used -> PID_TAG_DUPLICATE; document unchanged
 */
export const addPidInline = defineCommand({
  name: 'add_pid_inline',
  description:
    'Insert an inline component (valve, reducer, tee fitting, flange, orifice ...) into a process line at a point of the sheet. `class` is a DEXPI piping class ' +
    '(BallValve, GlobeValve, GateValve, ButterflyValve, PlugValve, NeedleValve, DiaphragmValve, SwingCheckValve, SpringLoadedGlobeSafetyValve, OperatedValve, PipeTee, ' +
    'PipeReducer, PipeFitting, BlindFlange, Flange, RestrictionOrifice). The point `at` (sheet mm) is snapped to the nearest straight run of the line (it must be within 5 mm ' +
    'and at least 5 mm from a bend or from the end of that run); the segment is split in two there and the item gets two ports 5 mm either side. `dn` and `pipingClass` ' +
    'default to the segment values (flagged defaulted in attributes); give them to model a mismatch. `reversed` marks a check valve installed against the flow; ' +
    '`operated` marks a valve that needs an actuating system. Returns affected = [inline id, new segment id]; affected[0] is the item. data = { inline, segments: [upstream, downstream], at }. ' +
    'Refusals (document unchanged): PID_ITEM_NOT_FOUND, PID_CLASS_UNKNOWN, PID_POINT_OFF_LINE, PID_TAG_DUPLICATE, PID_TAG_FORMAT. Next: add_pid_actuating_system, add_pid_instrument.',
  params: z.object({
    line: z.string().min(1).describe('Line id (affected[0] of add_pid_line), line number, or a segment id of the line.'),
    at: vec2('Insertion point on the sheet, millimetres [x, y]; snapped onto the line within 5 mm.'),
    class: z.string().min(1).describe('DEXPI piping component class, e.g. "BallValve".'),
    tag: z.string().min(1).optional().describe('Component tag, unique in the document (e.g. "HV-102").'),
    dn: z.number().int().positive().optional().describe('Nominal size, DN integer; default the segment size.'),
    pipingClass: z.string().trim().min(1).optional().describe('Piping class; default the segment class.'),
    reversed: z.boolean().optional().describe('True for a check valve installed against the segment flow.'),
    operated: z
      .boolean()
      .optional()
      .describe('True for a valve that is power-operated (control / on-off valve): it needs add_pid_actuating_system.'),
    attributes: attributesParam,
  }),
  run: (doc, params): CommandResult => {
    const name = 'add_pid_inline';
    const pid = getPid(doc);
    const line = findLine(pid, params.line, 'line');
    if (isFail(line)) return refuse(doc, name, line);
    const dexpiClass = pipingClassName(params.class, 'class');
    if (isFail(dexpiClass)) return refuse(doc, name, dexpiClass);
    let tag: string | undefined;
    if (params.tag !== undefined) {
      const checked = checkTag(pid, params.tag, isValveClass(dexpiClass) ? 'valve' : undefined, 'tag');
      if (isFail(checked)) return refuse(doc, name, checked);
      tag = checked;
    }
    let host: { segment: PidSegment; hit: LegHit } | undefined;
    let nearest = Infinity;
    for (const segment of segmentsOf(pid, line)) {
      const hit = nearestLeg(segment.route, params.at);
      if (hit !== undefined && hit.distance < nearest) {
        nearest = hit.distance;
        host = { segment, hit };
      }
    }
    if (host === undefined || nearest > SNAP_DISTANCE)
      return refuse(
        doc,
        name,
        fail(
          'PID_POINT_OFF_LINE',
          `[${params.at.join(', ')}] is ${host ? nearest.toFixed(1) : 'not'} mm from line ${params.line} (limit ${SNAP_DISTANCE} mm)`,
          ['at'],
        ),
      );
    const { hit, segment } = host;
    if (hit.along < INLINE_HALF_LENGTH - 1e-9 || hit.legLength - hit.along < INLINE_HALF_LENGTH - 1e-9)
      return refuse(
        doc,
        name,
        fail(
          'PID_POINT_OFF_LINE',
          `the point is within ${INLINE_HALF_LENGTH} mm of a bend or of the end of its straight run (room for the two ports is needed)`,
          ['at'],
        ),
      );
    const dn = params.dn ?? segment.dn;
    const pipingClass = params.pipingClass ?? segment.pipingClass;
    const defaulted = (value: PidValue): PidValue => ({ ...value, defaulted: true }) as PidValue;
    const attributes: Record<string, PidValue> = {
      ...(params.dn === undefined && dn !== undefined ? { nominalDiameter: defaulted({ kind: 'quantity', value: dn, unit: 'DN' }) } : {}),
      ...(params.pipingClass === undefined && pipingClass !== undefined
        ? { pipingClass: defaulted({ kind: 'text', value: pipingClass }) }
        : {}),
      ...toValues(params.attributes),
    };
    const pieces = splitRoute(segment.route, hit);
    const inline: PidInline = {
      id: mintFree(pid),
      kind: 'inline',
      sheetId: segment.sheetId,
      at: hit.snapped,
      rotationDeg: Math.round(((Math.atan2(hit.direction[1], hit.direction[0]) * 180) / Math.PI) * 1e9) / 1e9,
      dexpiClass,
      attributes,
      ports: pieces.ports,
      ...(tag === undefined ? {} : { tag }),
      ...(dn === undefined ? {} : { dn }),
      ...(pipingClass === undefined ? {} : { pipingClass }),
      ...(params.reversed === undefined ? {} : { reversed: params.reversed }),
      ...(params.operated === undefined ? {} : { operated: params.operated }),
    };
    const newId = mintFree(pid);
    const draft = new Draft(pid);
    splitSegmentAt(draft, segment, line, inline, pieces, newId);
    return {
      document: withPid(doc, draft.model()),
      summary: `add_pid_inline: ${dexpiClass}${tag === undefined ? '' : ` ${tag}`} (${inline.id}) on line ${line.lineNumber ?? line.id} at [${hit.snapped.map((v) => Math.round(v * 1e6) / 1e6).join(', ')}], segment ${segment.id} split into ${segment.id} + ${newId}`,
      affected: [inline.id, newId],
      data: { inline: inline.id, segments: [segment.id, newId], at: hit.snapped },
    };
  },
});
