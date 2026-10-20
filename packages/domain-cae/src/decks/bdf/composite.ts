/**
 * Composite shell property of the Nastran BDF (M6 + 06 CMP): `MAT8` per lamina, `PCOMP` with the plies bottom to top along the element normal
 * (`Z0` = -(1/2 + offset) t places the laminate for mid / top / bottom reference surfaces) and a `CORD2R` whose x axis is the rosette 0-degree
 * direction, named as the element material system (`MCID`) so the ply angles keep their rosette reference.
 */

import { dot3 } from '@lib/vec3';
import type { DeckContext, DeckRefusal } from '../context';
import { densityToAnalysis, stressPerMpa } from '../units';
import { SHELL_OFFSET } from '../../shell/meshGeometry';
import { compositePlane, laminaProblem, projectedAxis } from '../../shell/shellDeck';
import { isLaminateRefusal, laminateOf } from '../../shell/laminate';
import { cardLines } from './fields';
import { COMPOSITE_CID_BASE, failed, real, refusal, type Rounding } from './model';

/**
 * Cards of one composite shell part: CORD2R, MAT8 per lamina (ids from `nextMid`), PCOMP `pid`.
 * @failure laminate refusals (FEA_COMPOSITE_*); a non-finite value -> FEA_BDF_VALUE_INVALID
 */
export function compositeCards(
  ctx: DeckContext,
  entityId: string,
  pid: number,
  nextMid: number,
  track: Rounding,
): { readonly lines: string[]; readonly comments: string[]; readonly materials: number } | DeckRefusal {
  const idealization = ctx.analysis.parts[entityId];
  if (idealization?.kind !== 'shell' || idealization.laminate === undefined)
    return refusal('FEA_PART_INVALID', `'${entityId}' is no composite shell`);
  const laminate = laminateOf(ctx.doc, idealization.laminate.compositePartId, entityId, idealization.laminate.sectionId);
  if (isLaminateRefusal(laminate)) return refusal(laminate.code, laminate.message, [entityId]);
  const normal = compositePlane(ctx, entityId);
  if (typeof normal === 'string') return refusal('FEA_COMPOSITE_NOT_PLANAR', normal, [entityId]);
  const plies = dot3(normal, laminate.stackNormal) < 0 ? [...laminate.plies].reverse() : laminate.plies;
  const axis0 = projectedAxis(plies[0]?.axis0 ?? [1, 0, 0], normal);
  if (axis0 === null) return refusal('FEA_COMPOSITE_INVALID', 'the rosette 0-degree axis is normal to the shell', [entityId]);
  for (const name of new Set(plies.map((ply) => ply.materialName))) {
    const lamina = laminate.materials[name];
    const problem = lamina === undefined ? `lamina material '${name}' is missing` : laminaProblem(ctx.doc, name, lamina);
    if (problem !== null) return refusal('FEA_COMPOSITE_INVALID', problem, [entityId]);
  }
  const values = (entries: readonly (readonly [number, string])[]): string[] | DeckRefusal => {
    const out: (string | DeckRefusal)[] = entries.map(([value, what]) => real(value, what, track));
    const bad = out.find(failed);
    return bad !== undefined ? (bad as DeckRefusal) : (out as string[]);
  };
  const lines: string[] = [];
  const comments: string[] = [];
  const cid = COMPOSITE_CID_BASE + pid;
  const frame = values([
    ...normal.map((c): [number, string] => [c, 'material normal']),
    ...axis0.map((c): [number, string] => [c, 'rosette axis']),
  ]);
  if (!Array.isArray(frame)) return frame;
  lines.push(...cardLines('CORD2R', [String(cid), '', '0.', '0.', '0.', ...frame]));
  const mids = new Map<string, number>();
  const factor = stressPerMpa(ctx.unitSystem);
  for (const ply of plies) {
    if (mids.has(ply.materialName)) continue;
    const lamina = laminate.materials[ply.materialName];
    if (lamina === undefined) return refusal('FEA_COMPOSITE_INVALID', `lamina material '${ply.materialName}' is missing`, [entityId]);
    const mid = nextMid + mids.size;
    mids.set(ply.materialName, mid);
    const g13 = lamina.G13 ?? lamina.G12;
    const fields = values([
      [lamina.E1 * factor, 'E1'],
      [lamina.E2 * factor, 'E2'],
      [lamina.nu12, 'nu12'],
      [lamina.G12 * factor, 'G12'],
      [g13 * factor, 'G1Z'],
      [(lamina.G23 ?? g13) * factor, 'G2Z'],
      [lamina.density === undefined ? 0 : densityToAnalysis(lamina.density, ctx.doc.units, ctx.unitSystem), 'density'],
    ]);
    if (!Array.isArray(fields)) return fields;
    lines.push(...cardLines('MAT8', [String(mid), ...fields]));
    comments.push(
      `$ llull: material ${mid} = lamina '${ply.materialName}' (MAT8, ${lamina.G13 === undefined ? 'G1Z = G12, ' : ''}${lamina.G23 === undefined ? 'G2Z = G1Z' : 'G2Z = G23'})`,
    );
  }
  const offset = SHELL_OFFSET[idealization.offset];
  const z0 = real(-(0.5 + offset) * laminate.thickness * ctx.lengthToAnalysis, 'Z0', track);
  if (failed(z0)) return z0;
  const plyFields: string[] = [];
  for (const ply of plies) {
    const fields = values([
      [ply.thickness * ctx.lengthToAnalysis, 'ply thickness'],
      [ply.angleDeg, 'ply angle'],
    ]);
    if (!Array.isArray(fields)) return fields;
    plyFields.push(String(mids.get(ply.materialName) ?? 0), fields[0] ?? '', fields[1] ?? '', 'YES');
  }
  lines.push(...cardLines('PCOMP', [String(pid), z0, '', '', '', '', '', '', ...plyFields]));
  comments.push(
    `$ llull: property ${pid} = composite part '${laminate.compositePartId}' ${plies.length} plies bottom to top along the element normal, material system CORD2R ${cid}`,
  );
  return { lines, comments, materials: mids.size };
}
