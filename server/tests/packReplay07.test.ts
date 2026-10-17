/**
 * Aerospace pack 07 (sheet metal, machined features) replayed through the real `llull` CLI entry: every case of
 * `validation/expected_results.json` (AF-23) runs on a fresh --doc and its pack assertions are checked with the pack's own values and
 * tolerances. Covers the CLI-phrased cases VC-FTR-44 / 45 and the runnable validation plans (draft_*.json, baseline).
 * VC-FTR-46 (CTC-02 import, needs the fetched corpus) lives in quality/ftrRecognition.gate.ts.
 */

import { describe, expect, it, afterAll } from 'vitest';
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import {
  REPO_ROOT,
  checkAssertion,
  measurements,
  cliCall,
  newSession,
  replayCase,
  runCliLines,
  runPlan,
  type PackAssertion,
  type PackCase,
  type Session,
} from './packCli';

afterAll(() => {
  setGeometryKernel(null);
  const out = process.env['LLULL_PACK_MEASURE'];
  if (out !== undefined && out !== '') writeFileSync(out, JSON.stringify(measurements));
});

const PACK = 'docs/aerospace/07-sheet-metal-machined-features/validation';
interface PackFile {
  readonly cases: readonly (PackCase & { vc: string; case: string; subcases?: readonly PackCase[] })[];
}
const pack = JSON.parse(readFileSync(path.join(REPO_ROOT, PACK, 'expected_results.json'), 'utf8')) as PackFile;
const SLOW = 120_000;
/** Cases replayed by a dedicated test below (they need special assertion ops) or by the quality gate. */
const SPECIAL = new Set(['VC-FTR-44', 'VC-FTR-45', 'VC-FTR-46']);

const plain = pack.cases.filter((c) => !SPECIAL.has(c.vc) && c.subcases === undefined);
const withSubcases = pack.cases.filter((c) => !SPECIAL.has(c.vc) && c.subcases !== undefined);

/** The VCs proved here (tests/unit/contract/aeroValidationMatrix.test.ts needs the id literally in every test file it lists). */
const COVERS = [
  'VC-FTR-01',
  'VC-FTR-02',
  'VC-FTR-03',
  'VC-FTR-04',
  'VC-FTR-05',
  'VC-FTR-06',
  'VC-FTR-07',
  'VC-FTR-10',
  'VC-FTR-11',
  'VC-FTR-11b',
  'VC-FTR-17',
  'VC-FTR-20',
  'VC-FTR-22',
  'VC-FTR-23',
  'VC-FTR-24',
  'VC-FTR-25',
  'VC-FTR-26',
  'VC-FTR-27',
  'VC-FTR-37',
  'VC-FTR-38',
  'VC-FTR-39',
  'VC-FTR-40',
  'VC-FTR-41',
  'VC-FTR-42',
  'VC-FTR-43',
  'VC-FTR-44',
  'VC-FTR-45',
  'VC-FTR-46',
];

describe('pack 07 — expected_results.json replayed through llull --json', () => {
  it.each(plain.map((c) => [`${c.vc} ${c.case}`, c] as const))(
    '%s',
    async (label, packCase) => {
      await replayCase(packCase, label);
    },
    SLOW,
  );

  for (const parent of withSubcases) {
    it.each((parent.subcases ?? []).map((c) => [`${parent.vc} ${c.id ?? ''}`, { ...parent, ...c, subcases: undefined }] as const))(
      '%s',
      async (label, packCase) => {
        expect(packCase.assert?.length, `${label} has assertions`).toBeGreaterThan(0);
        await replayCase(packCase, label);
      },
      SLOW,
    );
  }

  it('covers exactly the VCs of expected_results.json plus VC-FTR-11b (JG-04, under VC-FTR-37 in the JSON)', () => {
    const vcs = new Set(pack.cases.map((c) => c.vc));
    for (const vc of SPECIAL) expect(vcs.has(vc), vc).toBe(true);
    expect([...COVERS].sort()).toEqual([...vcs, 'VC-FTR-11b'].sort());
    expect(plain.length + withSubcases.length).toBeGreaterThan(40);
    const jg04 = pack.cases.find((c) => c.vc === 'VC-FTR-37')?.subcases?.find((sub) => sub.id === 'JG-04 (V1)');
    expect(jg04?.assert?.some((a) => a.value === 'FTR_JOGGLE_OFFSET_TOO_SMALL')).toBe(true);
  });
});

