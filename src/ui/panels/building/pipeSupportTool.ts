// "Pipe support" → `add_pipe_support`; pipe picked from the live list (`line:<number>` = whole line, `pipe:<id>` = one) or a spec-driven plant run by its id (`runId`).

import { FieldReader, INDUSTRIAL_TOOL_GROUP, num, result, select, txt, type ElementTool } from './elementToolForm';

export const PIPE_SUPPORT_TOOL: ElementTool = {
  id: 'pipeSupport',
  label: 'Pipe support',
  group: INDUSTRIAL_TOOL_GROUP,
  fields: [
    select('pipe', 'Pipe / line', '', 'pipes'),
    txt('runId', 'Or plant run id (route_pipe, e.g. run-7.1)', '', true),
    select('type', 'Type', 'shoe', [
      ['shoe', 'Shoe (rests on steel below)'],
      ['hanger', 'Hanger (rod from steel above)'],
      ['guide', 'Guide (shoe with side stops)'],
      ['anchor', 'Anchor (fixed shoe)'],
    ]),
    txt('points', 'Points x,y,z; … (absolute)', '', true),
    num('spacing', 'Or maximum spacing', '', true),
    txt('memberId', 'Bearing member id', '', true),
    num('maxReach', 'Max vertical reach', '', true),
  ],
  build: (values) => {
    const reader = new FieldReader(values);
    const runId = reader.text('runId');
    const [kind, ...rest] = reader.text('pipe').split(':');
    const target = rest.join(':');
    const picked = target !== '' && (kind === 'line' || kind === 'pipe');
    if (runId !== '' && picked) return { ok: false, reason: 'Give either a pipe / line or a plant run id, not both.' };
    if (runId === '' && !picked) return { ok: false, reason: 'Choose the pipe or line to support, or give a plant run id.' };
    const hasPoints = reader.text('points') !== '';
    const spacing = reader.optionalNumber('spacing');
    if (hasPoints === (spacing !== undefined)) return { ok: false, reason: 'Give either the support points or a maximum spacing.' };
    return result(reader, 'add_pipe_support', {
      ...(runId !== '' ? { runId } : kind === 'line' ? { line: target } : { pipeId: target }),
      type: reader.text('type'),
      ...(hasPoints ? { at: reader.pointList('points', 1) } : { spacing }),
      memberId: reader.text('memberId') || undefined,
      maxReach: reader.optionalNumber('maxReach'),
    });
  },
};
