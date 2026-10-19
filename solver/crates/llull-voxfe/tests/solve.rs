//! Solver-level checks of llull-voxfe: patch tests (2D / 3D), VC-TOP-04 (solid 30×10 MBB compliance), multigrid vs Jacobi
//! iteration counts on a 3D cantilever, bit-reproducibility across thread counts, and the singular-system failure.

use llull_voxfe::ke::element_matrix;
use llull_voxfe::{solve, Grid, Operator, SolveError, SolverKind};

const TOLERANCE: f64 = 1e-10;

/// MBB half-beam of top88: ux = 0 on the left edge, uy = 0 at the bottom-right node, unit load down at the top-left node.
fn mbb(nx: usize, ny: usize, scale: f64) -> (Operator, Vec<f64>) {
    let grid = Grid::new_2d(nx, ny);
    let mut fixed = vec![false; grid.dofs()];
    for j in 0..=ny {
        fixed[grid.node(0, j, 0) * 2] = true;
    }
    fixed[grid.node(nx, 0, 0) * 2 + 1] = true;
    let mut f = vec![0.0; grid.dofs()];
    f[grid.node(0, ny, 0) * 2 + 1] = -1.0;
    (Operator::new(grid, element_matrix(2, 0.3), vec![scale; grid.elements()], fixed), f)
}

fn compliance(op: &Operator, kind: SolverKind, f: &[f64]) -> (f64, usize) {
    let mut u = vec![0.0; f.len()];
    let stats = solve(op, kind, f, &mut u, TOLERANCE, 20_000).unwrap();
    (f.iter().zip(&u).map(|(a, b)| a * b).sum(), stats.iterations)
}

#[test]
fn vc_top_04_solid_mbb_compliance_and_simp_scaling() {
    for kind in [SolverKind::Jacobi, SolverKind::Multigrid] {
        let (op, f) = mbb(30, 10, 1.0);
        let (c1, _) = compliance(&op, kind, &f);
        assert!((c1 - 123.069351174).abs() / 123.069351174 < 1e-9, "{kind:?}: c(1) = {c1}");
        let (half, f) = mbb(30, 10, 1e-9 + 0.125 * (1.0 - 1e-9));
        let (ch, _) = compliance(&half, kind, &f);
        assert!((ch / c1 - 7.99999994398).abs() / 7.99999994398 < 1e-8, "{kind:?}: ratio {}", ch / c1);
    }
}

fn patch(grid: Grid, kind: SolverKind) {
    let dim = grid.dim;
    let field = |n: usize| -> [f64; 3] {
        let [i, j, k] = grid.node_ijk(n).map(|v| v as f64);
        [1e-3 * i + 2e-3 * j - 1e-3 * k + 0.1, -0.5e-3 * i + 1e-3 * j + 3e-3 * k, 2e-3 * i - 1e-3 * j + 0.5e-3 * k - 0.2]
    };
    let [nnx, nny, nnz] = grid.node_dims();
    let boundary = |n: usize| {
        let [i, j, k] = grid.node_ijk(n);
        i == 0 || j == 0 || i + 1 == nnx || j + 1 == nny || (dim == 3 && (k == 0 || k + 1 == nnz))
    };
    let fixed: Vec<bool> = (0..grid.dofs()).map(|d| boundary(d / dim)).collect();
    let op = Operator::new(grid, element_matrix(dim, 0.3), vec![2.5; grid.elements()], fixed);
    let mut prescribed = vec![0.0; grid.dofs()];
    for (d, value) in prescribed.iter_mut().enumerate() {
        if boundary(d / dim) {
            *value = field(d / dim)[d % dim];
        }
    }
    let mut load = vec![0.0; grid.dofs()];
    op.apply(&prescribed, &mut load);
    let rhs: Vec<f64> = load.iter().map(|v| -v).collect();
    let mut interior = vec![0.0; grid.dofs()];
    solve(&op, kind, &rhs, &mut interior, 1e-14, 10_000).unwrap();
    for d in 0..grid.dofs() {
        let value = prescribed[d] + interior[d];
        let exact = field(d / dim)[d % dim];
        assert!((value - exact).abs() <= 1e-12 * exact.abs().max(1e-3), "{kind:?} dof {d}: {value} vs {exact}");
    }
}

#[test]
fn patch_tests_reproduce_a_linear_field_exactly() {
    for kind in [SolverKind::Jacobi, SolverKind::Multigrid] {
        patch(Grid::new_2d(5, 4), kind);
        patch(Grid::new_3d(4, 3, 3), kind);
    }
}

