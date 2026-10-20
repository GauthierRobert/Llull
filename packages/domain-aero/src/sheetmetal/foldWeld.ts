/**
 * Removes the internal faces of a folded-solid triangle soup: where a flat and a bend meet face to face, the two coincident, oppositely
 * wound caps are dropped so the mesh is one closed shell (area and watertightness are those of the real part).
 */

export interface TriangleSoup {
  readonly positions: number[];
  readonly indices: number[];
}

const QUANTUM = 1e5;

const quantize = (value: number): number => Math.round(value * QUANTUM) + 0;

interface Face {
  readonly planeKey: string;
  readonly sign: 1 | -1;
  readonly corners: readonly [string, string, string];
  readonly area: number;
}

function faceOf(positions: readonly number[], indices: readonly number[], t: number): Face | null {
  const corner = (k: number): [number, number, number] => {
    const base = (indices[t + k] ?? 0) * 3;
    return [positions[base] ?? 0, positions[base + 1] ?? 0, positions[base + 2] ?? 0];
  };
  const [a, b, c] = [corner(0), corner(1), corner(2)];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]] as const;
  const length = Math.hypot(n[0], n[1], n[2]);
  if (length < 1e-12) return null;
  const unit = [n[0] / length, n[1] / length, n[2] / length] as const;
  const lead = unit.find((component) => Math.abs(component) > 1e-6) ?? 0;
  const sign = lead >= 0 ? 1 : -1;
  const direction = unit.map((component) => quantize(component * sign));
  const offset = quantize((a[0] * unit[0] + a[1] * unit[1] + a[2] * unit[2]) * sign);
  const key = (p: readonly number[]): string => p.map(quantize).join(',');
  return { planeKey: `${direction.join(',')}|${offset}`, sign, corners: [key(a), key(b), key(c)], area: length / 2 };
}

/** Connected components (by shared corner) of the faces of one plane and winding; each as the indices into `faces`. */
function components(faces: readonly Face[], members: readonly number[]): number[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    parent.set(x, root);
    return root;
  };
  for (const index of members) {
    const [first, ...rest] = faces[index]?.corners ?? [];
    if (first === undefined) continue;
    for (const other of rest) parent.set(find(other), find(first));
  }
  const groups = new Map<string, number[]>();
  for (const index of members) {
    const first = faces[index]?.corners[0];
    if (first === undefined) continue;
    const root = find(first);
    groups.set(root, [...(groups.get(root) ?? []), index]);
  }
  return [...groups.values()];
}

function signature(faces: readonly Face[], component: readonly number[]): string {
  const vertices = new Set(component.flatMap((index) => faces[index]?.corners ?? []));
  const area = component.reduce((sum, index) => sum + (faces[index]?.area ?? 0), 0);
  return `${[...vertices].sort().join(';')}|${Math.round(area * 1e3)}`;
}

/** The soup without every pair of coplanar, oppositely wound face regions that cover exactly the same corners and area. */
export function removeInternalFaces(soup: TriangleSoup): TriangleSoup {
  const { positions, indices } = soup;
  const faces: (Face | null)[] = [];
  for (let t = 0; t < indices.length; t += 3) faces.push(faceOf(positions, indices, t));
  const byPlane = new Map<string, number[]>();
  faces.forEach((face, index) => {
    if (face) byPlane.set(face.planeKey, [...(byPlane.get(face.planeKey) ?? []), index]);
  });
  const dropped = new Set<number>();
  const valid = faces.map((face) => face ?? { planeKey: '', sign: 1 as const, corners: ['', '', ''] as const, area: 0 });
  for (const members of byPlane.values()) {
    const front = members.filter((index) => valid[index]?.sign === 1);
    const back = members.filter((index) => valid[index]?.sign === -1);
    if (front.length === 0 || back.length === 0) continue;
    const backBySignature = new Map<string, number[]>();
    for (const component of components(valid, back)) backBySignature.set(signature(valid, component), component);
    for (const component of components(valid, front)) {
      const key = signature(valid, component);
      const match = backBySignature.get(key);
      if (match === undefined) continue;
      backBySignature.delete(key);
      for (const index of [...component, ...match]) dropped.add(index);
    }
  }
  if (dropped.size === 0) return soup;
  const kept: number[] = [];
  for (let t = 0; t < indices.length; t += 3) if (!dropped.has(t / 3)) kept.push(indices[t] ?? 0, indices[t + 1] ?? 0, indices[t + 2] ?? 0);
  return { positions, indices: kept };
}
