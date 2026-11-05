import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SKIP_RUN_ENV, requireTool, requireTools, skipRoot, toolFamily } from '../../requireTool';
import { requiredFamilies, summarize } from '../../requireToolTeardown';

const run = `unit-${process.pid}-${Date.now()}`;
const directory = join(skipRoot(), run);

afterEach(() => {
  delete process.env[SKIP_RUN_ENV];
  rmSync(directory, { recursive: true, force: true });
});

const recorded = (): Array<{ tool: string; family: string }> =>
  readdirSync(directory).flatMap((file) =>
    readFileSync(join(directory, file), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { tool: string; family: string }),
  );

describe('requireTool (TR-INT-13)', () => {
  it('returns false and records nothing when the tool is available', () => {
    process.env[SKIP_RUN_ENV] = run;
    expect(requireTool('calculix', true)).toBe(false);
    expect(() => readdirSync(directory)).toThrow();
  });

  it('returns the skip condition and records the tool and its family when it is missing', () => {
    process.env[SKIP_RUN_ENV] = run;
    expect(requireTool('native:llull-kernel', false)).toBe(true);
    expect(
      requireTools([
        ['python', false],
        ['calculix', true],
        ['oracle:xmllint', false],
      ]),
    ).toBe(true);
    expect(recorded()).toEqual([
      { tool: 'native:llull-kernel', family: 'native' },
      { tool: 'python', family: 'python' },
      { tool: 'oracle:xmllint', family: 'oracle' },
    ]);
    expect(toolFamily('native:llull-mesh')).toBe('native');
  });

  it('prints the skipped-by-tool counts and passes when no skipped tool is required', () => {
    const result = summarize([{ tool: 'calculix', family: 'calculix' }], requiredFamilies(undefined));
    expect(result).toEqual({ line: 'skipped by tool: calculix 1, python 0, native 0', failure: null });
  });

  it('fails with TST_REQUIRED_TOOL_SKIPPED when a required tool caused a skip', () => {
    const records = [
      { tool: 'calculix', family: 'calculix' },
      { tool: 'native:llull-mesh', family: 'native' },
    ] as const;
    const result = summarize(records, requiredFamilies('calculix, python'));
    expect(result.failure).toContain('TST_REQUIRED_TOOL_SKIPPED');
    expect(result.failure).toContain('calculix');
    expect(result.failure).not.toContain('llull-mesh');
    expect(summarize(records, requiredFamilies('python')).failure).toBeNull();
    expect(summarize(records, requiredFamilies('calculix,python,native')).failure).toContain('llull-mesh');
  });
});
