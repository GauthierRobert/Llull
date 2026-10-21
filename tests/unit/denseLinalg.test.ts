import { describe, expect, it } from 'vitest';
import { solveLinear, invertMatrix } from '@core/model/materialLaws/linalg';
import { solveLinear as solveParametric } from '@core/commands/parametric/solver/linalg';
import { solveFrame } from '@lib/frame2d';
import { fitPlane } from '@cae/thermomech/plane';
import { momentForces } from '@cae/decks/loadDistribution';
import { cholesky, invertDense, luFactor, luSolve, solveDense } from '@lib/denseLinalg';
import type { FeMeshArtifact } from '@core/model/analysis';

const n = 6;
const rows = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Math.sin(i * 7 + j * 3 + 1) + (i === j ? 0.4 : 0)));
const rhs = Array.from({ length: n }, (_, i) => Math.cos(i + 0.5));
const singular = rows.map((row, i) => (i === 3 ? (rows[1] as number[]) : row));
const flat = Float64Array.from(rows.flat());
const spd = [
  [4, 1.2, 0.3],
  [1.2, 3, 0.7],
  [0.3, 0.7, 2],
];
const points: [number, number, number][] = [
  [0, 0, 0.01],
  [1, 0.1, 0],
  [0.2, 1.3, -0.02],
  [1.1, 1.2, 0.03],
  [0.5, 0.6, 0.0],
];
const mesh = { nodes: points.map((p, i) => [i + 1, p[0], p[1], p[2]]) } as unknown as FeMeshArtifact;

function capture(): unknown {
  const factors = luFactor(flat, n);
  return {
    solve: solveLinear(rows, rhs),
    solveSingular: solveLinear(singular, rhs),
    invert: invertMatrix(rows),
    parametric: solveParametric(flat, Float64Array.from(rhs), n),
    parametricSingular: solveParametric(Float64Array.from(singular.flat()), Float64Array.from(rhs), n),
    lu: factors === null ? null : Array.from(luSolve(factors, rhs)),
    luSingular: luFactor(Float64Array.from(singular.flat()), n),
    frame: solveFrame(
      [
        { x: 0, y: 0, restraint: [true, true, true] },
        { x: 0, y: 3000, restraint: [false, false, false], load: { fx: 5000, fy: -2000, mz: 0 } },
        { x: 4000, y: 3000, restraint: [false, false, false] },
        { x: 4000, y: 0, restraint: [true, true, false] },
      ],
      [
        { a: 0, b: 1, E: 210000, A: 5000, I: 8e7 },
        { a: 1, b: 2, E: 210000, A: 5000, I: 8e7, load: { qx: 0, qy: -10 }, releaseB: true },
        { a: 2, b: 3, E: 210000, A: 5000, I: 8e7 },
      ],
    ),
    frameSingular: solveFrame(
      [
        { x: 0, y: 0, restraint: [false, false, false] },
        { x: 1000, y: 0, restraint: [false, false, false] },
      ],
      [{ a: 0, b: 1, E: 1, A: 1, I: 1 }],
    ),
    cholesky: cholesky(spd),
    choleskyNotPd: cholesky([
      [1, 2],
      [2, 1],
    ]),
    plane: fitPlane(points),
    moment: momentForces(mesh, [1, 2, 3, 4, 5], [1.5, -2, 0.7]),
  };
}

const replacer = (_: string, v: unknown): unknown => (v instanceof Map ? { map: [...v] } : v instanceof Float64Array ? Array.from(v) : v);

