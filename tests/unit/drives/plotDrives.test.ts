/** plot_simulation drive quantities (PHY-23 DRV-M3): current, voltage, winding temperature, operating points and the energy ledger. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { servoSizingDoc } from './sizingFixtures';
import { IDEAL_SHEET, inertiaBench, type DriveSeriesData } from './fixtures';

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));

interface Plot {
  svg: string;
  width: number;
  height: number;
  panels: { title: string; unit: string; series: { label: string; min: number; max: number; final: number }[] }[];
  charts: number;
}
const plotOf = (result: ReturnType<typeof execute>): Plot => result.data as Plot;

describe('plot_simulation drive quantities', () => {
  let doc: CadDocument;
  beforeAll(() => {
    doc = servoSizingDoc();
  });

  it('current, voltage and winding temperature are panels of the motor in the datasheet units; the values are the run series', () => {
    const result = execute(doc, 'plot_simulation', {
      quantities: ['motor_current', 'motor_voltage', 'winding_temperature'],
      duration: 1,
      timestep: 1e-4,
      sampleRate: 1000,
    });
    const plot = plotOf(result);
    expect(plot.panels.map((panel) => `${panel.title} ${panel.unit}`)).toEqual([
      'Motor current A',
      'Terminal voltage V',
      'Winding temperature C',
    ]);
    const run = execute(doc, 'simulate_motion', { duration: 1, timestep: 1e-4, sampleRate: 1000, detail: 'drives', energy: true });
    const series = (run.data as { drives: { m_re40: { series: DriveSeriesData } } }).drives.m_re40.series;
    expect(plot.panels[0]?.series[0]).toMatchObject({
      label: 'm_re40',
      max: Math.max(...series.currentA),
      min: Math.min(...series.currentA),
    });
    expect(plot.panels[1]?.series[0]?.max).toBe(Math.max(...series.voltageV));
    // the winding starts at the ambient (25 C) and heats: the final value is above it and below the limit
    const winding = plot.panels[2]?.series[0];
    expect(winding?.min).toBe(25);
    expect(winding?.final ?? 0).toBeGreaterThan(25);
    expect(winding?.final ?? 1000).toBeLessThan(155);
    expect(plot.svg).toContain('Motor current (A)');
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
  });

  it('the ambient moves the winding curve one for one (alpha-free start: +20 K at the start)', () => {
    const cold = plotOf(
      execute(doc, 'plot_simulation', { quantities: ['winding_temperature'], duration: 0.5, timestep: 1e-4, sampleRate: 500, ambientC: 5 }),
    );
    expect(cold.panels[0]?.series[0]?.min).toBe(5);
  });

  it('operating_points and energy_ledger are charts under the same svg: torque-speed limits with the samples, and one bar per ledger entry', () => {
    const result = execute(doc, 'plot_simulation', {
      quantities: ['joint_velocity', 'operating_points', 'energy_ledger'],
      duration: 1,
      timestep: 1e-4,
      sampleRate: 500,
    });
    const plot = plotOf(result);
    expect(plot.charts).toBe(2);
    expect(plot.svg).toContain('Operating points');
    expect(plot.svg).toContain('m_re40 operating points');
    expect(plot.svg).toContain('m_re40 continuous torque');
    expect(plot.svg).toContain('m_re40 peak torque');
    expect(plot.svg).toContain('Energy ledger (J)');
    expect(plot.svg).toContain('m_re40 (copper)');
    expect(plot.svg).toContain('transmission:tr_gear (transmission_loss)');
    expect(plot.svg.startsWith('<svg')).toBe(true);
    expect(plot.svg.match(/<svg/g)).toHaveLength(1);
    expect(result.summary).toMatch(/1 panel\(s\) and 2 chart\(s\)/);
  });

  it('a chart alone is the whole svg, and the plot is deterministic', () => {
    const params = { quantities: ['operating_points'], duration: 0.3, timestep: 1e-4, sampleRate: 500 };
    const [first, second] = [plotOf(execute(doc, 'plot_simulation', params)), plotOf(execute(doc, 'plot_simulation', params))];
    expect(first.panels).toEqual([]);
    expect(first.svg).toBe(second.svg);
    expect(first.height).toBe(340);
  });

  it('nothing to draw is a no-op with the reason: a model without a datasheet drive, a motor without thermal data (winding only)', () => {
    const open = inertiaBench(1e-3, { sheet: { ...IDEAL_SHEET } });
    const none = execute(open, 'plot_simulation', { quantities: ['motor_current'], duration: 0.05 });
    expect(none.summary).toMatch(/nothing to plot for motor_current/);
    expect(none.document).toBe(open);
    const bare = inertiaBench(1e-3, { sheet: { ...IDEAL_SHEET } }, [
      {
        command: 'add_motion_profile',
        params: { id: 'hold', quantity: 'torque', unit: 'N*m', start: 0.05, segments: [{ kind: 'dwell', duration: 0.1 }] },
      },
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 'hold' } },
    ]);
    const noThermal = execute(bare, 'plot_simulation', { quantities: ['winding_temperature'], duration: 0.05 });
    expect(noThermal.summary).toMatch(/nothing to plot for winding_temperature/);
    const ledgerOnly = plotOf(execute(bare, 'plot_simulation', { quantities: ['energy_ledger'], duration: 0.05 }));
    expect(ledgerOnly.charts).toBe(1);
  });

  it('the motion quantities still draw as before (joint angle of the load)', () => {
    const plot = plotOf(
      execute(doc, 'plot_simulation', { quantities: ['joint_angle'], duration: 0.5, joints: ['j_load'], timestep: 1e-4 }),
    );
    expect(plot.panels.map((panel) => panel.title)).toEqual(['Joint angle']);
    expect(plot.charts).toBe(0);
  });
});
