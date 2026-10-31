import { defineCommand, vec2, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import type { Vec2 } from '@core/model/vectors';
import { axisOf, nearestLeg, orthogonalRoute, SNAP_DISTANCE } from '../authoring/geometry';
import { composeInstrumentTag, splitInstrumentTag } from '../authoring/instrumentTag';
import { Draft, checkTag, fail, findItem, findLine, findSheet, isFail, refuse, segmentsOf, mintFree } from '../authoring/refs';
import {
  PID_INSTRUMENT_DISPLAYS,
  PID_INSTRUMENT_LOCATIONS,
  type PidEndpoint,
  type PidInstrument,
  type PidPlain,
  type PidSignal,
} from '../model';
import { getPid, withPid } from '../state';

/**
 * @affects plant.pid (one instrument; its loop item when the loop is new; one measuring signal when `measures` is given)
 * @invariant the tag is stored split (category = first letter, functions = the other letters, loopNumber); instruments with the same first letter and loop number share one loop item `<letter>-<number>`; the measuring signal runs from the tap to the instrument
 * @failure sheet unknown -> PID_SHEET_NOT_FOUND; tag unparseable and no parts -> PID_TAG_FORMAT; tag used -> PID_TAG_DUPLICATE; tap point > 5 mm off the line -> PID_POINT_OFF_LINE; tap target unknown -> PID_ITEM_NOT_FOUND / PID_LINE_ENDPOINT_INVALID; document unchanged
 */
export const addPidInstrument = defineCommand({
  name: 'add_pid_instrument',
  description:
    'Place an instrument (a DEXPI ProcessInstrumentationFunction, ISA bubble) on a P&ID sheet. Give the `tag` as letters + loop number (e.g. "FT-101", "FIC-101", "PDIT 12.01", ' +
    '"FV-101A"; capital letters; the first letter is the measured variable, the rest the functions) or `parts` { category, functions, loop } when the tag does not fit that grammar. ' +
    'The tag is stored split (category, functions, loopNumber); instruments of the same first letter and loop number join one loop item (created on first use) unless `loop` names another one. ' +
    '`at` is the bubble centre in sheet mm; `location` is field, central, local_panel or auxiliary; `display` is discrete (default), shared, plc or software. `measures` ' +
    'draws the measuring line from the process: { line, at } (a tap on a line, snapped within 5 mm) or { tag, nozzle } (an equipment nozzle). Returns affected = [instrument id, loop id?, signal id?]; ' +
    'affected[0] is the instrument. data = { instrument, loop, signal, tag }. Refusals (document unchanged): PID_SHEET_NOT_FOUND, PID_TAG_FORMAT, PID_TAG_DUPLICATE, PID_POINT_OFF_LINE, PID_ITEM_NOT_FOUND, PID_LINE_ENDPOINT_INVALID. Next: add_pid_signal_line, add_pid_actuating_system.',
  params: z.object({
    sheet: z.string().min(1).describe('Sheet number or id.'),
    tag: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Instrument tag, e.g. "FT-101" (letters, optional "-" or space, loop number, optional suffix letter). Use this or `parts`.',
      ),
    parts: z
      .object({
        category: z.string().min(1).describe('Measured variable, the first letter(s) of the tag, e.g. "F".'),
        functions: z.string().describe('Function letters, e.g. "IC" (may be empty).'),
        loop: z.string().min(1).describe('Loop number, e.g. "101" or "4712.01".'),
      })
      .optional()
      .describe('Tag parts when `tag` does not fit the grammar: the tag becomes <category><functions>-<loop>.'),
    at: vec2('Bubble centre on the sheet, millimetres [x, y].'),
    location: z
      .enum(PID_INSTRUMENT_LOCATIONS)
      .describe('Where the instrument is mounted: field, central (control room), local_panel or auxiliary.'),
    display: z.enum(PID_INSTRUMENT_DISPLAYS).optional().describe('Display type: discrete (default), shared, plc or software.'),
    loop: z
      .string()
      .min(1)
      .optional()
      .describe('Loop item id or loop tag to join instead of the one derived from the tag (created when it does not exist).'),
    measures: z
      .object({
        line: z.string().min(1).optional().describe('Line id / line number to tap: use with `at`.'),
        at: vec2('Tap point on the line, sheet mm (snapped, within 5 mm).').optional(),
        tag: z.string().min(1).optional().describe('Equipment tag (or id) whose nozzle is the process connection: use with `nozzle`.'),
        nozzle: z.string().min(1).optional().describe('Sub-tag of the nozzle on `tag`.'),
      })
      .optional()
      .describe('Process connection drawn as a measuring line: { line, at } or { tag, nozzle }.'),
  }),
  run: (doc, params): CommandResult => {
    const name = 'add_pid_instrument';
    const pid = getPid(doc);
    const sheet = findSheet(pid, params.sheet);
    if (isFail(sheet)) return refuse(doc, name, sheet);
    const parts = params.parts ?? splitInstrumentTag(params.tag ?? '');
    if (parts === undefined || (params.tag === undefined && params.parts === undefined))
      return refuse(
        doc,
        name,
        fail('PID_TAG_FORMAT', `"${params.tag ?? ''}" is not letters + loop number (e.g. FIC-101); give { category, functions, loop }`, [
          'tag',
        ]),
      );
    const category = parts.category;
    const functions = parts.functions;
    const loopNumber = 'loopNumber' in parts ? parts.loopNumber : parts.loop;
    const tag = checkTag(
      pid,
      params.parts === undefined ? (params.tag ?? '') : composeInstrumentTag(category, functions, loopNumber),
      'instrument',
      'tag',
    );
    if (isFail(tag)) return refuse(doc, name, tag);

    let tap: { endpoint: PidEndpoint; point: Vec2; vertical: boolean } | undefined;
    const m = params.measures;
    if (m !== undefined) {
      if (m.line !== undefined && m.at !== undefined) {
        const line = findLine(pid, m.line, 'measures.line');
        if (isFail(line)) return refuse(doc, name, line);
        let best: { id: string; distance: number; snapped: Vec2; horizontal: boolean } | undefined;
        for (const segment of segmentsOf(pid, line)) {
          const hit = nearestLeg(segment.route, m.at);
          if (hit !== undefined && (best === undefined || hit.distance < best.distance))
            best = {
              id: segment.id,
              distance: hit.distance,
              snapped: hit.snapped,
              horizontal: Math.abs(hit.direction[0]) > Math.abs(hit.direction[1]),
            };
        }
        if (best === undefined || best.distance > SNAP_DISTANCE)
          return refuse(
            doc,
            name,
            fail('PID_POINT_OFF_LINE', `the tap [${m.at.join(', ')}] is farther than ${SNAP_DISTANCE} mm from line ${m.line}`, [
              'measures.at',
            ]),
          );
        tap = { endpoint: { type: 'branch', segmentId: best.id, at: best.snapped }, point: best.snapped, vertical: best.horizontal };
      } else if (m.tag !== undefined && m.nozzle !== undefined) {
        const equipment = findItem(pid, m.tag, 'measures.tag');
        if (isFail(equipment)) return refuse(doc, name, equipment);
        const nozzle = pid.itemOrder
          .map((id) => pid.items[id])
          .find((i) => i?.kind === 'nozzle' && i.equipmentId === equipment.id && i.subTag === m.nozzle);
        if (nozzle?.kind !== 'nozzle')
          return refuse(doc, name, fail('PID_ITEM_NOT_FOUND', `${m.tag} has no nozzle "${m.nozzle}"`, ['measures.nozzle']));
        tap = { endpoint: { type: 'nozzle', itemId: nozzle.id }, point: nozzle.port, vertical: axisOf(equipment.at, nozzle.port) === 'v' };
      } else return refuse(doc, name, fail('PID_LINE_ENDPOINT_INVALID', 'measures is { line, at } or { tag, nozzle }', ['measures']));
    }

    const draft = new Draft(pid);
    const instrumentId = mintFree(pid);
    const loopRef = params.loop;
    const loopKey = loopRef ?? `${category}-${loopNumber}`;
    let loop: PidPlain | undefined = pid.itemOrder
      .map((id) => pid.items[id])
      .flatMap((item) => (item?.kind === 'loop' && (item.id === loopKey || item.tag === loopKey) ? [item] : []))[0];
    let loopCreated = false;
    if (loop === undefined) {
      loop = {
        id: mintFree(pid),
        kind: 'loop',
        sheetId: sheet.id,
        at: params.at,
        rotationDeg: 0,
        dexpiClass: 'InstrumentationLoopFunction',
        attributes: {},
        tag: loopKey,
      };
      loopCreated = true;
      draft.put(loop);
    }
    const instrument: PidInstrument = {
      id: instrumentId,
      kind: 'instrument',
      sheetId: sheet.id,
      at: params.at,
      rotationDeg: 0,
      dexpiClass: 'ProcessInstrumentationFunction',
      attributes: {},
      tag,
      category,
      functions,
      loopNumber,
      location: params.location,
      display: params.display ?? 'discrete',
      loopId: loop.id,
    };
    draft.put(instrument);
    let signal: PidSignal | undefined;
    if (tap !== undefined) {
      signal = {
        id: mintFree(pid),
        kind: 'signal',
        sheetId: sheet.id,
        at: tap.point,
        rotationDeg: 0,
        dexpiClass: 'InformationFlow',
        attributes: {},
        signalKind: 'measuring',
        from: tap.endpoint,
        to: { type: 'instrument', itemId: instrumentId },
        route: orthogonalRoute(tap.point, params.at, tap.vertical ? 'v' : 'h', undefined),
      };
      draft.put(signal);
    }
    return {
      document: withPid(doc, draft.model()),
      summary:
        `add_pid_instrument: ${tag} (${instrumentId}) on ${sheet.number}, loop ${loop.tag ?? loop.id}${loopCreated ? ' (new)' : ''}` +
        (signal === undefined ? '' : `, measuring line ${signal.id}`),
      affected: [instrumentId, ...(loopCreated ? [loop.id] : []), ...(signal === undefined ? [] : [signal.id])],
      data: { instrument: instrumentId, loop: loop.id, signal: signal?.id ?? null, tag },
    };
  },
});