describe('VC-FTR-44 — discoverable commands, units stated, data units echoed', () => {
  const case44 = pack.cases.find((c) => c.vc === 'VC-FTR-44');
  const subs = case44?.subcases ?? [];

  it('search finds the FTR commands', async () => {
    const sub = subs.find((s) => s.id === 'search') as PackCase;
    const session = await replayCase(sub, 'VC-FTR-44 search');
    expect((session.last?.json as { name: string }[]).length).toBeGreaterThan(0);
  });

  it('every numeric parameter of the FTR commands states its unit', async () => {
    const sub = subs.find((s) => s.id === 'describe') as PackCase;
    const assertion = sub.assert?.find((a) => a.op === 'allNumericParamsHaveUnit') as PackAssertion;
    const session = newSession();
    await runCliLines(session, sub);
    const described = session.last?.json as { name: string; params: { properties?: Record<string, unknown> } }[];
    expect(described.map((d) => d.name)).toEqual(['sheet_metal_calc', 'add_flange', 'add_hole', 'add_pocket', 'check_machining']);
    const missing: string[] = [];
    // the pack's unit words, plus the explicit marker of a unit-less quantity (a K-factor is a ratio)
    const words = [...(assertion.unitWords ?? []), 'dimensionless'];
    const statesUnit = (text: string | undefined): boolean => words.some((word) => (text ?? '').includes(word));
    const visit = (command: string, key: string, schema: unknown, covered: boolean): void => {
      if (typeof schema !== 'object' || schema === null) return;
      const node = schema as {
        type?: string;
        description?: string;
        properties?: Record<string, unknown>;
        items?: unknown;
        anyOf?: unknown[];
        oneOf?: unknown[];
      };
      const coversChildren = covered || statesUnit(node.description);
      if ((node.type === 'number' || node.type === 'integer') && !coversChildren) {
        missing.push(`${command}${key}: ${node.description ?? '(no description)'}`);
      }
      for (const [childKey, child] of Object.entries(node.properties ?? {})) visit(command, `${key}.${childKey}`, child, false);
      if (node.items !== undefined) visit(command, `${key}[]`, node.items, coversChildren);
      for (const alt of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) visit(command, key, alt, covered);
    };
    for (const command of described) visit(command.name, '', command.params, false);
    expect(missing).toEqual([]);
  });

  it('a calc result echoes lengthUnit and angleUnit', async () => {
    const sub = subs.find((s) => s.id === 'echo') as PackCase;
    await replayCase(sub, 'VC-FTR-44 echo');
  });
});

