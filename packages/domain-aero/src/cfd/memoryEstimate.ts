/**
 * Cell count, device memory and run-time estimate of a case before any solve (TECHNICAL_SPEC §5.1 step 11, §8, FR-CFD-05). Bytes per cell
 * come from the §8 table; the grid layouts (nested refinement boxes for LBM, octree band for Euler) and the throughputs are named llull
 * defaults, reported as such, to be confirmed by VC-CFD-50 (allocation) and VC-CFD-54 (throughput).
 */

import type { CfdQuality, CfdSolver } from '@aero/cfd/types';
import type { Vec3 } from '@core/model/types';
import type { Box } from './domainSizing';

export const CELLS_PER_REFERENCE_LENGTH: Readonly<Record<CfdQuality, number>> = { draft: 64, standard: 128, fine: 256 };
/** Stored bytes per cell (float32): LBM D3Q19 with the in-place AA scheme, Euler SSP-RK3 with local time stepping. */
export const BYTES_PER_CELL: Readonly<Record<CfdSolver, number>> = { lbm: 96, euler: 144 };
/** Share of the device memory a case may use (20 % reserve for the OS and the renderer). */
export const MEMORY_BUDGET_FRACTION = 0.8;

const LBM_LEVELS = 4;
const LBM_BOX_MARGIN_LENGTHS = 0.25;
const LBM_LATTICE_SPEED = 0.1 / Math.sqrt(3);
const LBM_FLOW_THROUGHS = 3;
const LBM_MCUPS = 1000;
const EULER_ITERATIONS = 3000;
const EULER_MCUPS = 100;
const EULER_SURFACE_BAND = 8;

export interface EstimateInput {
  readonly solver: CfdSolver;
  readonly cellsPerReferenceLength: number;
  readonly referenceLengthM: number;
  readonly domain: Box;
  readonly body: Box;
  /** Surface area of the part of the body inside the domain (half when symmetric), m². */
  readonly surfaceAreaM2: number;
  readonly deviceMemoryBytes?: number | undefined;
}

export interface Estimate {
  readonly solver: CfdSolver;
  readonly cellsPerReferenceLength: number;
  readonly targetCellM: number;
  readonly cells: number;
  readonly levels: number;
  readonly bytesPerCell: number;
  readonly bytes: number;
  readonly deviceMemoryBytes: number | null;
  /** Null without a device memory figure. */
  readonly fitsDevice: boolean | null;
  /** Largest cellsPerReferenceLength that fits the budget (only when it does not fit now). */
  readonly largestFittingCellsPerReferenceLength: number | null;
  readonly timeEstimateS: number;
  readonly basis: string[];
}

const volume = (box: Box): number => [0, 1, 2].reduce((v, axis) => v * Math.max(0, (box.max[axis] ?? 0) - (box.min[axis] ?? 0)), 1);

function clampTo(box: Box, within: Box): Box {
  const pick = (i: number, f: (a: number, b: number) => number, from: Vec3, to: Vec3): number => f(from[i] ?? 0, to[i] ?? 0);
  return {
    min: [0, 1, 2].map((i) => pick(i, Math.max, box.min, within.min)) as unknown as Vec3,
    max: [0, 1, 2].map((i) => pick(i, Math.min, box.max, within.max)) as unknown as Vec3,
  };
}

/** Cells and cell updates per step-unit of the nested-box LBM grid: level k has cells of size h·2^k, boxes grow around the body. */
function lbmCells(input: EstimateInput, n: number): { cells: number; updates: number } {
  const h = input.referenceLengthM / n;
  const length = Math.max(...[0, 1, 2].map((a) => (input.body.max[a] ?? 0) - (input.body.min[a] ?? 0)));
  let previous = 0;
  let cells = 0;
  let updates = 0;
  for (let level = 0; level < LBM_LEVELS; level++) {
    const total =
      level === LBM_LEVELS - 1
        ? volume(input.domain)
        : volume(
            clampTo(
              {
                min: input.body.min.map((v) => v - (level + 1) * LBM_BOX_MARGIN_LENGTHS * length) as unknown as Vec3,
                max: input.body.max.map((v) => v + (level + 1) * LBM_BOX_MARGIN_LENGTHS * length) as unknown as Vec3,
              },
              input.domain,
            ),
          );
    const levelCells = Math.max(0, total - previous) / (h * 2 ** level) ** 3;
    cells += levelCells;
    updates += levelCells / 2 ** level;
    previous = total;
  }
  return { cells, updates };
}

