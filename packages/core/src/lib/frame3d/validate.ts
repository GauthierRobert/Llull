import type { FrameDof, FrameErrorCode, FrameLoadCase, FrameModel } from './types';

export interface FrameFailure {
  readonly ok: false;
  readonly code: FrameErrorCode;
  readonly message: string;
  readonly dofs: readonly FrameDof[];
}

function fail(code: FrameErrorCode, message: string, dofs: readonly FrameDof[] = []): FrameFailure {
  return { ok: false, code, message, dofs };
}

const finite = (v: number | undefined): boolean => v === undefined || Number.isFinite(v);
const finiteTriple = (v: readonly number[] | undefined): boolean => v === undefined || (v.length === 3 && v.every(Number.isFinite));
const isIndex = (v: number, count: number): boolean => Number.isInteger(v) && v >= 0 && v < count;

/** Structural checks of a model; null when valid. Never throws. */
export function validateModel(model: FrameModel): FrameFailure | null {
  const { nodes, elements, restraints } = model;
  if (nodes.length === 0 || elements.length === 0) return fail('FRAME_INVALID_MODEL', 'model needs at least one node and one element');
  for (const [index, node] of nodes.entries()) {
    if (!finiteTriple(node)) return fail('FRAME_INVALID_MODEL', `node ${index} has a non-finite coordinate`);
  }
  for (const [index, element] of elements.entries()) {
    if (!isIndex(element.a, nodes.length) || !isIndex(element.b, nodes.length) || element.a === element.b) {
      return fail('FRAME_INVALID_MODEL', `element ${index} has invalid end nodes (${element.a}, ${element.b})`);
    }
    const p = element.properties;
    const positive = [p.youngs, p.shear, p.area, p.inertia, p.torsion].every((v) => Number.isFinite(v) && v > 0);
    if (!positive || !Number.isFinite(p.shearArea) || p.shearArea < 0) {
      return fail('FRAME_INVALID_MODEL', `element ${index} has a non-positive or non-finite section / material property`);
    }
    const k = element.flexibility ?? 1;
    if (!Number.isFinite(k) || k <= 0) return fail('FRAME_INVALID_MODEL', `element ${index} flexibility factor ${k} must be positive`);
    if (!finiteTriple(element.up)) return fail('FRAME_INVALID_MODEL', `element ${index} has a non-finite up vector`);
  }
  const seen = new Set<number>();
  for (const [index, r] of restraints.entries()) {
    if (!isIndex(r.node, nodes.length) || !isIndex(r.dof, 6)) {
      return fail('FRAME_INVALID_MODEL', `restraint ${index} addresses node ${r.node} dof ${r.dof} outside the model`);
    }
    if (!finite(r.value) || (r.stiffness !== undefined && !(Number.isFinite(r.stiffness) && r.stiffness > 0))) {
      return fail('FRAME_INVALID_MODEL', `restraint ${index} has a non-finite value or non-positive stiffness`, [
        { node: r.node, dof: r.dof },
      ]);
    }
    const key = r.node * 6 + r.dof;
    if (seen.has(key))
      return fail('FRAME_INVALID_MODEL', `restraint ${index} duplicates node ${r.node} dof ${r.dof}`, [{ node: r.node, dof: r.dof }]);
    seen.add(key);
  }
  return null;
}

/** Load-case checks against the model; null when valid. */
export function validateCase(model: FrameModel, loadCase: FrameLoadCase): FrameFailure | null {
  for (const load of loadCase.nodal ?? []) {
    if (!isIndex(load.node, model.nodes.length) || !finiteTriple(load.force) || !finiteTriple(load.moment)) {
      return fail('FRAME_INVALID_LOAD', `case ${loadCase.name}: nodal load on node ${load.node} is outside the model or non-finite`);
    }
  }
  for (const load of loadCase.elemental ?? []) {
    if (!isIndex(load.element, model.elements.length) || !finiteTriple(load.uniform) || !finite(load.freeStrain)) {
      return fail(
        'FRAME_INVALID_LOAD',
        `case ${loadCase.name}: element load on element ${load.element} is outside the model or non-finite`,
      );
    }
  }
  return null;
}
