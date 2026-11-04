/**
 * Supports and extra restraints to the restraint set of the solver (07 PST §5.1 step 4): rigid anchors and unilateral contacts. A contact blocks
 * motion toward `-normal` along one direction beyond `gapMm` (a rest on +Z has normal +1: it reacts upward only); a two-way restraint is two
 * contacts. A direction along a global axis is a plain degree of freedom; any other (a guide on a pipe oblique in plan, a translational restraint
 * with a `direction`) is an oblique contact, solved through a stiff ground bar (`solve/nonlinear.ts`).
 */

import type { Vec3 } from '@core/model/vectors';
import type { StressModel, StressRestraint } from './schema';
import type { Layout, LayoutFailure } from './layoutTypes';
import type { SourceSupport } from './sources';

export interface Contact {
  readonly node: number;
  /** Global translation DOF 0..2; -1 for an oblique contact (see `direction`). */
  readonly dof: number;
  /** Oblique contact: unit direction in global axes (the contact blocks motion toward -normal x direction). */
  readonly direction?: Vec3;
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
const ALIGNED_RATIO = Math.tan((5 * Math.PI) / 180);

type Lateral = { readonly dofs: readonly number[] } | { readonly direction: Vec3 };

/** The global axis a unit vector lies along (all other components below 1e-9), or null. */
function alignedAxis(direction: Vec3): number | null {
  const big = [0, 1, 2].filter((i) => Math.abs(direction[i] as number) > 1e-9);
  return big.length === 1 ? (big[0] as number) : null;
}

/** Lateral restraint directions of a guide on a pipe along `axis`: both horizontal axes on a riser, the horizontal normal otherwise (a global axis when the pipe is within 5 degrees of the other one). */
function lateralOf(axis: Vec3): Lateral {
  const ax = Math.abs(axis[0]);
  const ay = Math.abs(axis[1]);
  if (Math.hypot(ax, ay) < 0.2) return { dofs: [0, 1] };
  if (Math.min(ax, ay) <= ALIGNED_RATIO * Math.max(ax, ay)) return { dofs: [ax > ay ? 1 : 0] };
  const length = Math.hypot(ax, ay);
  return { direction: [-(axis[1] as number) / length, (axis[0] as number) / length, 0] };
}

const bothAxis = (node: number, dof: number, gapMm: number, source: string): Contact[] => [
  { node, dof, normal: 1, gapMm, friction: 0, sources: [source] },
  { node, dof, normal: -1, gapMm, friction: 0, sources: [source] },
];

const along = (node: number, direction: Vec3, normals: readonly (1 | -1)[], gapMm: number, source: string): Contact[] => {
  const axis = alignedAxis(direction);
  return normals.map((normal) =>
    axis === null
      ? { node, dof: -1, direction, normal, gapMm, friction: 0, sources: [source] }
      : { node, dof: axis, normal: (normal * Math.sign(direction[axis] as number)) as 1 | -1, gapMm, friction: 0, sources: [source] },
  );
};

const rest = (node: number, gapMm: number, friction: number, source: string): Contact => ({
  node,
  dof: 2,
  normal: 1,
  gapMm,
  friction,
  sources: [source],
});

const contactKey = (contact: Contact): string =>
  `${contact.node}:${contact.direction === undefined ? contact.dof : (contact.direction as Vec3).map((v) => v.toFixed(9)).join(',')}:${contact.normal}`;

/**
 * @failure restraint on an unknown support / attachment -> PST_POINT_OFF_PIPE; friction on an oblique direction -> PST_PARAM_INVALID
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
    const key = contactKey(contact);
    if (contacts.has(key))
      warnings.push({
        code: 'PST_RESTRAINT_OVERRIDDEN',
        message: `a restraint replaces another at node ${contact.node + 1} dof ${contact.dof}`,
        ids: [...contact.sources],
      });
    contacts.set(key, contact);
  };
  for (const support of supports) {
    const at = layout.attached.get(`support:${support.id}`);
    if (at === undefined) continue;
    const { node, axis } = at;
    if (support.type === 'anchor') anchors.set(node, [...(anchors.get(node) ?? []), support.id]);
    else if (support.type === 'shoe') addContact(rest(node, 0, model.frictionCoefficient, support.id));
    else if (support.type === 'hanger') addContact(rest(node, 0, 0, support.id));
    else {
      if (Math.abs(axis[2]) < 0.9) addContact(rest(node, 0, model.frictionCoefficient, support.id));
      for (const contact of guideContacts(node, axis, 0, support.id)) addContact(contact);
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

function guideContacts(node: number, axis: Vec3, gapMm: number, source: string): Contact[] {
  const lateral = lateralOf(axis);
  return 'dofs' in lateral
    ? lateral.dofs.flatMap((dof) => bothAxis(node, dof, gapMm, source))
    : along(node, lateral.direction, [1, -1], gapMm, source);
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
  else if (restraint.kind === 'guide') for (const contact of guideContacts(node, axis, gap, restraint.id)) addContact(contact);
  else {
    const friction = restraint.frictionCoefficient ?? 0;
    const normals: (1 | -1)[] = restraint.oneWay === '+' ? [1] : restraint.oneWay === '-' ? [-1] : [1, -1];
    if (restraint.direction !== undefined) {
      const size = Math.hypot(...restraint.direction);
      const direction: Vec3 = [restraint.direction[0] / size, restraint.direction[1] / size, restraint.direction[2] / size];
      if (friction > 0 && alignedAxis(direction) === null)
        return {
          ok: false,
          code: 'PST_PARAM_INVALID',
          message: `${restraint.id}: friction is modelled on axis-aligned restraints only, not on an oblique direction`,
          ids: [restraint.id],
          paths: ['frictionCoefficient'],
        };
      for (const contact of along(node, direction, normals, gap, restraint.id))
        addContact({ ...contact, friction: contact.dof >= 0 ? friction : 0 });
    } else {
      const dof = AXES[restraint.axis ?? 'z'];
      for (const normal of normals) addContact({ node, dof, normal, gapMm: gap, friction, sources: [restraint.id] });
    }
  }
  return null;
}
