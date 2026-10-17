/** `*BOUNDARY`, `*DFLUX`, `*CFLUX`, `*FILM`, `*RADIATE` blocks of the thermal step (PHY-03 §5.1, §5.2), values in the case unit system. */

import type { CavityRadiation, ThermalBcRecord, ThermalSetup } from '@core/model/analysis';
import { siToSystem } from '@lib/thermalUnits';
import { safeName, type DeckContext, type DeckRefusal } from '../decks/context';
import { commentText, num, row } from '../decks/format';
import { analysisLengthMetres } from '../shared/defaults';
import { amplitudeName } from './deckNames';
import { absoluteZeroOf, inScale, siOf } from './quantities';

export type Blocks = { readonly lines: readonly string[] } | DeckRefusal;

const refusal = (code: string, message: string, ids: readonly string[]): DeckRefusal => ({ code, message, ids });
const keyword = (name: string, record: ThermalBcRecord): string =>
  record.amplitude === undefined ? `*${name}` : `*${name}, AMPLITUDE=${amplitudeName(record.amplitude)}`;

function faceLines(ctx: DeckContext, key: string, label: string, ...tail: readonly (number | string)[]): string[] {
  return ctx.faces(key).map(([element, face]) => row(element, `${label}${face}`, ...tail));
}

function nodeSetOf(ctx: DeckContext, key: string): string | null {
  const nodes = Object.hasOwn(ctx.mesh.nodeSets, key) ? (ctx.mesh.nodeSets[key] ?? []) : [];
  return nodes.length === 0 ? null : ctx.nset(key);
}

/**
 * Lines of one BC. Temperatures are written on the case scale; flux, film, generation and power in the unit system.
 * @failure target without nodes / faces in the mesh -> FEA_TARGET_UNRESOLVED (ids: the BC); total generation on a part without volume -> FEA_PART_INVALID
 */
export function bcLines(ctx: DeckContext, thermal: ThermalSetup, record: ThermalBcRecord, volumes: ReadonlyMap<string, number>): Blocks {
  const bc = record.bc;
  const scale = thermal.temperatureScale;
  const system = ctx.unitSystem;
  const key = `B_${record.id}`;
  const head = `** ${commentText(record.id)} ${commentText(record.name)} (${bc.kind})`;
  const missingFaces = (): DeckRefusal =>
    refusal('FEA_TARGET_UNRESOLVED', `thermal BC '${record.id}' (${record.name}) has no faces in the mesh`, [record.id]);
  switch (bc.kind) {
    case 'temperature': {
      const nset = nodeSetOf(ctx, key);
      if (nset === null)
        return refusal('FEA_TARGET_UNRESOLVED', `thermal BC '${record.id}' (${record.name}) has no nodes in the mesh`, [record.id]);
      return { lines: [head, keyword('BOUNDARY', record), row(nset, 11, 11, inScale(bc.value, scale))] };
    }
    case 'surface_flux': {
      if (ctx.faces(key).length === 0) return missingFaces();
      return { lines: [head, keyword('DFLUX', record), ...faceLines(ctx, key, 'S', siToSystem('flux', siOf('flux', bc.value), system))] };
    }
    case 'concentrated_flux': {
      const nset = nodeSetOf(ctx, key);
      if (nset === null)
        return refusal('FEA_TARGET_UNRESOLVED', `thermal BC '${record.id}' (${record.name}) has no nodes in the mesh`, [record.id]);
      return { lines: [head, keyword('CFLUX', record), row(nset, 11, siToSystem('power', siOf('power', bc.value), system))] };
    }
    case 'heat_generation': {
      const volumeSi = (volumes.get(bc.entityId) ?? 0) * analysisLengthMetres(system) ** 3;
      if (bc.mode === 'density') {
        const density = siToSystem('generation', siOf('generation', bc.value), system);
        return { lines: [head, keyword('DFLUX', record), row(ctx.elset(bc.entityId), 'BF', density)] };
      }
      if (!(volumeSi > 0))
        return refusal('FEA_PART_INVALID', `part '${bc.entityId}' has no volume in the mesh: total power cannot be spread`, [bc.entityId]);
      const watts = siOf('power', bc.value);
      const density = watts / volumeSi;
      return {
        lines: [
          head,
          `** total ${num(watts)} W over ${num(volumeSi)} m^3 of '${commentText(bc.entityId)}' = ${num(density)} W/m^3`,
          keyword('DFLUX', record),
          row(ctx.elset(bc.entityId), 'BF', siToSystem('generation', density, system)),
        ],
      };
    }
    case 'film': {
      if (!('value' in bc.filmCoefficient))
        return refusal('THM_FILM_INVALID', `thermal BC '${record.id}' has a film table, which is not written`, [record.id]);
      if (ctx.faces(key).length === 0) return missingFaces();
      const h = siToSystem('film', siOf('film', bc.filmCoefficient), system);
      return { lines: [head, keyword('FILM', record), ...faceLines(ctx, key, 'F', inScale(bc.sinkTemperature, scale), h)] };
    }
    case 'radiation': {
      if (ctx.faces(key).length === 0) return missingFaces();
      const emissivity = typeof bc.emissivity === 'number' ? bc.emissivity : Number.NaN;
      return { lines: [head, keyword('RADIATE', record), ...faceLines(ctx, key, 'R', inScale(bc.sinkTemperature, scale), emissivity)] };
    }
  }
}

/** Cavity radiation lines (`*RADIATE, CAVITY=<name>` with `R<f>CR`), faces keyed `V_<cavityId>_<k>`. */
export function cavityLines(ctx: DeckContext, thermal: ThermalSetup, cavity: CavityRadiation): Blocks {
  const scale = thermal.temperatureScale;
  const environment = cavity.environment.kind === 'open' ? inScale(cavity.environment.temperature, scale) : absoluteZeroOf(scale) - 1;
  const lines = [
    `** ${commentText(cavity.id)} ${commentText(cavity.name)} (${cavity.environment.kind} cavity)`,
    `*RADIATE, CAVITY=${safeName(cavity.name).toUpperCase()}`,
  ];
  for (const [k, face] of cavity.faces.entries()) {
    const key = `V_${cavity.id}_${k}`;
    if (ctx.faces(key).length === 0)
      return refusal('FEA_TARGET_UNRESOLVED', `cavity '${cavity.id}' face ${k} has no faces in the mesh`, [cavity.id]);
    const emissivity = typeof face.emissivity === 'number' ? face.emissivity : Number.NaN;
    lines.push(...faceLines(ctx, key, 'R', environment, emissivity).map((line) => line.replace(/, (R\d)/, ', $1CR')));
  }
  return { lines };
}
