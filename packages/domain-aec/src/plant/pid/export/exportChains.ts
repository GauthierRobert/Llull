/**
 * Folds llull's segments back into DEXPI segments (plant 04 PID §6.3): the pieces of one drawn segment (shared `dexpi:segment`) become one chain
 * source -> components -> target; every inline item, off-page connector and flow arrow gets exactly one segment to sit in.
 */

import type { Vec2 } from '@core/model/vectors';
import type { PidEndpoint, PidItem, PidModel, PidSegment } from '../model';

export interface OrientedPiece {
  readonly from: PidEndpoint;
  readonly to: PidEndpoint;
  readonly route: readonly Vec2[];
}

export interface Chain {
  readonly lineId: string;
  readonly sheetId: string;
  /** The first stored piece (its source id and attributes name the DEXPI segment). */
  readonly head: PidSegment;
  /** Pieces in flow order (a reverse-flow chain is written from its far end). */
  readonly pieces: readonly OrientedPiece[];
  /** Components between consecutive pieces. */
  readonly inner: readonly string[];
  leading?: string;
  trailing?: string;
  /** Off-page connectors and flow arrows written inside this segment. */
  readonly extras: string[];
}

const keyOf = (segment: PidSegment): string => segment.passthrough?.['dexpi:segment'] ?? segment.id;

const reversePiece = (piece: OrientedPiece): OrientedPiece => ({ from: piece.to, to: piece.from, route: [...piece.route].reverse() });

/** Splits a run of pieces where consecutive ones do not meet at the same inline item. */
function runsOf(pieces: readonly PidSegment[]): PidSegment[][] {
  const runs: PidSegment[][] = [];
  for (const piece of pieces) {
    const run = runs[runs.length - 1];
    const before = run?.[run.length - 1];
    if (run !== undefined && before?.to.type === 'inline' && piece.from.type === 'inline' && before.to.itemId === piece.from.itemId)
      run.push(piece);
    else runs.push([piece]);
  }
  return runs;
}

function chainOf(run: readonly PidSegment[]): Chain {
  const head = run[0] as PidSegment;
  const forward = run.map((piece): OrientedPiece => ({ from: piece.from, to: piece.to, route: piece.route }));
  const inner = run.slice(1).map((piece) => (piece.from.type === 'inline' ? piece.from.itemId : ''));
  const reversed = head.flow === 'reverse';
  return {
    lineId: head.lineId,
    sheetId: head.sheetId,
    head,
    pieces: reversed ? forward.map(reversePiece).reverse() : forward,
    inner: reversed ? [...inner].reverse() : inner,
    extras: [],
  };
}

const nearestChain = (chains: readonly Chain[], point: Vec2): Chain | undefined => {
  let best: Chain | undefined;
  let bestDistance = Infinity;
  for (const chain of chains)
    for (const piece of chain.pieces)
      for (const p of piece.route) {
        const distance = (p[0] - point[0]) ** 2 + (p[1] - point[1]) ** 2;
        if (distance < bestDistance) {
          best = chain;
          bestDistance = distance;
        }
      }
  return best;
};

export interface Chains {
  readonly chains: readonly Chain[];
  /** Chains of each line, in line order. */
  readonly byLine: ReadonlyMap<string, Chain[]>;
  /** Segment item id -> the chain holding it. */
  readonly chainOfSegment: ReadonlyMap<string, Chain>;
  /** Items that found no segment to sit in. */
  readonly unplaced: string[];
}

/** Largest (arrows x route points) product searched for the nearest segment; above it the first segment of the sheet is taken. */
const NEAREST_BUDGET = 4_000_000;

export function buildChains(pid: PidModel, sheets: ReadonlySet<string>, items: readonly PidItem[]): Chains {
  const chains: Chain[] = [];
  const byLine = new Map<string, Chain[]>();
  const chainOfSegment = new Map<string, Chain>();
  for (const item of items) {
    if (item.kind !== 'line') continue;
    const groups = new Map<string, PidSegment[]>();
    for (const id of item.segmentIds) {
      const segment = pid.items[id];
      if (segment?.kind === 'segment' && sheets.has(segment.sheetId))
        groups.set(keyOf(segment), [...(groups.get(keyOf(segment)) ?? []), segment]);
    }
    const own: Chain[] = [];
    for (const group of groups.values())
      for (const run of runsOf(group)) {
        const chain = chainOf(run);
        own.push(chain);
        for (const piece of run) chainOfSegment.set(piece.id, chain);
      }
    byLine.set(item.id, own);
    chains.push(...own);
  }

  const homed = new Set<string>();
  for (const chain of chains) for (const id of chain.inner) homed.add(id);
  const place = (chain: Chain, end: PidEndpoint, side: 'leading' | 'trailing'): void => {
    if (end.type !== 'inline' || homed.has(end.itemId) || chain[side] !== undefined) return;
    homed.add(end.itemId);
    chain[side] = end.itemId;
  };
  for (const chain of chains) {
    place(chain, (chain.pieces[0] as OrientedPiece).from, 'leading');
    place(chain, (chain.pieces[chain.pieces.length - 1] as OrientedPiece).to, 'trailing');
  }

  const unplaced: string[] = [];
  const connectors = new Map<string, Chain>();
  for (const chain of chains)
    for (const piece of chain.pieces)
      for (const end of [piece.from, piece.to]) if (end.type === 'opc' && !connectors.has(end.itemId)) connectors.set(end.itemId, chain);
  const vertices = chains.reduce((sum, chain) => sum + chain.pieces.reduce((s, piece) => s + piece.route.length, 0), 0);
  const searched = new Map<string, Chain[]>();
  const onSheet = (sheetId: string): Chain[] => {
    const known = searched.get(sheetId) ?? chains.filter((chain) => chain.sheetId === sheetId);
    searched.set(sheetId, known);
    return known;
  };
  for (const item of items) {
    if (item.kind === 'inline') {
      if (!homed.has(item.id)) unplaced.push(item.id);
    } else if (item.kind === 'opc' || (item.kind === 'annotation' && item.dexpiClass === 'PipeFlowArrow')) {
      const candidates = onSheet(item.sheetId);
      const near = candidates.length * vertices <= NEAREST_BUDGET ? nearestChain(candidates, item.at) : candidates[0];
      const home = connectors.get(item.id) ?? near;
      if (home === undefined) unplaced.push(item.id);
      else home.extras.push(item.id);
    }
  }
  return { chains, byLine, chainOfSegment, unplaced };
}
