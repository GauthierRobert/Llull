/**
 * Portal frame moment connections: bolted end plates at eaves (with haunch) and apex joints.
 * @layer domain-aec
 */

import type { BuildingModel, MomentConnectionElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { elementAffected, fromMm, getBuilding } from '../model';
import { noop } from '@core/commands/noop';
import { regenerateBuilding } from '../evaluateElements';
import { findProfile, STEEL_DENSITY_KG_PER_M3 } from '../steel/profiles';
import { boltSize } from './evaluate';
import { buildingConnectionSolids } from './evaluateConnections';
import { appendConnections, findMomentJoints } from './connectionSupport';
import { polygonArea } from '@lib/polygon';

/** Steel mass of a connection in kg: its modelled end plate(s) + haunch (half the rafter section per metre). */
export function connectionMass(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  connection: MomentConnectionElement,
): number {
  const rafter = building.elements[connection.rafterId];
  const profile = rafter?.category === 'member' ? findProfile(rafter.profile) : undefined;
  const solids = buildingConnectionSolids(doc, building, connection);
  if (!profile || !solids) return 0;
  const cubicMetres = (value: number): number => value / fromMm(doc, 1000) ** 3;
  const plates = solids
    .filter((solid) => solid.part.startsWith('plate'))
    .reduce((sum, solid) => sum + Math.abs(polygonArea(solid.outline)) * solid.depth, 0);
  const metres = connection.haunchLength / fromMm(doc, 1000);
  return cubicMetres(plates) * STEEL_DENSITY_KG_PER_M3 + (metres * profile.massPerMetre) / 2;
}

/**
 * @command add_moment_connections
 * @pure
 * @affects creates 1 connection per unconnected eaves / apex joint of the rafters
 * @failure bad sizes / no unconnected joints -> no-op
 */
export const addMomentConnections = defineCommand({
  name: 'add_moment_connections',
  description:
    'Detail the portal frame moment connections: a bolted end plate at every rafter-to-column joint ' +
    '(eaves, with a haunch under the rafter) and a pair of end plates at every rafter-to-rafter joint ' +
    '(apex), for the given rafters or every rafter of the level. Sized from the rafter section ' +
    '(plate 20/25 mm, M20 bolts, haunch = 1/5 of the rafter plan length). Follows the rafter; plate, ' +
    'haunch and bolt quantities feed the takeoff and the connection schedule.',
  params: z.object({
    rafterIds: z
      .array(z.string())
      .optional()
      .describe('Rafter member ids. Default: every rafter of the level.'),
    levelId: z.string().optional().describe('Level id. Default: the active level.'),
    plateThickness: z.number().optional().describe('End plate thickness. Default 20 / 25 mm.'),
    boltDiameter: z.number().optional().describe('Bolt diameter. Default 20 mm (M20).'),
    haunchLength: z
      .number()
      .optional()
      .describe('Eaves haunch length along the rafter. Default 1/5 of its plan length.'),
  }),
  run: (doc, params): CommandResult => {
    const { plateThickness, boltDiameter, haunchLength } = params;
    const positive = (value: number | undefined): boolean => value === undefined || value > 0;
    if (!positive(plateThickness) || !positive(boltDiameter) || !positive(haunchLength)) {
      return noop(
        doc,
        'add_moment_connections failed: plateThickness, boltDiameter and haunchLength must be > 0.',
      );
    }
    const building = getBuilding(doc);
    if (params.levelId !== undefined && !building.levels[params.levelId]) {
      return noop(doc, `add_moment_connections failed: no level '${params.levelId}'.`);
    }
    const levelId = params.levelId ?? building.activeLevelId ?? building.levelOrder[0] ?? '';
    const joints = findMomentJoints(
      building,
      levelId,
      params.rafterIds ? new Set(params.rafterIds) : null,
      fromMm(doc, 10),
    );
    if (joints.length === 0) {
      return noop(
        doc,
        'add_moment_connections failed: no unconnected rafter-to-column or rafter-to-rafter joint found.',
      );
    }
    const added = appendConnections(doc, building, levelId, joints, {
      plateThickness,
      boltDiameter,
      haunchLength,
    });
    const document = regenerateBuilding(doc, added.building);
    const connections = added.ids.map(
      (id) => added.building.elements[id] as MomentConnectionElement,
    );
    const eaves = connections.filter((connection) => connection.kind === 'eaves').length;
    const bolts = connections.reduce((sum, connection) => sum + 2 * connection.boltRows, 0);
    const kilograms = connections.reduce(
      (sum, connection) => sum + connectionMass(doc, added.building, connection),
      0,
    );
    return {
      document,
      summary:
        `Added ${connections.length} moment connection(s): ${eaves} eaves (haunched), ` +
        `${connections.length - eaves} apex; ${bolts} bolt(s) ${boltSize(doc, connections[0]?.boltDiameter ?? 0)}, ` +
        `${kilograms.toFixed(1)} kg of plates and haunches.`,
      affected: elementAffected(document, added.ids),
      data: { elementIds: added.ids },
    };
  },
});

export interface ConnectionWelds {
  /** Fillet throat thickness of the flange welds, mm. */
  readonly flangeThroat: number;
  /** Fillet throat thickness of the web (and haunch) welds, mm. */
  readonly webThroat: number;
  /** Total weld length, mm. */
  readonly length: number;
  /** Deposited weld metal, kg. */
  readonly metal: number;
}

/**
 * Throat / thickness ratio of a full-strength double fillet weld (EN 1993-1-8 §4.5.3.3,
 * directional method): a/t = βw · fy · γM2 / (√2 · fu · γM0). S235 0.46, S275 0.48, S355 0.58,
 * S460 0.75.
 */
export function fullStrengthFactor(fy: number): number {
  const grades: ReadonlyArray<readonly [number, number, number]> = [
    // fy, fu, βw
    [235, 360, 0.8],
    [275, 430, 0.85],
    [355, 490, 0.9],
    [420, 520, 1.0],
    [460, 540, 1.0],
  ];
  const [, fu, beta] =
    grades.find(([grade]) => grade >= fy) ??
    (grades[grades.length - 1] as readonly [number, number, number]);
  return (beta * fy * 1.25) / (Math.SQRT2 * fu);
}

/**
 * Full-strength double fillet welds of the rafter (and haunch) to the end plate(s):
 * throat a = fullStrengthFactor(fy) · t, rounded up to whole mm, ≥ 3 mm.
 */
export function connectionWelds(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  connection: MomentConnectionElement,
): ConnectionWelds | null {
  const rafter = building.elements[connection.rafterId];
  const profile = rafter?.category === 'member' ? findProfile(rafter.profile) : undefined;
  if (!profile) return null;
  const fy =
    Number(/S\s*(\d{3})/i.exec(rafter?.category === 'member' ? rafter.material : '')?.[1]) || 355;
  const factor = fullStrengthFactor(fy);
  const throat = (thickness: number): number => Math.max(3, Math.ceil(factor * thickness));
  const [flangeThroat, webThroat] = [throat(profile.tf), throat(profile.tw)];
  const flanges = 2 * (2 * profile.b - profile.tw);
  const web = 2 * (profile.h - 2 * profile.tf);
  const plates = connection.kind === 'apex' ? 2 : 1;
  const haunch = connection.haunchLength / fromMm(doc, 1);
  // Haunch: web to rafter flange both sides, haunch flange + web to the end plate.
  const haunchWeb = haunch > 0 ? 2 * haunch + 2 * profile.h : 0;
  const haunchFlange = haunch > 0 ? 2 * profile.b : 0;
  const flangeLength = plates * flanges + haunchFlange;
  const webLength = plates * web + haunchWeb;
  const metal =
    (flangeThroat ** 2 * flangeLength + webThroat ** 2 * webLength) *
    STEEL_DENSITY_KG_PER_M3 *
    1e-9;
  return { flangeThroat, webThroat, length: flangeLength + webLength, metal };
}
