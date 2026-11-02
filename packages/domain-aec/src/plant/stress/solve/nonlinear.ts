/**
 * Non-linear supports around `analyzeFrame` (07 PST §5.5): one-way and gap contacts as an active set, Coulomb friction as stick (ground spring) or
 * slip (constant force mu N against the motion). Each iteration re-assembles and re-factors the model; a case never superposes with another (the
 * caller solves each primitive set separately). Bounded: `maxIterations`; non-convergence is a coded result naming the restraints that toggled.
 */

import { analyzeFrame } from '@lib/frame3d/solve';
import type { FrameCaseResult, FrameLoadCase, FrameModel, FrameRestraint } from '@lib/frame3d/types';
import type { Contact } from '../model/restraints';

/** Stick stiffness of a friction spring: 1e9 N/m = 1e6 N/mm (named, 07 PST §5.5). */
const FRICTION_STIFFNESS = 1e6;
const MAX_ITERATIONS = 50;
const FORCE_TOLERANCE = 1e-6;
const DISPLACEMENT_TOLERANCE = 1e-9;
const SLIP_MARGIN = 1e-9;

export type ContactStatus = 'active' | 'lifted' | 'gap-open' | 'sliding';

export interface ContactOutcome {
  readonly contact: Contact;
  readonly status: ContactStatus;
  /** Reaction along the contact normal, N (>= 0 when active). */
  readonly normalForceN: number;
}

export type NonlinearResult =
  | { readonly ok: true; readonly result: FrameCaseResult; readonly iterations: number; readonly contacts: readonly ContactOutcome[] }
  | {
      readonly ok: false;
      readonly code: 'PST_UNSTABLE' | 'PST_MODEL_TOO_LARGE' | 'PST_NONLINEAR_NOT_CONVERGED' | 'PST_ANALYSIS_FAILED';
      readonly message: string;
      readonly nodes: readonly number[];
      readonly dofs: readonly { node: number; dof: number }[];
      readonly sources: readonly string[];
    };

interface FrictionState {
  mode: 'stick' | 'slip';
  /** Stick: the position the ground spring holds (the two tangential DOFs). */
  offset: [number, number];
  /** Slip: unit direction of the friction force on the pipe (against the motion). */
  direction: [number, number];
  /** Slip: the limit mu N the force was applied with. */
  used: number;
}

const tangentialDofs = (dof: number): number[] => [0, 1, 2].filter((candidate) => candidate !== dof);

/**
 * Solves `loadCase` on `base` with the anchors and contacts.
 * @invariant active contacts are rigid DOFs at -normal x gap; released ones are absent; friction acts only on tangential DOFs that are not rigidly held
 */
