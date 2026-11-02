import { equivalentLoad, globalStiffness, localAxes, localStiffness, toGlobal, toLocal, type PreparedElement } from './element';
import { reverseCuthillMcKee } from './rcm';
import { Skyline } from './skyline';
import type { FrameAnalysis, FrameCaseResult, FrameDof, FrameLoadCase, FrameModel, FramePoint } from './types';
import { validateCase, validateModel } from './validate';

/** A pivot of the Jacobi-scaled matrix (unit diagonal) at or below this marks a mechanism (rigid-body mode); stiff links stay far above it. */
const PIVOT_TOLERANCE = 1e-12;

/** Default cap on skyline entries (8 bytes each: 400 MB) and the Int32 offset limit. */
const DEFAULT_MAX_PROFILE = 5e7;
const INT32_LIMIT = 2 ** 31 - 1;
const REFINEMENTS = 3;

interface Numbering {
  /** Free-equation index per global DOF (6 per node), -1 for a rigidly restrained DOF. */
  readonly equation: Int32Array;
  /** Global DOF per equation. */
  readonly dofOf: Int32Array;
}

function numberDofs(model: FrameModel): Numbering {
  const nodeCount = model.nodes.length;
  const order = reverseCuthillMcKee(
    nodeCount,
    model.elements.map((e) => [e.a, e.b] as const),
  );
  const rigid = new Uint8Array(nodeCount * 6);
  for (const r of model.restraints) if (r.stiffness === undefined) rigid[r.node * 6 + r.dof] = 1;
  const equation = new Int32Array(nodeCount * 6).fill(-1);
  const dofOf: number[] = [];
  for (const node of order) {
    for (let d = 0; d < 6; d++) {
      const dof = node * 6 + d;
      if (rigid[dof]) continue;
      equation[dof] = dofOf.length;
      dofOf.push(dof);
    }
  }
  return { equation, dofOf: Int32Array.from(dofOf) };
}

function elementDofs(a: number, b: number): number[] {
  return Array.from({ length: 12 }, (_, i) => (i < 6 ? a * 6 + i : b * 6 + i - 6));
}

function toFailureDof(dof: number): FrameDof {
  return { node: Math.floor(dof / 6), dof: dof % 6 };
}

const norm = (values: ArrayLike<number>): number => {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += (values[i] as number) ** 2;
  return Math.sqrt(sum);
};

interface ElementForceSet {
  /** 12 per element, local axes. */
  readonly elementForces: Float64Array;
  /** Sum over elements of the global end forces the nodes apply, per global DOF. */
  readonly internal: Float64Array;
}

function elementForceSet(
  model: FrameModel,
  prepared: readonly PreparedElement[],
  equivalent: readonly Float64Array[],
  displacements: Float64Array,
): ElementForceSet {
  const elementForces = new Float64Array(model.elements.length * 12);
  const internal = new Float64Array(model.nodes.length * 6);
  model.elements.forEach((element, e) => {
    const prep = prepared[e] as PreparedElement;
    const dofs = elementDofs(element.a, element.b);
    const ul = toLocal(
      prep.rotation,
      dofs.map((d) => displacements[d] as number),
    );
    const fe = equivalent[e] as Float64Array;
    const f = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      let sum = 0;
      for (let j = 0; j < 12; j++) sum += (prep.local[i * 12 + j] as number) * (ul[j] as number);
      f[i] = sum - (fe[i] as number);
    }
    elementForces.set(f, e * 12);
    const global = toGlobal(prep.rotation, f);
    dofs.forEach((dof, i) => {
      internal[dof] = (internal[dof] as number) + (global[i] as number);
    });
  });
  return { elementForces, internal };
}

