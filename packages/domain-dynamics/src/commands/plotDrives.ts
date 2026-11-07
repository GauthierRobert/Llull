/** The drive quantities of plot_simulation (PHY-23 DRV-M3): motor current / voltage / winding temperature panels, the operating-point chart and the ledger bars. */

import type { DynamicsModel } from '@core/model/dynamics';
import type { PlotPanel } from '@lib/timeSeriesSvg';
import { windingTemperatureSeries, thermalParams } from '../sim/actuators/thermal';
import { barChart, xyChart, type Chart, type XySeries } from '../sim/driveCharts';
import type { RunData } from '../sim/runData';

export const DRIVE_PANEL_QUANTITIES = ['motor_current', 'motor_voltage', 'winding_temperature'] as const;
export const DRIVE_CHART_QUANTITIES = ['operating_points', 'energy_ledger'] as const;
type DrivePanelQuantity = (typeof DRIVE_PANEL_QUANTITIES)[number];
type DriveChartQuantity = (typeof DRIVE_CHART_QUANTITIES)[number];

export const isDrivePanel = (quantity: string): quantity is DrivePanelQuantity =>
  (DRIVE_PANEL_QUANTITIES as readonly string[]).includes(quantity);
export const isDriveChart = (quantity: string): quantity is DriveChartQuantity =>
  (DRIVE_CHART_QUANTITIES as readonly string[]).includes(quantity);

/** Driven datasheet motors of the run that the `joints` filter keeps (a motor id or its joint id). */
function drivenMotors(
  data: RunData,
  dynamics: DynamicsModel,
  wanted: ReadonlySet<string> | null,
): [string, NonNullable<RunData['drives']>[string]][] {
  return Object.entries(data.drives ?? {}).filter(
    ([id, drive]) => drive.series !== undefined && (wanted === null || wanted.has(id) || wanted.has(dynamics.motors[id]?.joint ?? '')),
  );
}

/** One time-series panel per quantity: the current (A), the terminal voltage (V) or the winding temperature (C, from the thermal network) of each driven motor. */
export function drivePanels(
  quantity: DrivePanelQuantity,
  data: RunData,
  dynamics: DynamicsModel,
  wanted: ReadonlySet<string> | null,
  ambientC: number,
): PlotPanel[] {
  const motors = drivenMotors(data, dynamics, wanted);
  if (quantity === 'winding_temperature') {
    const series = motors.flatMap(([id, drive]) => {
      const motor = dynamics.motors[id];
      const network = motor?.kind === 'dc' ? thermalParams(motor.datasheet) : null;
      if (drive.series === undefined || network === null) return [];
      return [{ label: id, values: windingTemperatureSeries(network, drive.series.times, drive.series.currentA, ambientC).windingC }];
    });
    return series.length === 0 ? [] : [{ title: 'Winding temperature', unit: 'C', series }];
  }
  const [title, unit] = quantity === 'motor_current' ? ['Motor current', 'A'] : ['Terminal voltage', 'V'];
  const series = motors.flatMap(([id, drive]) =>
    drive.series === undefined ? [] : [{ label: id, values: quantity === 'motor_current' ? drive.series.currentA : drive.series.voltageV }],
  );
  return series.length === 0 ? [] : [{ title, unit, series }];
}

/** The chart of a non-time-series quantity, or null when the run has nothing for it. */
export function driveChart(
  quantity: DriveChartQuantity,
  data: RunData,
  dynamics: DynamicsModel,
  wanted: ReadonlySet<string> | null,
  width: number,
): Chart | null {
  if (quantity === 'energy_ledger') {
    const entries = data.ledger?.entries;
    return entries === undefined
      ? null
      : barChart(
          'Energy ledger',
          'J',
          entries.map((entry) => ({ label: `${entry.element} (${entry.kind})`, value: entry.joules })),
          width,
        );
  }
  const motors = drivenMotors(data, dynamics, wanted);
  const series: XySeries[] = [];
  for (const [id, drive] of motors) {
    const motor = dynamics.motors[id];
    if (drive.series === undefined || motor?.kind !== 'dc') continue;
    series.push({ label: `${id} operating points`, xs: drive.series.shaftSpeedRpm, ys: drive.series.shaftTorqueNm, style: 'dots' });
    const sheet = motor.datasheet;
    const noLoadRpm = (sheet.nominalVoltageV / sheet.torqueConstantNmPerA) * (30 / Math.PI);
    const stall = (sheet.torqueConstantNmPerA * sheet.nominalVoltageV) / sheet.terminalResistanceOhm;
    series.push({ label: `${id} torque-speed line (U nominal)`, xs: [0, noLoadRpm], ys: [stall, 0], style: 'line' });
    const peak = sheet.peakCurrentA === undefined ? stall : sheet.torqueConstantNmPerA * sheet.peakCurrentA;
    series.push({ label: `${id} peak torque`, xs: [0, noLoadRpm], ys: [peak, peak], style: 'line' });
    if (sheet.nominalCurrentA !== undefined) {
      const continuous = sheet.torqueConstantNmPerA * sheet.nominalCurrentA;
      series.push({ label: `${id} continuous torque`, xs: [0, noLoadRpm], ys: [continuous, continuous], style: 'line' });
    }
  }
  return series.length === 0 ? null : xyChart('Operating points', 'shaft speed (rpm)', 'shaft torque (N·m)', series, width);
}
