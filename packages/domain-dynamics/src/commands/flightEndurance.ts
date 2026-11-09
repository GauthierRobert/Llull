/** Steady-load endurance of a powertrain (13 FLT M3): estimate_endurance. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { failer, report } from '@core/commands/noop';
import { constantLoadEndurance } from '../flight/endurance';
import { flightOf } from '../flight/model';
import { compilePower, type MotorLoad } from '../flight/powerBlock';
import { motorPoint } from '../flight/powerChain';
import { compileRotor, rotorOutput, staticCoefficients } from '../flight/rotorLaw';

const format = (value: number): string => (Number.isFinite(value) ? value.toPrecision(4) : String(value));

const AT_REST = { position: [0, 0, 0], orientation: [1, 0, 0, 0], linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] } as const;

/**
 * @affects nothing — read-only; data { rotors[], bus, hover, endurance, capacityOverCurrentS }
 * @invariant deterministic; the same pack and motor laws as run_flight (flight/powerChain); rotors at J = 0 (static / hover), speeds fixed over the discharge
 * @failure unknown powertrain, both `rpm` and `totalThrustN`, a rotor without static thrust under `totalThrustN` -> no-op with the reason
 */
export const estimateEnduranceCommand = defineCommand({
  name: 'estimate_endurance',
  annotations: { readOnly: true },
  description:
    'Endurance of a powertrain (add_flight_powertrain) holding its rotors at fixed speed in hover (advance ratio 0), without flying (13 FLT, FR-FLT-06): ' +
    'per rotor the rotor law gives thrust, shaft torque and power, the DC motor law the current and terminal voltage, then the pack is discharged along ' +
    'its OCV(SoC) curve with its internal resistance (voltage sag, current rising as the pack sags) until the low-voltage cut-off, an empty pack, a pack that ' +
    'cannot deliver the power, or a motor voltage above the pack voltage. Speeds: `rpm` for every rotor, or `totalThrustN` (e.g. the vehicle weight m·g in N) ' +
    "shared equally over the powertrain's rotors with their static thrust coefficient, else each rotor's own rpm. data: rotors[] { id, rpm, thrustN, " +
    'shaftPowerW, torqueNm, motorCurrentA, motorVoltageV }; bus { electricalPowerW, currentA, terminalV, throttle (motor V / pack V) }; hover { shaftPowerW, ' +
    'idealPowerW = Σ T^1.5/sqrt(2ρA) (momentum theory), figureOfMerit }; endurance { timeS, timeMin, limitedBy, usedMah, energyWh, finalSoc }; ' +
    'capacityOverCurrentS = initial charge / initial current (the constant-current endurance: the upper bound that ignores sag and the SoC floor). ' +
    'Read-only; flight_report / run_flight give the same chain in a real flight.',
  params: z.object({
    powertrain: z.string().describe('Id of the powertrain (add_flight_powertrain).'),
    rpm: z.number().min(0).max(200000).optional().describe('Hold every rotor of the powertrain at this speed, rev/min.'),
    totalThrustN: z
      .number()
      .positive()
      .optional()
      .describe(
        "Total thrust of the powertrain's rotors, N, shared equally (hover at weight: m·g); each rotor's speed follows from its static Ct.",
      ),
    initialSoc: z.number().min(0).max(1).optional().describe("State of charge to start from. Default: the battery's initialSoc."),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'estimate_endurance');
    const flight = flightOf(doc);
    const powertrain = Object.hasOwn(flight.powertrains ?? {}, params.powertrain) ? flight.powertrains?.[params.powertrain] : undefined;
    if (powertrain === undefined) return fail(`powertrain '${params.powertrain}' not found (add_flight_powertrain first)`);
    const battery = flight.batteries?.[powertrain.batteryId];
    if (battery === undefined) return fail(`powertrain '${powertrain.id}' names a missing battery '${powertrain.batteryId}'`);
    if (params.rpm !== undefined && params.totalThrustN !== undefined) return fail('give `rpm` or `totalThrustN`, not both');
    const rotors = powertrain.rotorIds.flatMap((id) => {
      const rotor = flight.rotors[id];
      return rotor === undefined ? [] : [compileRotor(rotor, [0, 0, 0], 1)];
    });
    if (rotors.length !== powertrain.rotorIds.length) return fail(`powertrain '${powertrain.id}' names a missing rotor`);
    const feed = compilePower(powertrain, battery, powertrain.rotorIds);
    const speeds: number[] = [];
    for (const rotor of rotors) {
      if (params.totalThrustN === undefined) {
        speeds.push(params.rpm ?? rotor.rotor.rpm);
        continue;
      }
      const { ct } = staticCoefficients(rotor);
      if (!(ct > 0)) return fail(`rotor '${rotor.rotor.id}' has no static thrust (Ct = 0 at J = 0): give \`rpm\``);
      const n = Math.sqrt(params.totalThrustN / rotors.length / (ct * rotor.rotor.airDensity * rotor.rotor.diameter ** 4));
      speeds.push(n * 60);
    }
    const rows = rotors.map((rotor, i) => {
      const rpm = speeds[i] ?? 0;
      const output = rotorOutput(rotor, AT_REST, rpm);
      return { rotor, rpm, output, motor: motorPoint(feed.motor, output.torque, (rpm * 2 * Math.PI) / 60) };
    });
    const loads: MotorLoad[] = rows.map((row) => ({ torqueNm: row.output.torque, rpm: row.rpm }));
    const result = constantLoadEndurance(feed, loads, params.initialSoc ?? battery.initialSoc);
    const shaft = rows.reduce((sum, row) => sum + row.output.power, 0);
    const ideal = rows.reduce(
      (sum, { rotor, output }) =>
        sum + output.thrust ** 1.5 / Math.sqrt(2 * rotor.rotor.airDensity * Math.PI * (rotor.rotor.diameter / 2) ** 2),
      0,
    );
    const data = {
      powertrain: powertrain.id,
      battery: battery.id,
      rotors: rows.map(({ rotor, rpm, output, motor }) => ({
        id: rotor.rotor.id,
        rpm,
        thrustN: output.thrust,
        shaftPowerW: output.power,
        torqueNm: output.torque,
        motorCurrentA: motor.currentA,
        motorVoltageV: motor.voltageV,
      })),
      bus: {
        electricalPowerW: result.initial.busPowerW,
        currentA: result.initial.currentA,
        terminalV: result.initial.terminalV,
        throttle: result.initial.throttle,
      },
      hover: { shaftPowerW: shaft, idealPowerW: ideal, figureOfMerit: shaft > 0 ? ideal / shaft : null },
      endurance: {
        timeS: result.timeS,
        timeMin: result.timeS === null ? null : result.timeS / 60,
        limitedBy: result.limitedBy,
        usedMah: result.usedMah,
        energyWh: result.energyWh,
        finalSoc: result.finalSoc,
      },
      capacityOverCurrentS: result.capacityOverCurrentS,
      unverified: [...battery.defaulted, ...powertrain.defaulted].length > 0,
      defaulted: [
        ...battery.defaulted.map((name) => `battery.${battery.id}.${name}`),
        ...powertrain.defaulted.map((name) => `powertrain.${powertrain.id}.${name}`),
      ],
    };
    const warning =
      result.limitedBy === 'motor_voltage' || result.limitedBy === 'pack_power'
        ? `; the pack cannot hold this load (${result.limitedBy})`
        : '';
    return report(
      doc,
      `estimate_endurance: '${powertrain.id}' on '${battery.id}' — ${rows.length} rotor(s), shaft ${format(shaft)} W (ideal ${format(ideal)} W), electrical ${format(result.initial.busPowerW)} W, ` +
        `${format(result.initial.currentA)} A at ${format(result.initial.terminalV)} V (throttle ${format(result.initial.throttle)}); endurance ${result.timeS === null ? 'unbounded (no load)' : `${format(result.timeS)} s (${format(result.timeS / 60)} min)`} ` +
        `limited by ${result.limitedBy}, ${format(result.usedMah)} mAh / ${format(result.energyWh)} Wh used, capacity / current ${result.capacityOverCurrentS === null ? 'n/a' : `${format(result.capacityOverCurrentS)} s`}${warning}` +
        `${data.unverified ? `; unverified (${data.defaulted.join(', ')})` : ''}.`,
      data,
    );
  },
});
