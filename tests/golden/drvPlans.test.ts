/**
 * Golden pins of the PHY-23 validation plans (docs/physics/23-drives-physical-truth/validation/plans): the normalized document (ids, dynamics records, history
 * length), the numbers of every analysis step (sizing, truth verdict, ledger) and the hashes of the recorded series, tied to the MuJoCo version that produced
 * them (TR-DRV-27: deterministic code, series hashes per engine version). Replaying a plan on a fresh document gives the identical document.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createEmptyDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { hashText } from '@lib/hash';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { normalize } from './normalize';

let engineName = '';
beforeAll(async () => {
  const engine = await createMujocoPhysics();
  engineName = engine.name;
  setPhysicsEngine(engine);
});
afterAll(() => setPhysicsEngine(null));

interface Step {
  index: number;
  command: string;
  ok: boolean;
  summary: string;
  affected: string[];
  data?: unknown;
}
interface Plan {
  actions: unknown[];
  steps: Step[];
  document: ReturnType<typeof createEmptyDocument>;
}

const PLANS = 'docs/physics/23-drives-physical-truth/validation/plans';

function run(name: string): Plan {
  const actions = JSON.parse(readFileSync(`${PLANS}/${name}.plan.json`, 'utf8')) as unknown[];
  const result = execute(createEmptyDocument(), 'build_project', { actions });
  const data = result.data as { ok: boolean; steps: Step[] };
  expect(data.steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
  return { actions, steps: data.steps, document: result.document };
}

/** A recorded series pinned by its hash at 6 significant digits (the engine's last bits are not the pin). */
const seriesHash = (values: readonly number[]): string => hashText(canonicalJson(values.map((value) => Number(value.toPrecision(6)))));
const six = (value: number): number => Number(value.toPrecision(6));
const sixAll = (record: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, six(value)]));
const stepData = <T>(plan: Plan, command: string, index = 0): T => plan.steps.filter((step) => step.command === command)[index]?.data as T;

interface SimData {
  engine: string;
  timestep: number;
  samples: number;
  series: { times: number[]; jointVelocity: Record<string, number[]>; jointPosition: Record<string, number[]> };
  drives?: Record<
    string,
    { peak: Record<string, number>; rms: Record<string, number>; series: { currentA: number[]; voltageV: number[] } }
  >;
  ledger?: { closureRelative: number; closure: string; entries: { element: string; kind: string; joules: number }[] };
}

const simPin = (data: SimData): unknown => ({
  engine: data.engine,
  timestep: data.timestep,
  samples: data.samples,
  velocities: Object.fromEntries(Object.entries(data.series.jointVelocity).map(([id, values]) => [id, seriesHash(values)])),
  positions: Object.fromEntries(Object.entries(data.series.jointPosition).map(([id, values]) => [id, seriesHash(values)])),
  ...(data.drives === undefined
    ? {}
    : {
        drives: Object.fromEntries(
          Object.entries(data.drives).map(([id, drive]) => [
            id,
            {
              peak: sixAll(drive.peak),
              rms: sixAll(drive.rms),
              current: seriesHash(drive.series.currentA),
              voltage: seriesHash(drive.series.voltageV),
            },
          ]),
        ),
      }),
  ...(data.ledger === undefined
    ? {}
    : {
        ledger: {
          closure: data.ledger.closure,
          closureRelative: six(data.ledger.closureRelative),
          entries: data.ledger.entries.map((entry) => [entry.element, entry.kind, six(entry.joules)]),
        },
      }),
});

describe('PHY-23 validation plans, golden', () => {
  it('the plans were produced by MuJoCo 3.16 (the pins are per engine version)', () => {
    expect(engineName).toMatch(/MuJoCo 3\.16\./);
  });

  it('drv_maxon_step: the document and the 30 ms run (VC-DRV-01, 04, 05)', () => {
    const plan = run('drv_maxon_step');
    expect(normalize(plan.document)).toMatchSnapshot('document');
    expect({
      ...(simPin(stepData<SimData>(plan, 'simulate_motion')) as object),
      checks: stepData<{ consistent: boolean; maxGap: number }>(plan, 'check_motor_data'),
    }).toMatchSnapshot('run');
  }, 120_000);

  it('drv_lead_screw: the document and the 0.2 s lift (VC-DRV-13)', () => {
    const plan = run('drv_lead_screw');
    expect(normalize(plan.document)).toMatchSnapshot('document');
    expect(simPin(stepData<SimData>(plan, 'simulate_motion'))).toMatchSnapshot('run');
  }, 120_000);

  it('drv_stick_slip: the document and the 3 s limit cycle (VC-DRV-18)', () => {
    const plan = run('drv_stick_slip');
    expect(normalize(plan.document)).toMatchSnapshot('document');
    expect(simPin(stepData<SimData>(plan, 'simulate_motion'))).toMatchSnapshot('run');
  }, 120_000);

  it('drv_servo_sizing: the document, the 5 s run, size_drive with its ratio sweep and check_motion_truth (VC-DRV-34, 37, 38)', () => {
    const plan = run('drv_servo_sizing');
    expect(normalize(plan.document)).toMatchSnapshot('document');
    expect(simPin(stepData<SimData>(plan, 'simulate_motion'))).toMatchSnapshot('run');
    const sizing = stepData<{
      verdict: string;
      limiting: { factor: string; margin: number };
      demand: Record<string, number>;
      findings: { code: string; status: string }[];
      sweep: { best: { reduction: number }; inertiaMatchedRatio: number; rows: { reduction: number; peakShaftTorqueNm: number }[] };
      ledger: { closure: string; regeneratedJ: number; transmissionLossJ: number };
    }>(plan, 'size_drive');
    expect({
      verdict: sizing.verdict,
      limiting: { factor: sizing.limiting.factor, margin: six(sizing.limiting.margin) },
      demand: Object.fromEntries(Object.entries(sizing.demand).map(([key, value]) => [key, six(value)])),
      findings: sizing.findings.map((finding) => `${finding.code}:${finding.status}`),
      best: sizing.sweep.best.reduction,
      matched: six(sizing.sweep.inertiaMatchedRatio),
      sweep: sizing.sweep.rows.map((row) => [row.reduction, six(row.peakShaftTorqueNm)]),
      ledger: {
        closure: sizing.ledger.closure,
        regeneratedJ: six(sizing.ledger.regeneratedJ),
        transmissionLossJ: six(sizing.ledger.transmissionLossJ),
      },
    }).toMatchSnapshot('size_drive');
    const truth = stepData<{ verdict: string; items: { code: string; status: string; ids: string[] }[]; study: { steps: number[] } }>(
      plan,
      'check_motion_truth',
    );
    expect({
      verdict: truth.verdict,
      steps: truth.study.steps,
      items: truth.items.map((item) => `${item.code}:${item.status}:${item.ids.join('+')}`),
    }).toMatchSnapshot('check_motion_truth');
  }, 600_000);

  it('replaying a plan on a fresh document gives the identical document, byte for byte (VC-DRV-35)', () => {
    const [first, second] = [run('drv_lead_screw'), run('drv_lead_screw')];
    expect(serializeDocument(second.document)).toBe(serializeDocument(first.document));
    // the recorded series are bit-identical too (same engine version)
    expect(stepData<SimData>(second, 'simulate_motion').series).toEqual(stepData<SimData>(first, 'simulate_motion').series);
  }, 120_000);
});
