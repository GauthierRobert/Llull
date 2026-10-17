/** Looking at a simulation without a screen (plot_simulation): runs simulate_motion and draws its series as an SVG chart. */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { failer, report } from '../noop';
import { RAD_PER_S_PER_RPM } from '../../dynamics/forceLaws';
import { timeSeriesSvg, type PlotPanel, type PlotSeries } from '../../dynamics/timeSeriesSvg';
import type { SimulationData } from '../../dynamics/simulationReport';
import type { ReactionsData } from '../../dynamics/reactions';
import { simulateMotion } from './simulate';

const QUANTITIES = ['joint_angle', 'joint_velocity', 'motor_torque', 'motor_power', 'reaction_force'] as const;
type Quantity = (typeof QUANTITIES)[number];

/** Points a plot asks for when sampleRate is not given. */
const DEFAULT_POINTS = 600;
const MIN_SAMPLE_RATE = 50;
const MAX_JOINT_SERIES = 12;

type RunData = SimulationData & { reactions?: ReactionsData };

const magnitudes = (vectors: readonly (readonly number[])[]): number[] => vectors.map((v) => Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0));
const scaled = (values: readonly number[], factor: number): number[] => values.map((v) => v * factor);

const limitSeries = (panel: PlotPanel): PlotPanel => ({ ...panel, series: panel.series.slice(0, MAX_JOINT_SERIES) });

/** One panel per (quantity, unit); a quantity with no data yields none. */
function panelsOf(quantity: Quantity, data: RunData, wanted: ReadonlySet<string> | null): PlotPanel[] {
  const series = data.series;
  if (series === undefined) return [];
  const keep = (id: string): boolean => wanted === null || wanted.has(id);
  const joints = Object.entries(data.joints).filter(([id]) => keep(id));
  const make = (title: string, unit: string, list: PlotSeries[]): PlotPanel[] => (list.length === 0 ? [] : [{ title, unit, series: list }]);
  const byKind = (kind: 'revolute' | 'prismatic', take: (id: string) => number[]): PlotSeries[] =>
    joints.filter(([, joint]) => joint.kind === kind).map(([id]) => ({ label: id, values: take(id) }));
  switch (quantity) {
    case 'joint_angle':
      return [
        ...make(
          'Joint angle',
          'deg',
          byKind('revolute', (id) => scaled(series.jointPosition[id] ?? [], 180 / Math.PI)),
        ),
        ...make(
          'Joint travel',
          'mm',
          byKind('prismatic', (id) => scaled(series.jointPosition[id] ?? [], 1000)),
        ),
      ];
    case 'joint_velocity':
      return [
        ...make(
          'Joint speed',
          'rpm',
          byKind('revolute', (id) => scaled(series.jointVelocity[id] ?? [], 1 / RAD_PER_S_PER_RPM)),
        ),
        ...make(
          'Joint speed',
          'm/s',
          byKind('prismatic', (id) => series.jointVelocity[id] ?? []),
        ),
      ];
    case 'motor_torque':
      return make(
        'Motor torque',
        'N·m',
        Object.entries(series.motorTorque)
          .filter(([id]) => keep(id) || keep(data.motors[id]?.joint ?? ''))
          .map(([id, values]) => ({ label: id, values })),
      );
    case 'motor_power':
      return make(
        'Motor power',
        'kW',
        Object.entries(series.motorTorque)
          .filter(([id]) => keep(id) || keep(data.motors[id]?.joint ?? ''))
          .map(([id, values]) => {
            const speed = series.jointVelocity[data.motors[id]?.joint ?? ''] ?? [];
            return { label: id, values: values.map((torque, i) => (torque * (speed[i] ?? 0)) / 1000) };
          }),
      );
    case 'reaction_force': {
      const shown = data.reactions?.series;
      if (shown === undefined) return [];
      return make('Reaction force (magnitude)', 'N', [
        ...Object.entries(shown.joints)
          .filter(([id]) => keep(id))
          .map(([id, r]) => ({ label: `${id} (joint)`, values: magnitudes(r.force) })),
        ...Object.entries(shown.loops)
          .filter(([id]) => keep(id))
          .map(([id, force]) => ({ label: `${id} (loop)`, values: magnitudes(force) })),
      ]);
    }
  }
}

/**
 * @affects nothing — read-only; returns data { svg, width, height, title, duration, samples, panels[{ title, unit, series[{ label, min, max, final }] }] }
 * @invariant deterministic: the chart is a function of the simulation, which is a function of the document and params
 * @failure no physics engine, simulation refused or failed, unknown joint in `joints`, nothing to plot for the requested quantities -> no-op with the reason
 */
