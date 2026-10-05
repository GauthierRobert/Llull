/**
 * @layer ui/panels/building
 *
 * "Pipe support" tool spec → `add_pipe_support` (param-gathering only, react R1). The pipe is picked
 * from the live list (`line:<number>` = every pipe of that line, `pipe:<id>` = one unnumbered pipe).
 */

import { FieldReader, num, txt, type ElementTool } from './elementToolForm';

const GROUP = 'Industrial / steel';

export const PIPE_SUPPORT_TOOL: ElementTool = {
  id: 'pipeSupport',
  label: 'Pipe support',
  group: GROUP,
  fields: [
    { key: 'pipe', label: 'Pipe / line', kind: 'select', defaultValue: '', options: 'pipes' },
    {
      key: 'type',
      label: 'Type',
      kind: 'select',
      defaultValue: 'shoe',
      options: [
        ['shoe', 'Shoe (rests on steel below)'],
        ['hanger', 'Hanger (rod from steel above)'],
        ['guide', 'Guide (shoe with side stops)'],
        ['anchor', 'Anchor (fixed shoe)'],
      ],
    },
    {
      key: 'points',
      label: 'Points x,y,z; … (absolute)',
      kind: 'text',
      defaultValue: '',
      optional: true,
    },
    num('spacing', 'Or maximum spacing', '', true),
    txt('memberId', 'Bearing member id', '', true),
    num('maxReach', 'Max vertical reach', '', true),
  ],
  build: (values) => {
    const reader = new FieldReader(values);
    const [kind, ...rest] = reader.text('pipe').split(':');
    const target = rest.join(':');
    if (target === '' || (kind !== 'line' && kind !== 'pipe')) {
      return { ok: false, reason: 'Choose the pipe or line to support.' };
    }
    const hasPoints = reader.text('points') !== '';
    const spacing = reader.optionalNumber('spacing');
    if (hasPoints === (spacing !== undefined)) {
      return { ok: false, reason: 'Give either the support points or a maximum spacing.' };
    }
    const params: Record<string, unknown> = {
      ...(kind === 'line' ? { line: target } : { pipeId: target }),
      type: reader.text('type'),
      ...(hasPoints ? { at: reader.pointList('points', 1) } : { spacing }),
      memberId: reader.text('memberId') || undefined,
      maxReach: reader.optionalNumber('maxReach'),
    };
    if (reader.missing.length > 0)
      return { ok: false, reason: `Check: ${reader.missing.join(', ')}` };
    return {
      ok: true,
      command: 'add_pipe_support',
      params: Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)),
    };
  },
};