export function solveWithContacts(
  base: Pick<FrameModel, 'nodes' | 'elements'>,
  anchors: readonly { readonly node: number }[],
  contacts: readonly Contact[],
  loadCase: FrameLoadCase,
  maxIterations = MAX_ITERATIONS,
): NonlinearResult {
  const active = contacts.map((contact) => contact.gapMm === 0);
  const friction: (FrictionState | null)[] = contacts.map((contact) =>
    contact.friction > 0 ? { mode: 'stick', offset: [0, 0], direction: [0, 0], used: 0 } : null,
  );
  const seen = new Set<string>();
  const toggled: number[][] = [];
  let singleMode = false;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const restraints = new Map<number, FrameRestraint>();
    for (const anchor of anchors) for (let dof = 0; dof < 6; dof++) restraints.set(anchor.node * 6 + dof, { node: anchor.node, dof });
    contacts.forEach((contact, index) => {
      const key = contact.node * 6 + contact.dof;
      if (active[index] && !restraints.has(key))
        restraints.set(key, { node: contact.node, dof: contact.dof, value: -contact.normal * contact.gapMm });
    });
    const rigid = new Set(restraints.keys());
    const frictionLoads: NonNullable<FrameLoadCase['nodal']>[number][] = [];
    contacts.forEach((contact, index) => {
      const state = friction[index];
      if (!active[index] || !state) return;
      const force: [number, number, number] = [0, 0, 0];
      tangentialDofs(contact.dof).forEach((dof, slot) => {
        const key = contact.node * 6 + dof;
        if (rigid.has(key)) return;
        if (state.mode === 'stick')
          restraints.set(key, { node: contact.node, dof, stiffness: FRICTION_STIFFNESS, value: state.offset[slot as 0 | 1] });
        else force[dof] = state.used * state.direction[slot as 0 | 1];
      });
      if (state.mode === 'slip') frictionLoads.push({ node: contact.node, force });
    });
    const analysis = analyzeFrame({ ...base, restraints: [...restraints.values()] }, [
      frictionLoads.length === 0 ? loadCase : { ...loadCase, nodal: [...(loadCase.nodal ?? []), ...frictionLoads] },
    ]);
    if (!analysis.ok) {
      const code =
        analysis.code === 'FRAME_UNSTABLE'
          ? 'PST_UNSTABLE'
          : analysis.code === 'FRAME_TOO_LARGE'
            ? 'PST_MODEL_TOO_LARGE'
            : 'PST_ANALYSIS_FAILED';
      return { ok: false, code, message: analysis.message, nodes: analysis.dofs.map((dof) => dof.node), dofs: analysis.dofs, sources: [] };
    }
    const result = analysis.cases[0] as FrameCaseResult;
    if (contacts.length === 0) return { ok: true, result, iterations: 1, contacts: [] };
    const forceTolerance = FORCE_TOLERANCE + 1e-9 * result.reactions.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
    const normalForce = contacts.map((contact) => contact.normal * (result.reactions[contact.node * 6 + contact.dof] as number));
    const violations: { index: number; size: number; release: boolean }[] = [];
    contacts.forEach((contact, index) => {
      if (active[index]) {
        if ((normalForce[index] as number) < -forceTolerance)
          violations.push({ index, size: -(normalForce[index] as number), release: true });
      } else {
        const penetration = -contact.gapMm - contact.normal * (result.displacements[contact.node * 6 + contact.dof] as number);
        if (penetration > DISPLACEMENT_TOLERANCE) violations.push({ index, size: penetration * 1e9, release: false });
      }
    });
    let frictionMoved = false;
    contacts.forEach((contact, index) => {
      const state = friction[index];
      if (!active[index] || !state) return;
      const dofs = tangentialDofs(contact.dof).map((dof) => contact.node * 6 + dof);
      const free = dofs.map((key) => restraints.get(key)?.stiffness !== undefined || !restraints.has(key));
      const reaction = dofs.map((key, slot) => (free[slot] ? (result.reactions[key] as number) : 0));
      const motion = dofs.map((key, slot) => (free[slot] ? (result.displacements[key] as number) : 0));
      const limit = contact.friction * Math.max(0, normalForce[index] as number);
      if (state.mode === 'stick') {
        const magnitude = Math.hypot(reaction[0] as number, reaction[1] as number);
        if (magnitude > limit * (1 + SLIP_MARGIN) + 1e-9) {
          state.mode = 'slip';
          state.direction = [(reaction[0] as number) / magnitude, (reaction[1] as number) / magnitude];
          state.used = limit;
          frictionMoved = true;
        }
        return;
      }
      const travel = Math.hypot(motion[0] as number, motion[1] as number);
      const against: [number, number] = travel > 0 ? [-(motion[0] as number) / travel, -(motion[1] as number) / travel] : state.direction;
      if (travel === 0 || against[0] * state.direction[0] + against[1] * state.direction[1] < 0) {
        state.mode = 'stick';
        state.offset = [motion[0] as number, motion[1] as number];
        frictionMoved = true;
        return;
      }
      const blended: [number, number] = [0.5 * (state.direction[0] + against[0]), 0.5 * (state.direction[1] + against[1])];
      const size = Math.hypot(blended[0], blended[1]);
      const next: [number, number] = [blended[0] / size, blended[1] / size];
      if (
        Math.hypot(next[0] - state.direction[0], next[1] - state.direction[1]) > 1e-6 ||
        Math.abs(limit - state.used) > 1e-6 * Math.max(limit, 1e-3)
      )
        frictionMoved = true;
      state.direction = next;
      state.used = limit;
    });
    if (violations.length === 0 && !frictionMoved) {
      const outcome: ContactOutcome[] = contacts.map((contact, index) => ({
        contact,
        normalForceN: active[index] ? (normalForce[index] as number) : 0,
        status: active[index] ? (friction[index]?.mode === 'slip' ? 'sliding' : 'active') : contact.gapMm > 0 ? 'gap-open' : 'lifted',
      }));
      // a slipping shoe is a constant applied force in the solve; as a support it is the reaction the shoe gives
      const reactions = Float64Array.from(result.reactions);
      for (const load of frictionLoads)
        for (let i = 0; i < 3; i++) reactions[load.node * 6 + i] = (reactions[load.node * 6 + i] as number) + (load.force?.[i] ?? 0);
      return { ok: true, result: { ...result, reactions }, iterations: iteration, contacts: outcome };
    }
    const signature = active.map((flag) => (flag ? '1' : '0')).join('') + violations.map((entry) => entry.index).join(',');
    if (seen.has(signature)) singleMode = true;
    seen.add(signature);
    const changes = singleMode ? violations.sort((a, b) => b.size - a.size).slice(0, 1) : violations;
    toggled.push(changes.length > 0 ? changes.map((change) => change.index) : friction.flatMap((state, index) => (state ? [index] : [])));
    for (const change of changes) active[change.index] = !change.release;
  }
  const last = [...new Set(toggled.slice(-5).flat())];
  return {
    ok: false,
    code: 'PST_NONLINEAR_NOT_CONVERGED',
    message: `support status did not settle in ${maxIterations} iterations`,
    nodes: last.map((index) => (contacts[index] as Contact).node),
    dofs: [],
    sources: [...new Set(last.flatMap((index) => (contacts[index] as Contact).sources))],
  };
}