export const plotSimulation = defineCommand({
  name: 'plot_simulation',
  annotations: { readOnly: true },
  description:
    'Run the physics simulation (same engine and parameters as simulate_motion) and draw the result as an SVG time-series chart, so a ' +
    'motion can be inspected without a screen. Returns data.svg (stacked panels sharing the time axis; each has a title, y axis with ' +
    'unit, grid, legend), data.width, data.panels (per series: min, max, final value, in the panel unit) and a one-line summary. ' +
    '`quantities` picks the panels: "joint_angle" (deg for revolute joints, mm for prismatic ones, from the start pose), ' +
    '"joint_velocity" (rpm / m/s), "motor_torque" (N·m), "motor_power" (kW), "reaction_force" (magnitude per tree joint and loop, N; ' +
    'runs the reaction pass, slower). `joints` restricts the series to those joint (or motor) ids. Default: joint_velocity of every ' +
    'joint. Closed loops and cylinders use the same timestep rules as simulate_motion. With the CLI, `llull plot_simulation … --save plot.png` ' +
    'rasterizes data.svg. Read-only; needs the physics engine like simulate_motion.',
  params: z.object({
    quantities: z
      .array(z.enum(QUANTITIES))
      .min(1)
      .optional()
      .describe('Panels to draw: joint_angle, joint_velocity, motor_torque, motor_power, reaction_force. Default ["joint_velocity"].'),
    joints: z
      .array(z.string())
      .optional()
      .describe('Only these joint / motor ids (reaction_force: joint or loop ids). Default every one (at most 12 joint series).'),
    duration: z.number().positive().max(600).optional().describe('Simulated seconds. Default 5.'),
    timestep: z.number().min(1e-5).max(0.01).optional().describe('Integration step in seconds; default as simulate_motion.'),
    sampleRate: z
      .number()
      .positive()
      .optional()
      .describe('Samples per second drawn. Default about 600 points over the run (never below 50 Hz).'),
    title: z.string().max(120).optional().describe('Chart title. Default "Simulation: <duration> s".'),
    width: z.number().int().min(320).max(3000).optional().describe('Chart width in px. Default 900.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = failer(doc, 'plot_simulation');
    const quantities = params.quantities ?? ['joint_velocity'];
    const duration = params.duration ?? 5;
    const wanted = params.joints === undefined ? null : new Set(params.joints);
    const known = new Set([...Object.keys(doc.dynamics?.joints ?? {}), ...Object.keys(doc.dynamics?.motors ?? {})]);
    const unknown = (params.joints ?? []).filter((id) => !known.has(id));
    if (unknown.length > 0) return fail(`unknown joint or motor id(s): ${unknown.join(', ')}`);
    const sampleRate = params.sampleRate ?? Math.max(MIN_SAMPLE_RATE, DEFAULT_POINTS / duration);
    const run = simulateMotion.run(
      doc,
      {
        duration,
        sampleRate,
        detail: 'series',
        reactions: quantities.includes('reaction_force') ? 'series' : 'off',
        ...(params.timestep !== undefined ? { timestep: params.timestep } : {}),
      },
      ctx,
    );
    if (run.data === undefined) return fail(run.summary.replace(/^simulate_motion:\s*/, 'the simulation did not run — '));
    const data = run.data as RunData;
    const panels = quantities.flatMap((quantity) => panelsOf(quantity, data, wanted)).map(limitSeries);
    if (panels.length === 0)
      return fail(`nothing to plot for ${quantities.join(', ')} (no matching joints, motors or reactions in this model)`);
    const width = params.width ?? 900;
    const title = params.title ?? `Simulation: ${duration} s`;
    const { svg, height } = timeSeriesSvg(panels, { title, width, panelHeight: 230, times: data.series?.times ?? [] });
    const stats = panels.map((panel) => ({
      title: panel.title,
      unit: panel.unit,
      series: panel.series.map((s) => ({
        label: s.label,
        min: Math.min(...s.values),
        max: Math.max(...s.values),
        final: s.values[s.values.length - 1] ?? 0,
      })),
    }));
    const lines = stats.flatMap((panel) =>
      panel.series.map(
        (s) => `${panel.title} ${s.label}: ${s.min.toPrecision(4)} to ${s.max.toPrecision(4)} ${panel.unit}, end ${s.final.toPrecision(4)}`,
      ),
    );
    return report(
      doc,
      `plot_simulation: ${panels.length} panel(s), ${data.samples} samples over ${duration} s. ${lines.join('; ')}. Save the chart with --save plot.png (rasterizes data.svg).`,
      { svg, width, height, title, duration, samples: data.samples, panels: stats },
    );
  },
});
