/**
 * @layer ui/panels/building
 *
 * "Pipe support" tool spec → `add_pipe_support` (param-gathering only, react R1). The pipe is picked
 * from the live list (`line:<number>` = every pipe of that line, `pipe:<id>` = one unnumbered pipe).
 */

import {
  FieldReader,
  INDUSTRIAL_TOOL_GROUP,
  num,
  result,
  select,
  txt,
  type ElementTool,
} from './elementToolForm';

export const PIPE_SUPPORT_TOOL: ElementTool = {
  id: 'pipeSupport',
  label: 'Pipe support',
  group: INDUSTRIAL_TOOL_GROUP,
  fields: [
    select('pipe', 'Pipe / line', '', 'pipes'),
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
    const [kind, ...rest] = reader.text('pipe').split(':');
    const target = rest.join(':');
    if (target === '' || (kind !== 'line' && kind !== 'pipe'))
      return { ok: false, reason: 'Choose the pipe or line to support.' };
    const hasPoints = reader.text('points') !== '';
    const spacing = reader.optionalNumber('spacing');
    if (hasPoints === (spacing !== undefined))
      return { ok: false, reason: 'Give either the support points or a maximum spacing.' };
    return result(reader, 'add_pipe_support', {
      ...(kind === 'line' ? { line: target } : { pipeId: target }),
      type: reader.text('type'),
      ...(hasPoints ? { at: reader.pointList('points', 1) } : { spacing }),
      memberId: reader.text('memberId') || undefined,
      maxReach: reader.optionalNumber('maxReach'),
    });
  },
};