function solveCase(
  model: FrameModel,
  prepared: readonly PreparedElement[],
  numbering: Numbering,
  sky: Skyline,
  loadCase: FrameLoadCase,
): FrameCaseResult {
  const dofCount = model.nodes.length * 6;
  const { equation } = numbering;
  const applied = new Float64Array(dofCount);
  for (const load of loadCase.nodal ?? []) {
    for (let i = 0; i < 3; i++) {
      applied[load.node * 6 + i] = (applied[load.node * 6 + i] as number) + (load.force?.[i] ?? 0);
      applied[load.node * 6 + 3 + i] = (applied[load.node * 6 + 3 + i] as number) + (load.moment?.[i] ?? 0);
    }
  }
  const equivalent = model.elements.map(() => new Float64Array(12));
  const rhs = Float64Array.from(applied);
  for (const load of loadCase.elemental ?? []) {
    const element = model.elements[load.element];
    const prep = prepared[load.element];
    const fe = equivalent[load.element];
    if (!element || !prep || !fe) continue;
    const add = equivalentLoad(element, prep, load.uniform, load.freeStrain ?? 0);
    for (let i = 0; i < 12; i++) fe[i] = (fe[i] as number) + (add[i] as number);
  }
  model.elements.forEach((element, e) => {
    const global = toGlobal((prepared[e] as PreparedElement).rotation, equivalent[e] as Float64Array);
    elementDofs(element.a, element.b).forEach((dof, i) => {
      rhs[dof] = (rhs[dof] as number) + (global[i] as number);
    });
  });

  const prescribed = new Float64Array(dofCount);
  const springStiffness = new Float64Array(dofCount);
  let hasPrescribed = false;
  for (const r of model.restraints) {
    const dof = r.node * 6 + r.dof;
    if (r.stiffness === undefined) {
      prescribed[dof] = r.value ?? 0;
      hasPrescribed ||= (r.value ?? 0) !== 0;
    } else {
      springStiffness[dof] = r.stiffness;
      prescribed[dof] = r.value ?? 0;
    }
  }
  const loadNorm = norm(rhs);
  const reduced = Float64Array.from(rhs);
  for (let dof = 0; dof < dofCount; dof++) {
    if ((springStiffness[dof] as number) > 0)
      reduced[dof] = (reduced[dof] as number) + (springStiffness[dof] as number) * (prescribed[dof] as number);
  }
  if (hasPrescribed) {
    model.elements.forEach((element, e) => {
      const dofs = elementDofs(element.a, element.b);
      const kg = (prepared[e] as PreparedElement).global;
      dofs.forEach((row, i) => {
        if ((equation[row] as number) < 0) return;
        let sum = 0;
        dofs.forEach((col, j) => {
          if ((equation[col] as number) < 0) sum += (kg[i * 12 + j] as number) * (prescribed[col] as number);
        });
        reduced[row] = (reduced[row] as number) - sum;
      });
    });
  }
  const b = new Float64Array(sky.size);
  for (let eq = 0; eq < sky.size; eq++) b[eq] = reduced[numbering.dofOf[eq] as number] as number;
  const x = sky.solve(b);
  let displacements = Float64Array.from(prescribed);
  for (let eq = 0; eq < sky.size; eq++) displacements[numbering.dofOf[eq] as number] = x[eq] as number;

  const outOfBalance = (internal: Float64Array, u: Float64Array): Float64Array => {
    const out = new Float64Array(sky.size);
    for (let eq = 0; eq < sky.size; eq++) {
      const dof = numbering.dofOf[eq] as number;
      const spring = springStiffness[dof] as number;
      out[eq] = (internal[dof] as number) - (applied[dof] as number) + spring * ((u[dof] as number) - (prescribed[dof] as number));
    }
    return out;
  };
  let forces = elementForceSet(model, prepared, equivalent, displacements);
  // iterative refinement (at most REFINEMENTS passes, stops when the out-of-balance stops shrinking): the mixed force / moment scaling of a
  // pipe frame costs a few digits in the first solve
  let balance = norm(outOfBalance(forces.internal, displacements));
  for (let pass = 0; pass < REFINEMENTS; pass++) {
    const correction = sky.solve(outOfBalance(forces.internal, displacements));
    const trial = Float64Array.from(displacements);
    for (let eq = 0; eq < sky.size; eq++) {
      const dof = numbering.dofOf[eq] as number;
      trial[dof] = (trial[dof] as number) - (correction[eq] as number);
    }
    const next = elementForceSet(model, prepared, equivalent, trial);
    const nextBalance = norm(outOfBalance(next.internal, trial));
    if (nextBalance >= balance) break;
    displacements = trial;
    forces = next;
    if (nextBalance >= 0.5 * balance) break;
    balance = nextBalance;
  }
  const { internal, elementForces } = forces;

  const reactions = new Float64Array(dofCount);
  for (let dof = 0; dof < dofCount; dof++) {
    const out = (internal[dof] as number) - (applied[dof] as number);
    const spring = springStiffness[dof] as number;
    if ((equation[dof] as number) < 0) reactions[dof] = out;
    else if (spring > 0) reactions[dof] = -spring * ((displacements[dof] as number) - (prescribed[dof] as number));
  }
  const scaleNorm = Math.max(loadNorm, norm(reduced));
  const residualSquares = norm(outOfBalance(internal, displacements)) ** 2;
  return {
    name: loadCase.name,
    displacements,
    reactions,
    elementForces,
    residual: scaleNorm > 0 ? Math.sqrt(residualSquares) / scaleNorm : 0,
  };
}