/// 3D cantilever: x = 0 face clamped, unit downward load spread over the nodes of the bottom edge of the x = nx face.
fn cantilever(nx: usize, ny: usize, nz: usize) -> (Operator, Vec<f64>) {
    let grid = Grid::new_3d(nx, ny, nz);
    let mut fixed = vec![false; grid.dofs()];
    let mut f = vec![0.0; grid.dofs()];
    for k in 0..=nz {
        for j in 0..=ny {
            for c in 0..3 {
                fixed[grid.node(0, j, k) * 3 + c] = true;
            }
        }
        f[grid.node(nx, 0, k) * 3 + 1] = -1.0 / (nz + 1) as f64;
    }
    let scale: Vec<f64> = (0..grid.elements()).map(|e| if grid.element_ijk(e)[1] == ny / 2 { 1e-3 } else { 1.0 }).collect();
    (Operator::new(grid, element_matrix(3, 0.3), scale, fixed), f)
}

#[test]
fn multigrid_needs_fewer_iterations_than_jacobi_on_a_3d_cantilever() {
    let (op, f) = cantilever(24, 12, 12);
    let (cj, jacobi) = compliance(&op, SolverKind::Jacobi, &f);
    let (cm, multigrid) = compliance(&op, SolverKind::Multigrid, &f);
    eprintln!("3D cantilever 24x12x12 ({} DOF): Jacobi PCG {jacobi} iterations, multigrid PCG {multigrid}", op.grid().dofs());
    assert!((cj - cm).abs() / cj < 1e-8, "{cj} vs {cm}");
    assert!(multigrid * 3 < jacobi, "multigrid {multigrid} vs Jacobi {jacobi} iterations");
}

#[test]
fn solves_are_bit_identical_for_any_thread_count() {
    let (op, f) = cantilever(8, 4, 4);
    let run = |threads: usize, kind: SolverKind| {
        rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap().install(|| {
            let mut u = vec![0.0; f.len()];
            solve(&op, kind, &f, &mut u, TOLERANCE, 10_000).unwrap();
            u.iter().map(|v| v.to_bits()).collect::<Vec<u64>>()
        })
    };
    for kind in [SolverKind::Jacobi, SolverKind::Multigrid] {
        let one = run(1, kind);
        assert_eq!(one, run(3, kind), "{kind:?}");
        assert_eq!(one, run(4, kind), "{kind:?}");
    }
}

#[test]
#[ignore = "measurement: cargo test --release -p llull-voxfe --test solve -- --ignored --nocapture"]
fn matvec_and_solve_throughput() {
    for n in [20usize, 40, 60] {
        let (op, f) = cantilever(2 * n, n, n);
        let u: Vec<f64> = (0..f.len()).map(|d| (d % 13) as f64).collect();
        let mut y = vec![0.0; f.len()];
        let started = std::time::Instant::now();
        for _ in 0..20 {
            op.apply(&u, &mut y);
        }
        let matvec = started.elapsed().as_secs_f64() / 20.0;
        let started = std::time::Instant::now();
        let mg = llull_voxfe::multigrid::Multigrid::new(&op, Default::default());
        let build = started.elapsed().as_secs_f64();
        let started = std::time::Instant::now();
        let mut x = vec![0.0; f.len()];
        let stats = llull_voxfe::pcg::pcg(&op, &mg, &f, &mut x, TOLERANCE, 10_000).unwrap();
        let solve = started.elapsed().as_secs_f64();
        eprintln!(
            "{} DOF: mat-vec {:.2} ms, MG build {:.3} s ({} levels), MG-PCG {} iterations in {:.3} s",
            f.len(),
            matvec * 1e3,
            build,
            mg.levels(),
            stats.iterations,
            solve
        );
    }
}

#[test]
fn an_unsupported_body_fails_instead_of_returning_garbage() {
    let grid = Grid::new_2d(4, 2);
    let op = Operator::new(grid, element_matrix(2, 0.3), vec![1.0; grid.elements()], vec![false; grid.dofs()]);
    let mut f = vec![0.0; grid.dofs()];
    f[1] = -1.0;
    let mut u = vec![0.0; f.len()];
    let error = solve(&op, SolverKind::Jacobi, &f, &mut u, TOLERANCE, 500).unwrap_err();
    assert!(matches!(error, SolveError::Breakdown { .. } | SolveError::NotConverged { .. } | SolveError::NonFinite { .. }), "{error}");
}
