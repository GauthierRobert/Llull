/**
 * Hydraulic grade line (metres) from the outfall(s) upstream. Per pipe: friction slope
 * Sf = (Q n / (A R^(2/3)))^2 (full bore), water level = max(normal-depth level, downstream HGL +
 * Sf L); a manhole loss K v^2 / 2g is added where the pipe runs under pressure at its upstream end.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import type { CivilModel, PipeObject } from '@core/model/civil';
import { toMetres } from '../model';
import { civilObjectsOf } from './model';
import { fullArea, solvePartialFlow } from './hydraulics';
import type { DrainageCriteria } from './drainageCriteria';
import type { FlowResult } from './drainageFlow';
import { manholesUpstreamFirst, pipePlanLength, pipeSlope } from './drainageTopology';

const GRAVITY = 9.80665;
const LEVEL_TOLERANCE_M = 1e-6;

export interface PipeHgl {
  readonly hglUpM: number;
  readonly hglDownM: number;
  readonly frictionSlope: number;
  /** HGL above the obvert at either end. */
  readonly surcharged: boolean;
  /** HGL above rim minus freeboard at either end manhole. */
  readonly flooding: boolean;
}

export interface ManholeHgl {
  readonly hglM: number;
  readonly flooding: boolean;
}

export interface HglResult {
  readonly pipes: ReadonlyMap<string, PipeHgl>;
  readonly manholes: ReadonlyMap<string, ManholeHgl>;
}

interface PipeState {
  readonly diameterM: number;
  readonly normalDepthM: number;
  readonly invertUpM: number;
  readonly invertDownM: number;
  readonly frictionSlope: number;
  readonly lengthM: number;
  readonly velocityFull: number;
}

function pipeState(
  doc: CadDocument,
  civil: CivilModel,
  pipe: PipeObject,
  designLps: number,
): PipeState {
  const diameterM = toMetres(doc, pipe.diameter);
  const flowM3s = designLps / 1000;
  const slope = pipeSlope(civil, pipe);
  const partial = solvePartialFlow(diameterM, slope, pipe.manningN, flowM3s);
  const area = fullArea(diameterM);
  const conveyance = area * (diameterM / 4) ** (2 / 3);
  return {
    diameterM,
    normalDepthM: partial.depthRatio * diameterM,
    invertUpM: toMetres(doc, pipe.invertFrom),
    invertDownM: toMetres(doc, pipe.invertTo),
    frictionSlope: flowM3s > 0 ? ((flowM3s * pipe.manningN) / conveyance) ** 2 : 0,
    lengthM: toMetres(doc, pipePlanLength(civil, pipe) ?? 0),
    velocityFull: flowM3s / area,
  };
}

export function computeHgl(
  doc: CadDocument,
  civil: CivilModel,
  criteria: DrainageCriteria,
  flows: FlowResult,
): HglResult {
  const pipes = civilObjectsOf(civil, 'pipe').filter(
    (pipe) => pipePlanLength(civil, pipe) !== null,
  );
  const states = new Map(
    pipes.map((pipe) => [
      pipe.id,
      pipeState(doc, civil, pipe, flows.pipes.get(pipe.id)?.designLps ?? 0),
    ]),
  );
  const nodeLevel = new Map<string, number>();
  const pipeResults = new Map<string, Omit<PipeHgl, 'flooding'>>();
  for (const manhole of [...manholesUpstreamFirst(civil)].reverse()) {
    const outgoing = pipes.filter((pipe) => pipe.fromId === manhole.id);
    if (outgoing.length === 0) {
      const incoming = pipes.filter((pipe) => pipe.toId === manhole.id);
      const normal = incoming.map((pipe) => {
        const state = states.get(pipe.id);
        return state ? state.invertDownM + state.normalDepthM : -Infinity;
      });
      nodeLevel.set(
        manhole.id,
        criteria.outfallLevel !== null
          ? toMetres(doc, criteria.outfallLevel)
          : Math.max(toMetres(doc, manhole.invertElevation), ...normal),
      );
      continue;
    }
    const levels = outgoing.map((pipe) => {
      const state = states.get(pipe.id);
      if (!state) return -Infinity;
      const downstream = nodeLevel.get(pipe.toId) ?? state.invertDownM;
      const hglDownM = Math.max(downstream, state.invertDownM + state.normalDepthM);
      const pipeUp = Math.max(
        state.invertUpM + state.normalDepthM,
        hglDownM + state.frictionSlope * state.lengthM,
      );
      const pressurised = pipeUp > state.invertUpM + state.diameterM + LEVEL_TOLERANCE_M;
      const loss = pressurised
        ? (criteria.manholeLossK * state.velocityFull ** 2) / (2 * GRAVITY)
        : 0;
      const hglUpM = pipeUp + loss;
      pipeResults.set(pipe.id, {
        hglUpM,
        hglDownM,
        frictionSlope: state.frictionSlope,
        surcharged:
          pressurised || hglDownM > state.invertDownM + state.diameterM + LEVEL_TOLERANCE_M,
      });
      return hglUpM;
    });
    nodeLevel.set(manhole.id, Math.max(...levels));
  }
  const manholes = new Map<string, ManholeHgl>();
  for (const manhole of civilObjectsOf(civil, 'manhole')) {
    const hglM = nodeLevel.get(manhole.id) ?? toMetres(doc, manhole.invertElevation);
    manholes.set(manhole.id, {
      hglM,
      flooding: hglM > toMetres(doc, manhole.rimElevation) - criteria.freeboardM,
    });
  }
  const floods = (id: string): boolean => manholes.get(id)?.flooding ?? false;
  const pipeHgl = new Map<string, PipeHgl>();
  for (const pipe of pipes) {
    const result = pipeResults.get(pipe.id);
    if (!result) continue;
    pipeHgl.set(pipe.id, { ...result, flooding: floods(pipe.fromId) || floods(pipe.toId) });
  }
  return { pipes: pipeHgl, manholes };
}
