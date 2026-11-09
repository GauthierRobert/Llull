/**
 * Joint stiffness of a bolted stack by the frustum method (Budynas and Nisbett, Shigley's Mechanical Engineering Design, 10th ed., section 8-2):
 * member stiffness from pressure cones of half-angle 30 degrees starting at the washer face (1.5 d) and meeting at mid-grip, eq. 8-18 per segment,
 * which for one material reduces to eq. 8-20; bolt stiffness eq. 8-13 for a shank over the whole grip. Millimetres, MPa, N/mm.
 */

const TAN_HALF_ANGLE = Math.tan((30 * Math.PI) / 180);
/** Diameter of the pressure cone at the bearing face, in bolt diameters (Shigley: washer face 1.5 d). */
const FACE_DIAMETERS = 1.5;

export interface StackLayer {
  /** Thickness along the bolt axis, mm. */
  readonly thickness: number;
  /** Young's modulus of the layer, MPa. */
  readonly modulus: number;
}

/** Eq. 8-18: stiffness of a frustum of thickness `t` whose small end has diameter `D` around a hole `d`, modulus `E`. */
function frustum(d: number, D: number, t: number, E: number): number {
  const a = 2 * t * TAN_HALF_ANGLE;
  return (Math.PI * E * d * TAN_HALF_ANGLE) / Math.log(((a + D - d) * (D + d)) / ((a + D + d) * (D - d)));
}

/** Compliance (1/k) of the cone half that starts at the face and runs through `layers` (in order from the face) for a depth `depth`. */
function halfCompliance(d: number, layers: readonly StackLayer[], depth: number): number {
  let compliance = 0;
  let z = 0;
  for (const layer of layers) {
    const t = Math.min(layer.thickness, depth - z);
    if (t <= 0) break;
    compliance += 1 / frustum(d, FACE_DIAMETERS * d + 2 * z * TAN_HALF_ANGLE, t, layer.modulus);
    z += t;
  }
  return compliance;
}

/**
 * Stiffness of the clamped members (N/mm): two cones from the two bearing faces, each over half the grip, in series; layers split at mid-grip.
 * @invariant a stack of identical layers equals one layer of the total thickness (eq. 8-20)
 */
export function membersStiffness(layers: readonly StackLayer[], diameter: number): number {
  const grip = layers.reduce((sum, layer) => sum + layer.thickness, 0);
  const fromFace = halfCompliance(diameter, layers, grip / 2);
  const fromOtherFace = halfCompliance(diameter, [...layers].reverse(), grip / 2);
  return 1 / (fromFace + fromOtherFace);
}

/** Eq. 8-13 with no thread in the grip: k_b = A_d E / l, the shank of nominal diameter `diameter` over the grip `grip` (mm), modulus MPa. */
export const boltStiffness = (diameter: number, grip: number, modulus: number): number =>
  (Math.PI * diameter * diameter * modulus) / (4 * grip);

/** Joint stiffness factor phi = k_b / (k_b + k_m) (VDI 2230 / Shigley load factor C, eq. 8-22), for the load introduced at the bearing faces. */
export const stiffnessFactor = (kBolt: number, kMembers: number): number => kBolt / (kBolt + kMembers);
