/** SC-VIS-04 (VC-VIS-12 / 13 / 14): the model-review plan of the validation pack, replayed command by command against its expected values. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';

interface Action {
  command: string;
  params: Record<string, unknown>;
  as?: string;
}
const plan = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'docs/plant/09-plant-visualization-review/validation/plans/sc-vis-04-section-box-markup-issue.json'),
    'utf8',
  ),
) as { actions: Action[] };

const resolveAliases = (value: unknown, aliases: Record<string, string>): unknown => {
  if (typeof value === 'string' && value.startsWith('$')) return aliases[value.slice(1)] ?? value;
  if (Array.isArray(value)) return value.map((item) => resolveAliases(item, aliases));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveAliases(item, aliases)]));
  return value;
};

function replay(): { results: CommandResult[]; aliases: Record<string, string>; document: CadDocument } {
  let document = createEmptyDocument();
  const aliases: Record<string, string> = {};
  const results: CommandResult[] = [];
  for (const action of plan.actions) {
    const result = execute(document, action.command, resolveAliases(action.params, aliases) as Record<string, unknown>);
    results.push(result);
    document = result.document;
    const created = result.affected[0];
    if (action.as !== undefined && created !== undefined) aliases[action.as] = created;
  }
  return { results, aliases, document };
}

const rows = (result: CommandResult | undefined, code: string): { ids: string[] }[] =>
  (result?.data as { issues: { code: string; ids: string[] }[] }).issues.filter((row) => row.code === code);

describe('SC-VIS-04', () => {
  const { results, aliases } = replay();

  it('classifies the skid, the pipe and the far box exactly (step 9)', () => {
    expect(results[9]?.data).toMatchObject({ inside: [aliases['skid']], crossing: [aliases['pipe']], outside: [aliases['far']] });
  });

  it('reports the issue citing the deleted skid, no stale viewpoint and one open issue (step 11)', () => {
    expect(rows(results[11], 'VIS_VIEWPOINT_STALE')).toHaveLength(0);
    expect(rows(results[11], 'VIS_ISSUE_ENTITY_MISSING').map((row) => row.ids)).toEqual([[aliases['issue']]]);
    expect(rows(results[11], 'VIS_ISSUE_OPEN')).toHaveLength(1);
  });

  it('resolved is awaiting approval, not open (step 13)', () => {
    expect(rows(results[13], 'VIS_ISSUE_OPEN')).toHaveLength(0);
    expect(rows(results[13], 'VIS_ISSUE_AWAITING_APPROVAL').map((row) => row.ids)).toEqual([[aliases['issue']]]);
  });

  it('refuses the agent closing the issue (step 14)', () => {
    expect(results[14]?.error?.code).toBe('VIS_HUMAN_GATE');
  });

  it('ran every other step without an error', () => {
    expect(results.filter((result, index) => index !== 14 && result.error !== undefined)).toEqual([]);
  });
});