/** Outputs recorded from the pre-consolidation solver copies (materialLaws, parametric, denseLu, frame2d, reliability, Jacobi copies). */
const RECORDED =
  '{"solve":[1.2928293844584426,0.6653291754797883,-0.36519036706676733,-0.3603436824618164,0.8219980387467936,1.8248858909017607],"solveSingular":null,"invert":[[0.20290495433573114,2.1073666162503737,-1.8754592296840134,1.6060145138840733,-1.3044254066692766,0.9767282160710635],[-1.7001354304505445,4.446235555104996,-2.1533817618913544,2.3174280180723756,-2.435090936715236,2.5040154937032897],[-0.2663768217469113,0.8271761287031247,1.1285805001807157,1.8882139003221285,-2.367215686771855,2.7988376351558837],[1.2984912576109435,-0.6990156587684919,0.08554925676310367,3.029629414198056,-1.1342075488330337,1.7160845116665169],[2.2242477944628365,-1.8811550906367953,1.5004110548814795,-1.089636281661251,3.157052430855018,-0.21131767117785025],[2.0552395953163676,-2.1373984684324348,2.176777296670422,-2.1725879125154024,2.1249141665197264,0.46528975096636555]],"parametric":[1.2928293844584426,0.6653291754797883,-0.36519036706676733,-0.3603436824618164,0.8219980387467936,1.8248858909017607],"parametricSingular":null,"lu":[1.2928293844584426,0.6653291754797883,-0.36519036706676733,-0.3603436824618164,0.8219980387467936,1.8248858909017607],"luSingular":null,"frame":{"displacements":[[0,0,0],[2.9342887869543297,-0.06353905581283059,-0.0015097639532076473],[2.9342887869543297,-0.05646094418716941,-0.0009780962623181099],[0,0,-0.0009780962623181099]],"members":[{"axial":[-22238.669534490706,-22238.669534490706],"shear":[5000.000000000011,5000.000000000011],"moment":[-15954678.13796284,-954678.1379628107],"maxMoment":15954678.13796284,"maxAxial":22238.669534490706,"maxDisplacement":{"x":2.9342887869543297,"y":0.06353905581283059}},{"axial":[0,0],"shear":[20238.669534490702,-19761.330465509298],"moment":[-954678.1379628107,0],"maxMoment":19522660.93101859,"maxAxial":0,"maxDisplacement":{"x":2.9342887869543297,"y":1.9873009044863406}},{"axial":[-19761.330465509294,-19761.330465509294],"shear":[0,0],"moment":[1.862645149230957e-9,-3.725290298461914e-9],"maxMoment":1.862645149230957e-9,"maxAxial":19761.330465509294,"maxDisplacement":{"x":2.9342887869543297,"y":0.05646094418716941}}]},"frameSingular":null,"cholesky":[[2,0,0],[0.6,1.624807680927192,0],[0.15,0.3754290474869648,1.355194831123197]],"choleskyNotPd":null,"plane":{"centroid":[0.5599999999999999,0.64,0.003999999999999999],"normal":[-0.0200276932729188,0.004524047768302876,0.9997891900265556],"flatness":0.03296735891863795},"moment":{"forces":{"map":[[1,[0.18121292939566044,-0.17366538283028005,-1.6111007583015644]],[2,[0.1709048749907681,0.1358950939273965,0.45369856878596393]],[3,[-0.15148381442716327,-0.08994717826006089,-0.20129018574422597]],[4,[-0.22065257464596005,0.14270866353962136,1.5090591817934809]],[5,[0.02001858468669479,-0.014991196376676803,-0.15036680653365342]]]}}}';

describe('consolidated dense linalg reproduces the previous solvers bit for bit', () => {
  it('matches the recorded outputs', () => {
    expect(JSON.stringify(capture(), replacer)).toBe(RECORDED);
  });
});

describe('denseLinalg', () => {
  it('solves with a row exchange when the leading entry is zero', () => {
    expect(
      solveDense(
        [
          [0, 2],
          [1, 1],
        ],
        [4, 3],
      ),
    ).toEqual([1, 2]);
  });

  it('factors once and solves several right-hand sides', () => {
    const factors = luFactor(Float64Array.of(2, 0, 0, 4), 2);
    expect(factors).not.toBeNull();
    if (factors === null) return;
    expect(Array.from(luSolve(factors, [2, 4]))).toEqual([1, 1]);
    expect(Array.from(luSolve(factors, [4, 8]))).toEqual([2, 2]);
  });

  it('reports a singular matrix as null and honours the pivot tolerance', () => {
    expect(
      solveDense(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toBeNull();
    expect(
      invertDense([
        [1, 2],
        [2, 4],
      ]),
    ).toBeNull();
    expect(
      solveDense(
        [
          [1e-8, 0],
          [0, 1],
        ],
        [1, 1],
      ),
    ).toEqual([1e8, 1]);
    expect(
      solveDense(
        [
          [1e-8, 0],
          [0, 1],
        ],
        [1, 1],
        1e-6,
      ),
    ).toBeNull();
    expect(luFactor(Float64Array.of(Number.NaN), 1)).toBeNull();
  });

  it('inverts a matrix', () => {
    expect(
      invertDense([
        [2, 0],
        [0, 4],
      ]),
    ).toEqual([
      [0.5, 0],
      [0, 0.25],
    ]);
  });

  it('factorises a positive definite matrix and refuses an indefinite one', () => {
    expect(
      cholesky([
        [4, 2],
        [2, 5],
      ]),
    ).toEqual([
      [2, 0],
      [1, 2],
    ]);
    expect(
      cholesky([
        [1, 2],
        [2, 1],
      ]),
    ).toBeNull();
    expect(cholesky([[0.5]], 1)).toBeNull();
  });
});
