/** Running the physics (simulate_motion). */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { runSimulation } from './simulateRun';

/**
 * @affects nothing — read-only; returns { ...SimulationData, loops?, reactions?, engineReport? } in data
 * @invariant deterministic: same document + params → same data; a model without loops or cylinders returns exactly the legacy data
 * @failure no bodies, invalid model, no physics engine installed, engine error or divergence -> no-op with the reason;
 *          FPR_LOOP_PRISMATIC / FPR_SPHERICAL_TREE (topology), FPR_LOOP_OPEN (a loop is open at the start pose) -> rejected, nothing run
 * @invariant kernel-optional: body mass properties (buildSimulationModel) are exact with a kernel, mesh integration otherwise
 */
export const simulateMotion = defineCommand({
  name: 'simulate_motion',
  annotations: { kernelOptional: true, readsMeshTriangles: true, readOnly: true },
  description:
    'Run the rigid-body physics of the mechanism (bodies, joints, gears, motors, propellers) forward in time with a real physics ' +
    'engine (MuJoCo) and report what happens: final speed of every joint (rpm), when it settled, engine torque and power, propeller ' +
    'thrust / torque / absorbed power, and measured gear ratios (a self-check). Gravity applies (set_gravity). Read-only. For kinematic poses of component instances without mass or forces (add_joint) use evaluate_motion instead; plot_simulation charts and render_motion animates the result of this run. ' +
    'detail "summary" (default) = numbers only; "series" adds per-sample time series (speeds, positions, torques, thrust, power) for ' +
    'plotting; `energy: true` adds the kinetic / potential / total / dissipated energy balance (J; automatic when a joint or add_spring has a spring) with the work put in by motors / governors / gas pressure (inputWorkJ), the work absorbed by propellers and balanceErrorJ (initial + input - dissipated - propellers - final, ~0), and data.springs (length range and force per add_spring); "poses" also adds every body\'s pose per sample (for playback). Warnings flag a run that has not settled. ' +
    'Typical: duration 10 s, timestep 0.001 s (use 0.0002 s for fast, light parts). ' +
    'Closed loops (slider-crank, four-bar): before integrating, the start pose is checked and a loop open by more than 1 µm is refused ' +
    '(FPR_LOOP_OPEN, nothing is run or snapped); with loops the default timestep is the "auto" rule min(1 ms, 0.5 deg of crank at the ' +
    'top speed) unless set_dynamics_solver or `timestep` says otherwise, and data.loops reports the largest constraint violation ' +
    '(metres), its tier (pass <= 1 µm, warn <= 10 µm = FPR_LOOP_DRIFT warn, reactions approximate; fail above, reactions unreliable) ' +
    'and the solver settings used. `reactions`: "off", "peaks" (default when the mechanism has loops) or "series": data.reactions ' +
    'gives, per tree joint, the force (N) and moment (N·m) on the child body at the joint anchor in world axes, and per loop closure ' +
    'the resultant force (N) on the child (no moment), each with peak magnitude, time and crank angle (the crank angle axis is the cycle angle of the first cylinder, or the joint named by ' +
    '`crankAxis`); along the axis of a driven joint the reported component includes the drive force itself. With cylinder pressures ' +
    '(add_cylinder_pressure) the sampling defaults to one sample per crank degree and data.engineReport gives, over the last full ' +
    'cycle: torque against crank angle per cylinder and total (detail series), mean torque (N·m), indicated power (kW), IMEP and peak ' +
    'pressure per cylinder, cycle-energy closure (gate 0.5 %, FPR_ENERGY_CLOSURE), speed ripple against the analytic ΔE/(I·ω²), and ' +
    'the peak wrist-pin, rod, side-thrust, crank-pin and main-bearing forces. Simulate at least one full cycle (two crank turns for a ' +
    'four-stroke) after the speed has settled. data.engineReport.realism (FR-FPR-70 / 71 / 73 / 76): with set_engine_losses, BRAKE torque and power ' +
    '(indicated minus friction), BMEP = IMEP - FMEP and mechanical efficiency (losses{}, with a governor-torque cross-check); per cylinder the ' +
    'reciprocating mass and primary / secondary inertia-force amplitudes against the gas peak (reciprocating[]); an accuracy{} statement for every ' +
    'scalar (band or null = "± ?", basis, origin input / calibrated / predicted / verification, validationLevel 0-4, warnings; a value at a speed the ' +
    'heat release was calibrated at is "calibrated", not validation evidence); plausibility[] (FPR_UNREALISTIC: peak-pressure angle and CA50 vs MBT, ' +
    'mechanical efficiency, Rotax-class propeller inertia / torque, reciprocating mass on the default density). A gear with efficiency (add_transmission) ' +
    'loses (1 - efficiency) of its torque on the driven shaft; a propeller with a Ct / Cp table and airspeed follows J = V/(nD). ' +
    'Free flight (13 FLT): rotors fixed to a body (add_rotor) thrust along the body axis with J from the body state, reaction and gyroscopic torques, and body drag (set_body_drag) turns with the body; ' +
    'data.flight gives per rotor the final thrust N, torque N·m, power W and J range (FLT_OUTSIDE_VALIDATED_RANGE when J leaves the validated range of its coefficients), per drag body the speed and drag force, and with detail "series" their per-sample series. ' +
    'Datasheet motors (add_motor kind "dc", "pmsm", "stepper" or "induction" + set_motor_drive): data.drives gives per motor the peak and final current (A: dc winding current, pmsm phase-current amplitude, stepper phase current, induction load current I2 RMS), voltage (V: terminal, stator amplitude, phase R*I, phase RMS), joint torque ' +
    '(N·m) and shaft speed (rpm), RMS values, the number of samples where the current limit clipped the command, the tracking error of a prescribed / ' +
    'closed-loop drive and whether the datasheet was verified; detail "drives" adds the per-sample series (voltage, current, shaft and joint torque, shaft speed, ' +
    'electrical and mechanical power) and turns the energy ledger on (the joint series of detail "series" are included too). data.ledger (with `energy`, or detail "drives") lists the joules of every element ' +
    '(electrical input net of regeneration, copper loss, magnetic energy, iron and rotor loss of an induction motor or the damping loss of a stepper, gearhead loss, friction and damping, propellers, kinetic, potential, external work) ' +
    'and how well input - dissipated - stored closes (pass <= 1e-3, warn <= 1e-2 of the largest term). Warnings: DRV_ELECTRICAL_QUASI_STATIC (info), ' +
    'DRV_TRACKING_ERROR, DRV_STEPS_LOST (stepper: steps lost, with the time of the first; data.drives[id].stepper holds lostSteps, firstLostS, peakLagDeg), DRV_STEPPER_TIMESTEP (the step is too coarse for the stepper ringing), ' +
    'DRV_PMSM_VOLTAGE_OVER (the stator voltage exceeds V_bus/sqrt(3): the envelope neglects the winding resistance), DRV_INDUCTION_QUASI_STEADY (steady-state torque at the instantaneous slip, info), ' +
    'DRV_CONTROL_RATE / DRV_PROFILE_INVALID / DRV_TUNE_NO_INERTIA / DRV_MODE_UNSUPPORTED (refuse the run, nothing simulated). ' +
    'Next: read data.loops.tier first, then data.engineReport and data.reactions.',
  params: z.object({
    duration: z.number().positive().max(600).optional().describe('Simulated seconds. Default 5.'),
    timestep: z
      .number()
      .min(5e-6)
      .max(0.01)
      .optional()
      .describe(
        'Integration step in seconds, at least 5e-6 (half of the smallest auto step, so a timestep-halving check can always run). Default 0.001 (loops or cylinders: the "auto" rule or the stored solver setting).',
      ),
    sampleRate: z
      .number()
      .positive()
      .optional()
      .describe(
        'Recorded samples per second. Default 50, raised for loop mechanisms to 36 per turn of the crank so periodic motion is not aliased; engines: one per crank degree. At most 6001 samples per run.',
      ),
    detail: z
      .enum(['summary', 'series', 'poses', 'drives'])
      .optional()
      .describe(
        '"summary" (default), "series", "poses", or "drives" (everything of "series" + per-sample series of every datasheet motor + the energy ledger).',
      ),
    reactions: z
      .enum(['off', 'peaks', 'series'])
      .optional()
      .describe('Joint / loop reaction forces: "off", "peaks" (default when the mechanism has loops), "series" (adds every sample).'),
    energy: z
      .boolean()
      .optional()
      .describe(
        'Add the energy balance: data.energy (kinetic, potential = gravity + joint springs relative to the start pose, total, energy dissipated by joint damping / friction, largest departure of the total from its initial value as a fraction of the peak energy) and, with detail "series", data.series.energy per sample. Also inputWorkJ (work of motors, speed governors and cylinder gas pressure), propellerWorkJ (absorbed by propellers) and balanceErrorJ = initial total + input - dissipated - propellers - final total (zero when every energy flow is counted). Default false, except true when a joint or an add_spring has a spring. A lossless mechanism keeps its total constant (conservation check); damping makes it decay by data.energy.dissipatedJ.',
      ),
    crankAxis: z
      .string()
      .optional()
      .describe('Id of the revolute tree joint whose angle (deg, 0-360) labels the peaks of reactions; default none (time only).'),
  }),
  run: (doc, params, ctx): CommandResult => runSimulation(doc, params, ctx),
});
