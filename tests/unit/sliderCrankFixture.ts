/**
 * Planar slider-crank built through the commands, for the PHY-21 loop / engine tests. Crank axis Z through the origin, piston travelling
 * along +X (head at +X). Lengths in mm (document units). Joint ids are fixed: crank_j (ground -> crank), rod_j (crank -> rod, the crank
 * pin), wrist_j (rod -> piston, closes the loop), slide_j (ground -> piston, prismatic).
 */
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

export interface SliderCrankOptions {
  /** Crank radius, mm. Default 49.2125 (3.875 in stroke / 2). */
  rMm?: number;
  /** Rod length between the pin centres, mm. Default 150. */
  lMm?: number;
  /** Crank angle at t = 0 measured from TDC, deg. Default 0. */
  startDeg?: number;
  wrist?: 'revolute' | 'spherical';
  pistonKg?: number;
  rodKg?: number;
  /** Moment of inertia of the crank body about its axis, kg·m². Default 0.05. */
  crankInertia?: number;
  /** Shift of the wrist pin on the piston along Y, mm: makes the loop open by this much. */
  wristGapMm?: number;
  /** Crank speed at t = 0, rpm (avoids the start-up transient of a governed run). */
  crankRpm?: number;
  /** Declare the joints in this order (default crank, rod, wrist, slide). */
  order?: ('crank_j' | 'rod_j' | 'wrist_j' | 'slide_j')[];
}

export interface SliderCrank {
  doc: CadDocument;
  bodies: { crank: string; rod: string; piston: string };
  /** Geometry in metres and radians. */
  r: number;
  l: number;
  startRad: number;
}

function step(doc: CadDocument, command: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params);
  if (result.affected.length === 0) throw new Error(result.summary);
  return { doc: result.document, id: result.affected[0] ?? '' };
}

export function sliderCrank(options: SliderCrankOptions = {}): SliderCrank {
  const { rMm = 49.2125, lMm = 150, startDeg = 0, wrist = 'spherical', pistonKg = 0.4, rodKg = 0.001 } = options;
  const angle = (startDeg * Math.PI) / 180;
  const pin = [rMm * Math.cos(angle), rMm * Math.sin(angle), 0] as const;
  const wristX = pin[0] + Math.sqrt(lMm * lMm - pin[1] * pin[1]);
  const crankRadius = 80;
  const crankMass = (2 * (options.crankInertia ?? 0.05)) / (crankRadius / 1000) ** 2;
  let doc = createEmptyDocument();
  const crankSolid = step(doc, 'add_cylinder', { radius: crankRadius, height: 20, axis: [0, 0, 1], position: [0, 0, 0] });
  const rodSolid = step(crankSolid.doc, 'add_box', { size: [lMm, 10, 10], position: [(pin[0] + wristX) / 2, pin[1] / 2, 0] });
  const pistonSolid = step(rodSolid.doc, 'add_box', { size: [30, 30, 30], position: [wristX, 0, 0] });
  const crank = step(pistonSolid.doc, 'add_rigid_body', { entityIds: [crankSolid.id], massKg: crankMass, id: 'crank' });
  const rod = step(crank.doc, 'add_rigid_body', { entityIds: [rodSolid.id], massKg: rodKg, id: 'rod' });
  const piston = step(rod.doc, 'add_rigid_body', { entityIds: [pistonSolid.id], massKg: pistonKg, id: 'piston' });
  doc = piston.doc;
  const joints = {
    crank_j: { kind: 'revolute', child: 'crank', anchor: [0, 0, 0], axis: [0, 0, 1], initialRpm: options.crankRpm ?? 0 },
    rod_j: { kind: 'revolute', child: 'rod', parent: 'crank', anchor: [...pin], axis: [0, 0, 1] },
    wrist_j: {
      kind: wrist,
      child: 'piston',
      parent: 'rod',
      anchor: [wristX, 0, 0],
      axis: [0, 0, 1],
      ...(options.wristGapMm !== undefined ? { anchorOnChild: [wristX, options.wristGapMm, 0] } : {}),
    },
    slide_j: { kind: 'prismatic', child: 'piston', anchor: [wristX, 0, 0], axis: [1, 0, 0] },
  } as const;
  for (const id of options.order ?? (['crank_j', 'rod_j', 'wrist_j', 'slide_j'] as const))
    doc = step(doc, 'add_body_joint', { ...joints[id], id }).doc;
  return { doc, bodies: { crank: 'crank', rod: 'rod', piston: 'piston' }, r: rMm / 1000, l: lMm / 1000, startRad: angle };
}

/** Exact slider-crank travel from TDC, m, at crank angle `theta` (rad) from TDC. */
export function travel(r: number, l: number, theta: number): number {
  const lambda = r / l;
  return r * (1 - Math.cos(theta)) + l * (1 - Math.sqrt(1 - lambda * lambda * Math.sin(theta) ** 2));
}

/** dx/dtheta, m/rad: the crank torque per newton of gas force. */
export function travelRate(r: number, l: number, theta: number): number {
  const lambda = r / l;
  return r * (Math.sin(theta) + (lambda * Math.sin(2 * theta)) / (2 * Math.sqrt(1 - lambda * lambda * Math.sin(theta) ** 2)));
}