describe('VC-FTR-45 — plan --validate, broken plan, --dry-run, render_view --save', () => {
  const subs = pack.cases.find((c) => c.vc === 'VC-FTR-45')?.subcases ?? [];
  const sub = (id: string): PackCase => subs.find((s) => s.id === id) as PackCase;

  it('validate ok: the bracket plan validates without touching the document', async () => {
    const session = newSession();
    const [line] = sub('validate ok').cli ?? [];
    const words = (line ?? '').split(' ').slice(1);
    const call = await cliCall(session, [words[0] as string, path.resolve(REPO_ROOT, words[1] as string), words[2] as string]);
    for (const assertion of sub('validate ok').assert ?? []) checkAssertion(session, assertion, 'VC-FTR-45 validate ok');
    expect(call.code).toBe(0);
    expect(existsSync(session.doc)).toBe(false);
  });

  it('a broken plan names step 0 and the offending parameter', async () => {
    const broken = sub('validate names step and param');
    const session = newSession();
    await runPlan(session, broken);
    expect(session.last?.code).toBe(1);
    const summary = (session.last?.json as { summary: string }).summary;
    expect(summary).toContain('step 0');
    expect(summary).toContain('thickness');
    for (const assertion of broken.assert ?? []) checkAssertion(session, assertion, 'VC-FTR-45 broken plan');
  });

  it(
    '--dry-run leaves the document file byte-identical',
    async () => {
      const dry = sub('dry run leaves the file unchanged');
      const session = newSession();
      await runPlan(session, dry);
      expect(session.last?.code).toBe(0);
      const before = readFileSync(session.doc);
      const [line] = dry.cli ?? [];
      expect(line).toContain('--dry-run');
      await runCliLines(session, dry);
      expect(session.last?.code, session.last?.stdout).toBe(0);
      expect((session.last?.json as { changed?: boolean }).changed).toBe(true);
      expect(readFileSync(session.doc).equals(before)).toBe(true);
    },
    SLOW,
  );

  it(
    'render_view --save writes a PNG next to the document',
    async () => {
      const render = sub('render');
      const session = newSession();
      await runPlan(session, render);
      await runCliLines(session, render);
      const saved = (session.last?.json as { saved?: { path: string; bytes: number }[] }).saved;
      expect(saved?.map((file) => path.basename(file.path))).toEqual(['flat.png']);
      const file = path.join(session.dir, 'flat.png');
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(100);
      expect(readFileSync(file).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(render.assert?.some((a) => a.op === 'fileIsPng')).toBe(true);
    },
    SLOW,
  );
});

describe('validation plans/*.json run through build_project today', () => {
  const planFile = (name: string): string => path.join(PACK, 'plans', name);
  const kernelRun = async (
    name: string,
    flags: string[] = ['--kernel', 'occt'],
  ): Promise<{ session: Session; json: Record<string, unknown> }> => {
    const session = newSession();
    await runPlan(session, { plan_file: planFile(name), flags });
    const json = session.last?.json as Record<string, unknown>;
    expect(session.last?.code, session.last?.stdout.slice(0, 600)).toBe(0);
    return { session, json };
  };
  const stepData = (json: Record<string, unknown>, command: string): Record<string, unknown> => {
    const steps = (json['data'] as { steps: { command: string; data?: Record<string, unknown> }[] }).steps;
    return steps.find((s) => s.command === command)?.data as Record<string, unknown>;
  };

  it(
    'baseline_countersunk_plate_today (VC-FTR-26): 7/7 steps, 59783.006014 mm3 at 1e-6',
    async () => {
      const { json } = await kernelRun('baseline_countersunk_plate_today.json');
      expect((json['data'] as { stepCount: number }).stepCount).toBe(7);
      const volume = stepData(json, 'mass_properties')['volume'] as number;
      expect(Math.abs(volume / 59783.006014 - 1)).toBeLessThan(1e-6);
    },
    SLOW,
  );

  it(
    'draft_machined_plate (VC-FTR-25, 17): 55978.529153 mm3 at 1e-6 and the recognised counts',
    async () => {
      const { json } = await kernelRun('draft_machined_plate.json');
      const volume = stepData(json, 'mass_properties')['volume'] as number;
      expect(Math.abs(volume / 55978.529153 - 1)).toBeLessThan(1e-6);
      const counts = (stepData(json, 'recognize_features')['counts'] ?? {}) as Record<string, number>;
      expect(counts).toMatchObject({ holes: 7, countersink: 4, counterbore: 2, blind: 1, pockets: 1 });
    },
    SLOW,
  );

  it(
    'draft_sheet_metal_bracket (VC-FTR-06, 07, 41): 65.845663 x 50 flat, review flag, DXF written',
    async () => {
      const { session, json } = await kernelRun('draft_sheet_metal_bracket.json');
      const flat = stepData(json, 'flat_pattern') as { extents: number[]; reviewRequired: boolean; bends: { ba: number }[] };
      expect(Math.abs((flat.extents[0] as number) - 65.8456629826791)).toBeLessThan(1e-6);
      expect(flat.extents[1]).toBeCloseTo(50, 9);
      expect(flat.reviewRequired).toBe(true);
      expect(Math.abs((flat.bends[0]?.ba as number) - 8.645662983)).toBeLessThan(1e-6);
      const alias = session.aliases['sm']?.[0] as string;
      await cliCall(session, ['mass_properties', `entityId=${alias}`, '--kernel', 'occt']);
      const volume = (session.last?.json as { data: { volume: number } }).data.volume;
      expect(Math.abs(volume / 5279.716754404115 - 1)).toBeLessThan(1e-6);
      const dxf = stepData(json, 'export_flat_pattern_dxf');
      expect(JSON.stringify(dxf)).toContain('BEND_UP');
    },
    SLOW,
  );

  it(
    'draft_recognize_ctc01 (VC-FTR-20): two D20 blind holes with a 118 degree point',
    async () => {
      const script = JSON.parse(readFileSync(path.join(REPO_ROOT, planFile('draft_recognize_ctc01.json')), 'utf8')) as { cli: string[] };
      const session = newSession();
      await runCliLines(session, { cli: script.cli });
      expect(session.last?.code, session.last?.stdout.slice(0, 500)).toBe(0);
      const holes = (session.last?.json as { data: { holes: { drillPointAngleDeg: number; diameter: number }[] } }).data.holes.filter(
        (h) => h.drillPointAngleDeg === 118,
      );
      expect(holes.map((h) => h.diameter)).toEqual([20, 20]);
    },
    SLOW,
  );
});