/** Coarsening levels above the finest cell until the cell is an eighth of the body length (never negative). */
const octreeLevels = (input: EstimateInput, h: number): number => {
  const length = Math.max(...[0, 1, 2].map((a) => (input.body.max[a] ?? 0) - (input.body.min[a] ?? 0)));
  return Math.max(0, Math.ceil(Math.log2(length / (8 * h))));
};

/** Octree: a band of 8 cell layers (geometric over coarser levels) on the surface, plus the bulk at the coarsest level. */
function eulerCells(input: EstimateInput, n: number): number {
  const h = input.referenceLengthM / n;
  return (EULER_SURFACE_BAND * input.surfaceAreaM2 * (4 / 3)) / h ** 2 + volume(input.domain) / (h * 2 ** octreeLevels(input, h)) ** 3;
}

const cellCount = (input: EstimateInput, n: number): number => (input.solver === 'lbm' ? lbmCells(input, n).cells : eulerCells(input, n));

/** Largest integer N <= `from` whose estimate stays within `budgetBytes` (0 when even N = 1 does not). */
function largestFitting(input: EstimateInput, from: number, budgetBytes: number): number {
  let low = 0;
  let high = from;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (cellCount(input, mid) * BYTES_PER_CELL[input.solver] <= budgetBytes) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * @invariant bytes = cells × bytes per cell; the time is an order of magnitude from a target throughput that is not measured yet
 */
export function estimateCase(input: EstimateInput): Estimate {
  const n = input.cellsPerReferenceLength;
  const cells = Math.round(cellCount(input, n));
  const bytes = cells * BYTES_PER_CELL[input.solver];
  const h = input.referenceLengthM / n;
  const budget = input.deviceMemoryBytes === undefined ? null : input.deviceMemoryBytes * MEMORY_BUDGET_FRACTION;
  const fits = budget === null ? null : bytes <= budget;
  const stepsLbm = (LBM_FLOW_THROUGHS * (input.domain.max[0] - input.domain.min[0])) / h / LBM_LATTICE_SPEED;
  const timeEstimateS =
    input.solver === 'lbm' ? (lbmCells(input, n).updates * stepsLbm) / (LBM_MCUPS * 1e6) : (cells * EULER_ITERATIONS) / (EULER_MCUPS * 1e6);
  return {
    solver: input.solver,
    cellsPerReferenceLength: n,
    targetCellM: h,
    cells,
    levels: input.solver === 'lbm' ? LBM_LEVELS : octreeLevels(input, h) + 1,
    bytesPerCell: BYTES_PER_CELL[input.solver],
    bytes,
    deviceMemoryBytes: input.deviceMemoryBytes ?? null,
    fitsDevice: fits,
    largestFittingCellsPerReferenceLength: budget !== null && fits === false ? largestFitting(input, n, budget) : null,
    timeEstimateS,
    basis: [
      `bytes per cell ${BYTES_PER_CELL[input.solver]} (TECHNICAL_SPEC §8), ${MEMORY_BUDGET_FRACTION * 100} % of the device memory usable`,
      input.solver === 'lbm'
        ? `grid: ${LBM_LEVELS} levels of nested boxes (factor 2), boxes ${LBM_BOX_MARGIN_LENGTHS} body lengths apart (named defaults); ${LBM_FLOW_THROUGHS} flow-throughs at lattice Mach 0.1, target ${LBM_MCUPS} Mcell-updates/s (not measured: VC-CFD-54)`
        : `grid: octree with a ${EULER_SURFACE_BAND}-layer band on the surface (named default); ${EULER_ITERATIONS} iterations at ${EULER_MCUPS} Mcell-updates/s (assumed, not measured: VC-CFD-54)`,
    ],
  };
}