/**
 * Linear static analysis of a pipe frame. One assembly and factorisation (reverse Cuthill-McKee order, skyline Cholesky), then a
 * back-substitution per load case. Pure and deterministic (same input, bit-identical output). Never throws: a malformed model or load,
 * or a mechanism, returns a typed failure naming the offending DOF.
 */
export function analyzeFrame(
  model: FrameModel,
  cases: readonly FrameLoadCase[],
  limits: { readonly maxProfile?: number } = {},
): FrameAnalysis {
  const invalid = validateModel(model);
  if (invalid) return invalid;
  for (const loadCase of cases) {
    const bad = validateCase(model, loadCase);
    if (bad) return bad;
  }
  const prepared: PreparedElement[] = [];
  for (const [index, element] of model.elements.entries()) {
    const axes = localAxes(model.nodes[element.a] as FramePoint, model.nodes[element.b] as FramePoint, element.up);
    if (!axes) return { ok: false, code: 'FRAME_INVALID_MODEL', message: `element ${index} has zero length`, dofs: [] };
    const local = localStiffness(element, axes.length);
    prepared.push({ ...axes, local, global: globalStiffness(local, axes.rotation) });
  }
  const numbering = numberDofs(model);
  const size = numbering.dofOf.length;
  const first = Int32Array.from({ length: size }, (_, i) => i);
  for (const element of model.elements) {
    const equations = elementDofs(element.a, element.b)
      .map((dof) => numbering.equation[dof] as number)
      .filter((eq) => eq >= 0);
    const lowest = Math.min(...equations);
    for (const eq of equations) if (lowest < (first[eq] as number)) first[eq] = lowest;
  }
  const profile = Skyline.profileSize(first);
  if (!(profile <= Math.min(limits.maxProfile ?? DEFAULT_MAX_PROFILE, INT32_LIMIT))) {
    return {
      ok: false,
      code: 'FRAME_TOO_LARGE',
      message: `skyline factor would need ${profile} entries (bandwidth too wide for the cap)`,
      dofs: [],
    };
  }
  const sky = new Skyline(first);
  model.elements.forEach((element, e) => {
    const dofs = elementDofs(element.a, element.b);
    const kg = (prepared[e] as PreparedElement).global;
    dofs.forEach((row, i) => {
      const r = numbering.equation[row] as number;
      if (r < 0) return;
      dofs.forEach((col, j) => {
        const c = numbering.equation[col] as number;
        if (c >= 0 && c <= r) sky.add(r, c, kg[i * 12 + j] as number);
      });
    });
  });
  for (const r of model.restraints) {
    const eq = numbering.equation[r.node * 6 + r.dof] as number;
    if (r.stiffness !== undefined && eq >= 0) sky.add(eq, eq, r.stiffness);
  }
  const stats = { nodes: model.nodes.length, dofs: model.nodes.length * 6, freeDofs: size, bandwidth: sky.bandwidth, profile: sky.profile };
  const bad = sky.factorize(PIVOT_TOLERANCE);
  if (bad >= 0) {
    const dof = toFailureDof(numbering.dofOf[bad] as number);
    return {
      ok: false,
      code: 'FRAME_UNSTABLE',
      message: `model is a mechanism or unrestrained: zero stiffness at node ${dof.node} dof ${dof.dof}`,
      dofs: [dof],
    };
  }
  return { ok: true, cases: cases.map((loadCase) => solveCase(model, prepared, numbering, sky, loadCase)), stats };
}
