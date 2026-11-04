/**
 * Supports and extra restraints to the restraint set of the solver (07 PST §5.1 step 4): rigid anchors and unilateral contacts. A contact blocks
 * motion toward `-normal` along one global axis beyond `gapMm` (a rest on +Z has normal +1: it reacts upward only); a two-way restraint is two
 * contacts. Directions are global axes: an oblique guide is refused (rotated restraints arrive with M5).
 */

import type { Vec3 } from '@core/model/vectors';
import type { StressModel, StressRestraint } from './schema';
import type { Layout, LayoutFailure } from './layoutTypes';
import type { SourceSupport } from './sources';

export interface Contact {
  readonly node: number;
  /** Global translation DOF 0..2. */
  readonly dof: number;
  readonly normal: 1 | -1;
  readonly gapMm: number;
  readonly friction: number;
  /** Support / restraint ids that produced it. */
  readonly sources: readonly string[];
}

export interface RestraintSet {
  readonly anchors: readonly { readonly node: number; readonly sources: readonly string[] }[];
  readonly contacts: readonly Contact[];
  readonly warnings: readonly { readonly code: string; readonly message: string; readonly ids: readonly string[] }[];
}

const AXES = { x: 0, y: 1, z: 2 } as const;
const OBLIQUE_RATIO = Math.tan((5 * Math.PI) / 180);

/** Horizontal lateral axes of a guide on a pipe running along `axis`, or null when the pipe is oblique in plan. */
function lateralDofs(axis: Vec3): readonly number[] | null {
  const ax = Math.abs(axis[0]);
  const ay = Math.abs(axis[1]);
  if (Math.hypot(ax, ay) < 0.2) return [0, 1];
  if (Math.min(ax, ay) <= OBLIQUE_RATIO * Math.max(ax, ay)) return [ax > ay ? 1 : 0];
  return null;
}

const both = (node: number, dof: number, gapMm: number, source: string): Contact[] => [
  { node, dof, normal: 1, gapMm, friction: 0, sources: [source] },
  { node, dof, normal: -1, gapMm, friction: 0, sources: [source] },
];

const rest = (node: number, gapMm: number, friction: number, source: string): Contact => ({
  node,
  dof: 2,
  normal: 1,
  gapMm,
  friction,
  sources: [source],
});

/**
 * @failure a guide on a pipe oblique in plan -> PST_RESTRAINT_OBLIQUE; restraint on an unknown support / attachment -> PST_POINT_OFF_PIPE
 */
export function mapRestraints(
  model: Pick<StressModel, 'frictionCoefficient' | 'restraints'>,
  supports: readonly SourceSupport[],
  layout: Layout,
): RestraintSet | LayoutFailure {
  const anchors = new Map<number, string[]>();
  const contacts = new Map<string, Contact>();
  const warnings: { code: string; message: string; ids: string[] }[] = [];
  const addContact = (contact: Contact): void => {
    const key = `${contact.node}:${contact.dof}:${contact.normal}`;
    if (contacts.has(key))
      warnings.push({
        code: 'PST_RESTRAINT_OVERRIDDEN',
        message: `a restraint replaces another at node ${contact.node + 1} dof ${contact.dof}`,
        ids: [...contact.sources],
      });
    contacts.set(key, contact);
  };
  const oblique = (id: string, axis: Vec3): LayoutFailure => ({
    ok: false,
    code: 'PST_RESTRAINT_OBLIQUE',
    message: `${id}: the pipe axis (${axis.map((value) => value.toFixed(2)).join(', ')}) is neither along a global horizontal axis nor vertical; a lateral guide needs a rotated restraint (M5)`,
    ids: [id],
    paths: [],
  });
  for (const support of supports) {
    const at = layout.attached.get(`support:${support.id}`);
    if (at === undefined) continue;
    const { node, axis } = at;
    if (support.type === 'anchor') anchors.set(node, [...(anchors.get(node) ?? []), support.id]);
    else if (support.type === 'shoe') addContact(rest(node, 0, model.frictionCoefficient, support.id));
    else if (support.type === 'hanger') addContact(rest(node, 0, 0, support.id));
    else {
      const lateral = lateralDofs(axis);
      if (lateral === null) return oblique(support.id, axis);
      if (Math.abs(axis[2]) < 0.9) addContact(rest(node, 0, model.frictionCoefficient, support.id));
      for (const dof of lateral) for (const contact of both(node, dof, 0, support.id)) addContact(contact);
    }
  }
  for (const restraint of model.restraints) {
    const at = layout.attached.get(`restraint:${restraint.id}`);
    if (at === undefined) continue;
    const failure = mapExtra(restraint, at.node, at.axis, model.frictionCoefficient, anchors, addContact);
    if (failure !== null) return failure;
  }
  return { anchors: [...anchors].map(([node, sources]) => ({ node, sources })), contacts: [...contacts.values()], warnings };
}

function mapExtra(
  restraint: StressRestraint,
  node: number,
  axis: Vec3,
  defaultFriction: number,
  anchors: Map<number, string[]>,
  addContact: (contact: Contact) => void,
): LayoutFailure | null {
  const gap = restraint.gapMm ?? 0;
  if (restraint.kind === 'anchor') anchors.set(node, [...(anchors.get(node) ?? []), restraint.id]);
  else if (restraint.kind === 'rest') addContact(rest(node, gap, restraint.frictionCoefficient ?? defaultFriction, restraint.id));
  else if (restraint.kind === 'guide') {
    const lateral = lateralDofs(axis);
    if (lateral === null)
      return { ok: false, code: 'PST_RESTRAINT_OBLIQUE', message: `${restraint.id}: oblique pipe axis`, ids: [restraint.id], paths: [] };
    for (const dof of lateral) for (const contact of both(node, dof, gap, restraint.id)) addContact(contact);
  } else {
    const dof = AXES[restraint.axis ?? 'z'];
    const friction = restraint.frictionCoefficient ?? 0;
    const normals: (1 | -1)[] = restraint.oneWay === '+' ? [1] : restraint.oneWay === '-' ? [-1] : [1, -1];
    for (const normal of normals) addContact({ node, dof, normal, gapMm: gap, friction, sources: [restraint.id] });
  }
  return null;
}
