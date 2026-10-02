/**
 * Portal hall steel member layout: frames, gable posts, purlins, side rails, X-bracing.
 * @layer domain-aec
 */

import type { HallGeometry, MemberSpec, PortalProfiles } from './portalGeometry';

export interface HallMemberInput {
  readonly geometry: HallGeometry;
  readonly profiles: PortalProfiles;
  readonly purlinSpacing: number;
  readonly railSpacing: number;
}

/** Member specs of the whole hall frame (no crane, footings or cladding). */
export function hallMemberSpecs(input: HallMemberInput): MemberSpec[] {
  const { geometry, profiles: p, purlinSpacing, railSpacing } = input;
  const { mm, h, bays, pitch, columnLines, spanBounds, x0, x1, ys, y0, yEnd } = geometry;
  const { roofLine, columnTop, slopesOf } = geometry;
  const specs: MemberSpec[] = [];

  // Portal frames: columns on every column line, the rafters of every roof slope per span.
  for (const y of ys) {
    for (const x of columnLines) {
      specs.push({
        role: 'column',
        profile: p.column.name,
        start: [x, y, 0],
        end: [x, y, columnTop(x)],
      });
    }
    for (const bounds of spanBounds) {
      for (const slope of slopesOf(bounds)) {
        specs.push({
          role: 'rafter',
          profile: p.rafter.name,
          start: [slope.lowX, y, slope.lowZ],
          end: [slope.highX, y, slope.highZ],
        });
      }
    }
  }
  // Gable wind posts at both ends (≈ 6 m centres per span), up to the rafter underside.
  for (const [a, b] of spanBounds) {
    const posts = Math.max(0, Math.ceil((b - a) / mm(6000)) - 1);
    for (const y of [y0, yEnd]) {
      for (let index = 1; index <= posts; index++) {
        const x = a + ((b - a) * index) / (posts + 1);
        const roofZ = roofLine(x) - h(p.rafter) / 2 / Math.cos(pitch);
        // Wind posts span out of the gable plane: strong axis along Y.
        specs.push({
          role: 'column',
          profile: p.gable.name,
          start: [x, y, 0],
          end: [x, y, roofZ],
          roll: Math.PI / 2,
        });
      }
    }
  }
  // Purlins on every slope of every span, one per bay.
  const lift = h(p.rafter) / 2 + h(p.purlin) / 2;
  for (const bounds of spanBounds) {
    for (const { side, lowX, lowZ, highX } of slopesOf(bounds)) {
      const slopeLength = Math.abs(highX - lowX) / Math.cos(pitch);
      const purlinCount = Math.max(1, Math.ceil(slopeLength / purlinSpacing));
      for (let index = 0; index <= purlinCount; index++) {
        const t = (index * slopeLength) / purlinCount;
        const x = lowX - side * t * Math.cos(pitch) + side * lift * Math.sin(pitch);
        const z = lowZ + t * Math.sin(pitch) + lift * Math.cos(pitch);
        for (let j = 0; j < bays; j++) {
          specs.push({
            role: 'purlin',
            profile: p.purlin.name,
            start: [x, ys[j] as number, z],
            end: [x, ys[j + 1] as number, z],
            roll: side === -1 ? pitch : -pitch,
          });
        }
      }
    }
  }
  // Side rails, outboard of the outer columns, up to the eaves of their own column line.
  const railOffset = h(p.column) / 2 + h(p.rail) / 2;
  const railSides = [
    [x0 - railOffset, Math.PI / 2, columnTop(x0)],
    [x1 + railOffset, -Math.PI / 2, columnTop(x1)],
  ] as const;
  const railTop = Math.max(...railSides.map(([, , top]) => top));
  for (let z = railSpacing; z < railTop - railSpacing / 3; z += railSpacing) {
    for (const [x, roll, top] of railSides) {
      if (z >= top - railSpacing / 3) continue;
      for (let j = 0; j < bays; j++) {
        specs.push({
          role: 'rail',
          profile: p.rail.name,
          start: [x, ys[j] as number, z],
          end: [x, ys[j + 1] as number, z],
          roll,
        });
      }
    }
  }
  // X-bracing in the end bays: every roof slope and both outer walls.
  const endBays = bays >= 3 ? [0, bays - 1] : [0];
  for (const j of endBays) {
    const [ya, yb] = [ys[j] as number, ys[j + 1] as number];
    for (const bounds of spanBounds) {
      for (const { lowX, lowZ, highX, highZ } of slopesOf(bounds)) {
        specs.push(
          {
            role: 'brace',
            profile: p.brace.name,
            start: [lowX, ya, lowZ],
            end: [highX, yb, highZ],
          },
          {
            role: 'brace',
            profile: p.brace.name,
            start: [lowX, yb, lowZ],
            end: [highX, ya, highZ],
          },
        );
      }
    }
    for (const fromX of [x0, x1]) {
      const top = columnTop(fromX);
      specs.push(
        { role: 'brace', profile: p.brace.name, start: [fromX, ya, 0], end: [fromX, yb, top] },
        { role: 'brace', profile: p.brace.name, start: [fromX, yb, 0], end: [fromX, ya, top] },
      );
    }
  }
  return specs;
}
