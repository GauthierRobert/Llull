/** laminate_mass: area, volume, mass and centre of gravity of a composite part, ramps included (FR-CMP-33). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import type { Vec2, Vec3 } from '@core/model/types';
import { polygonArea, polygonCentroid } from '@lib/polygon';
import { add3, scale3 } from '@lib/vec3';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { piecesOf } from './geometry2d';
import { isUnverified } from './provenance';
import { compositesOf, findPart, pliesOf } from './state';
import { fromFlat, normalAt } from './surface';

/**
 * @affects nothing (read-only)
 * @invariant volume = sum over ply pieces of (flat area x ply thickness), mass = volume x density, so ramp extensions are counted; the flat area equals the face area on plane, cylinder and cone faces (developable); cg = area-weighted ply piece centroids mapped to the face, lifted to the ply mid-height
 * @failure unknown part -> CMP_REF_MISSING; no plies -> CMP_NO_PLIES; a used material without density -> CMP_MATERIAL_DENSITY_MISSING
 */
export const laminateMass = defineCommand({
  name: 'laminate_mass',
  annotations: { readOnly: true },
  description:
    'Laminate weight budget of a composite part (plies, prepreg, layup): for every ply the covered area (ramp extensions included) times its ' +
    'cured thickness gives volume, times the lamina density gives the ply weight. Returns ply area, laminate volume, total laminate weight, ' +
    'the centre of gravity [x, y, z] in the document frame (ply centroids mapped from the flat pattern onto the tool face and lifted to each ' +
    'ply mid-height) and per-material totals. Lengths are document units, volume is units^3, weight is in the density unit times units^3 ' +
    '(g when density is g/mm^3 in a mm document). Results from "mean" / "unknown" lamina data are flagged unverified. Refused when a used ' +
    'material has no density. Read-only.',
  params: z.object({ part: z.string().describe('Part id or name.') }),
  run: (doc, { part: partRef }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'laminate_mass', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const plies = pliesOf(model, part.id);
    if (plies.length === 0)
      return refuseCmp(doc, 'laminate_mass', 'CMP_NO_PLIES', `part "${part.name}" has no plies`, [part.id], ['params.part']);
    const side = part.laminateSide === 'positive_normal' ? 1 : -1;
    let z = 0;
    let area = 0;
    let volume = 0;
    let mass = 0;
    let moment: Vec3 = [0, 0, 0];
    const perMaterial = new Map<string, { area: number; volume: number; mass: number; plies: number }>();
    for (const ply of plies) {
      const material = model.materials[ply.materialName];
      if (material === undefined)
        return refuseCmp(doc, 'laminate_mass', 'CMP_REF_MISSING', `ply "${ply.name}" uses unknown material '${ply.materialName}'`, [
          ply.id,
        ]);
      if (material.density === undefined)
        return refuseCmp(
          doc,
          'laminate_mass',
          'CMP_MATERIAL_DENSITY_MISSING',
          `material "${material.name}" has no density`,
          [ply.id],
          [`materials.${material.name}`],
        );
      const mid = z + material.plyThickness / 2;
      z += material.plyThickness;
      for (const piece of piecesOf(ply, part)) {
        const pieceArea = polygonArea(piece);
        const pieceMass = pieceArea * material.plyThickness * material.density;
        const centre: Vec2 = polygonCentroid(piece);
        const point = add3(fromFlat(part.surface, centre), scale3(normalAt(part.surface, centre), side * mid));
        area += pieceArea;
        volume += pieceArea * material.plyThickness;
        mass += pieceMass;
        moment = add3(moment, scale3(point, pieceMass));
      }
      const entry = perMaterial.get(material.name) ?? { area: 0, volume: 0, mass: 0, plies: 0 };
      const planar = piecesOf(ply, part).reduce((sum, piece) => sum + polygonArea(piece), 0);
      perMaterial.set(material.name, {
        area: entry.area + planar,
        volume: entry.volume + planar * material.plyThickness,
        mass: entry.mass + planar * material.plyThickness * material.density,
        plies: entry.plies + 1,
      });
    }
    const cg = scale3(moment, 1 / mass);
    const unverified = plies.some((ply) => {
      const used = model.materials[ply.materialName];
      return used !== undefined && isUnverified(used);
    });
    return report(
      doc,
      `laminate_mass: part "${part.name}": ${plies.length} plies, mass ${sig(mass)} (density unit x ${doc.units}^3), volume ${sig(volume)} ${doc.units}^3, ply area ${sig(area)} ${doc.units}^2${unverified ? '; UNVERIFIED material data' : ''}.`,
      {
        part: part.id,
        plyCount: plies.length,
        lengthUnit: doc.units,
        thickness: sig(z),
        area: sig(area),
        volume: sig(volume),
        mass: sig(mass),
        massUnit: 'density unit x length unit^3',
        cg: cg.map(sig),
        perMaterial: Object.fromEntries(
          [...perMaterial].map(([name, entry]) => [
            name,
            { plies: entry.plies, area: sig(entry.area), volume: sig(entry.volume), mass: sig(entry.mass) },
          ]),
        ),
        unverified,
        provenance: { method: 'sum of ply piece area x thickness x density', reference: 'llull composites', inputs: { part: part.id } },
      },
    );
  },
});
