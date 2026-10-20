// Mechanism graph model (FR-FPR-52), pure: bodies as nodes layered by depth from the ground, tree joints as solid edges, loop-closing joints
// dashed, gear couplings dotted with their ratio. Read from inspect_dynamics data (topology, mobility, problems) and the dynamics model.

import { GROUND, type DynamicsModel } from '@core/model/dynamics';
import { isRecord } from '@lib/isRecord';

type EdgeKind = 'tree' | 'loop' | 'gear';

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly fixed: boolean;
}

export interface GraphEdge {
  readonly id: string;
  readonly kind: EdgeKind;
  readonly from: string;
  readonly to: string;
  /** ⟲ revolute, ⇕ prismatic, ● spherical, ⚙ gear (with its ratio). */
  readonly glyph: string;
  readonly label: string;
}

export interface MechanismGraphModel {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly width: number;
  readonly height: number;
  readonly dof: number | null;
  /** Problems in words (open loop, refused topology, floating body). */
  readonly problems: readonly string[];
  readonly redundant: number;
}

const GRAPH_WIDTH = 260;
const LAYER_HEIGHT = 56;
const MARGIN = 24;

const GLYPHS: Readonly<Record<string, string>> = { revolute: '⟲', prismatic: '⇕', spherical: '●' };

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** Tree and loop joints from inspect_dynamics data, else every declared joint as a tree edge. */
function topologyEdges(dynamics: DynamicsModel, data: Record<string, unknown>): GraphEdge[] {
  const topology = isRecord(data['topology']) ? data['topology'] : null;
  const loops = new Set(
    topology !== null && Array.isArray(topology['loops'])
      ? topology['loops'].flatMap((loop) => (isRecord(loop) && typeof loop['joint'] === 'string' ? [loop['joint']] : []))
      : [],
  );
  return Object.values(dynamics.joints).map((joint) => ({
    id: joint.id,
    kind: loops.has(joint.id) ? 'loop' : 'tree',
    from: joint.parent,
    to: joint.child,
    glyph: GLYPHS[joint.kind] ?? '?',
    label: joint.id,
  }));
}

function gearEdges(dynamics: DynamicsModel): GraphEdge[] {
  return Object.values(dynamics.gears).flatMap((gear) => {
    const [driver, driven] = [dynamics.joints[gear.driver], dynamics.joints[gear.driven]];
    if (driver === undefined || driven === undefined) return [];
    return [
      {
        id: gear.id,
        kind: 'gear' as const,
        from: driver.child,
        to: driven.child,
        glyph: '⚙',
        label: `1:${Number(gear.ratio.toPrecision(4))}`,
      },
    ];
  });
}

/** Depth of every body from the ground over the tree edges (unreached bodies sit one layer below the deepest). */
function depths(bodies: readonly string[], edges: readonly GraphEdge[]): Map<string, number> {
  const depth = new Map<string, number>([[GROUND, 0]]);
  const tree = edges.filter((edge) => edge.kind === 'tree');
  for (let changed = true; changed; ) {
    changed = false;
    for (const edge of tree) {
      for (const [a, b] of [
        [edge.from, edge.to],
        [edge.to, edge.from],
      ] as const) {
        const known = depth.get(a);
        if (known !== undefined && !depth.has(b)) {
          depth.set(b, known + 1);
          changed = true;
        }
      }
    }
  }
  const deepest = Math.max(0, ...depth.values());
  for (const body of bodies) if (!depth.has(body)) depth.set(body, deepest + 1);
  return depth;
}

export function buildMechanismGraph(dynamics: DynamicsModel, inspect: unknown): MechanismGraphModel {
  const data = isRecord(inspect) ? inspect : {};
  const fixed = Object.values(dynamics.bodies).filter((body) => body.fixed);
  const bodies = Object.keys(dynamics.bodies);
  // a fixed body is welded to the ground: its edges hang from the ground node
  const groundOf = (id: string): string => (fixed.some((body) => body.id === id) ? GROUND : id);
  const edges = [...topologyEdges(dynamics, data), ...gearEdges(dynamics)].map((edge) => ({
    ...edge,
    from: groundOf(edge.from),
    to: groundOf(edge.to),
  }));
  const moving = bodies.filter((id) => !fixed.some((body) => body.id === id));
  const depth = depths(moving, edges);
  const layers = new Map<number, string[]>();
  for (const id of [GROUND, ...moving]) {
    const level = depth.get(id) ?? 0;
    layers.set(level, [...(layers.get(level) ?? []), id]);
  }
  const nodes: GraphNode[] = [...layers.entries()].flatMap(([level, ids]) =>
    ids.map((id, index) => ({
      id,
      label:
        id === GROUND
          ? fixed.length > 0
            ? `ground (${fixed.map((body) => body.name ?? body.id).join(', ')})`
            : 'ground'
          : (dynamics.bodies[id]?.name ?? id),
      x: ((index + 1) * GRAPH_WIDTH) / (ids.length + 1),
      y: MARGIN + level * LAYER_HEIGHT,
      fixed: id === GROUND,
    })),
  );
  const mobility = isRecord(data['mobility']) ? data['mobility'] : null;
  const dof = mobility !== null && typeof mobility['dof'] === 'number' ? mobility['dof'] : null;
  const redundant = mobility !== null && Array.isArray(mobility['redundant']) ? mobility['redundant'].length : 0;
  const unreached = moving.filter((id) => !edges.some((edge) => edge.kind === 'tree' && (edge.from === id || edge.to === id)));
  return {
    nodes,
    edges,
    width: GRAPH_WIDTH,
    height: MARGIN * 2 + Math.max(0, ...nodes.map((node) => node.y - MARGIN)),
    dof,
    problems: [...strings(data['problems']), ...unreached.map((id) => `body '${dynamics.bodies[id]?.name ?? id}' has no joint: it floats`)],
    redundant,
  };
}
