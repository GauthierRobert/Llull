//! QuadriFlow on closed meshes (07 MSH M6): quad count against the target, valence, closedness, orientation, determinism, and a failure
//! that must come back as an error instead of ending the process.

use llull_quadflow::{quad_remesh, quad_remesh_with_stages, QuadMesh, QuadParams};
use std::collections::HashMap;

const RADIUS: f64 = 10.0;

fn icosphere(level: u32) -> (Vec<f64>, Vec<u32>) {
    let phi = (1.0 + 5f64.sqrt()) / 2.0;
    let mut points: Vec<[f64; 3]> = vec![
        [-1.0, phi, 0.0],
        [1.0, phi, 0.0],
        [-1.0, -phi, 0.0],
        [1.0, -phi, 0.0],
        [0.0, -1.0, phi],
        [0.0, 1.0, phi],
        [0.0, -1.0, -phi],
        [0.0, 1.0, -phi],
        [phi, 0.0, -1.0],
        [phi, 0.0, 1.0],
        [-phi, 0.0, -1.0],
        [-phi, 0.0, 1.0],
    ];
    #[rustfmt::skip]
    let mut faces: Vec<[u32; 3]> = vec![
        [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    for _ in 0..level {
        let mut midpoints: HashMap<(u32, u32), u32> = HashMap::new();
        let mut next = Vec::new();
        for face in &faces {
            let mut mid = [0u32; 3];
            for k in 0..3 {
                let (a, b) = (face[k], face[(k + 1) % 3]);
                mid[k] = *midpoints.entry((a.min(b), a.max(b))).or_insert_with(|| {
                    let (p, q) = (points[a as usize], points[b as usize]);
                    points.push([(p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0, (p[2] + q[2]) / 2.0]);
                    (points.len() - 1) as u32
                });
            }
            next.extend([[face[0], mid[0], mid[2]], [face[1], mid[1], mid[0]], [face[2], mid[2], mid[1]], [mid[0], mid[1], mid[2]]]);
        }
        faces = next;
    }
    let positions = points
        .iter()
        .flat_map(|p| {
            let length = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
            [p[0] / length * RADIUS, p[1] / length * RADIUS, p[2] / length * RADIUS]
        })
        .collect();
    (positions, faces.into_iter().flatten().collect())
}

/// A 10 x 10 x 10 box, each face an `n` x `n` grid of quads split into two triangles; `outward` false winds the faces of one axis inwards.
fn box_mesh(n: i64, outward: bool) -> (Vec<f64>, Vec<u32>) {
    let mut ids: HashMap<(i64, i64, i64), u32> = HashMap::new();
    let mut points: Vec<f64> = Vec::new();
    let mut triangles: Vec<u32> = Vec::new();
    for axis in 0..3 {
        for side in [0, n] {
            for a in 0..n {
                for b in 0..n {
                    let corner = |da: i64, db: i64| -> (i64, i64, i64) {
                        let (u, v) = (a + da, b + db);
                        match axis {
                            0 => (side, u, v),
                            1 => (v, side, u),
                            _ => (u, v, side),
                        }
                    };
                    let quad: Vec<u32> = [(0, 0), (1, 0), (1, 1), (0, 1)]
                        .iter()
                        .map(|&(da, db)| {
                            let c = corner(da, db);
                            *ids.entry(c).or_insert_with(|| {
                                let scale = 10.0 / n as f64;
                                points.extend([c.0 as f64 * scale, c.1 as f64 * scale, c.2 as f64 * scale]);
                                (points.len() / 3 - 1) as u32
                            })
                        })
                        .collect();
                    let at = |i: u32| [points[3 * i as usize] - 5.0, points[3 * i as usize + 1] - 5.0, points[3 * i as usize + 2] - 5.0];
                    let (p0, p1, p3) = (at(quad[0]), at(quad[1]), at(quad[3]));
                    let (u, v) = ([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]]);
                    let normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
                    let facing_out = normal[0] * p0[0] + normal[1] * p0[1] + normal[2] * p0[2] > 0.0;
                    let flip = facing_out == (!outward && axis == 1);
                    let q = if flip { [quad[0], quad[3], quad[2], quad[1]] } else { [quad[0], quad[1], quad[2], quad[3]] };
                    triangles.extend([q[0], q[1], q[2], q[0], q[2], q[3]]);
                }
            }
        }
    }
    (points, triangles)
}

fn params(target_faces: i32) -> QuadParams {
    QuadParams { target_faces, preserve_sharp: false, sharp_cos: 0.5, adaptive: false, preserve_boundary: false }
}

struct Measured {
    quads: usize,
    open_edges: usize,
    non_manifold_edges: usize,
    inconsistent_edges: usize,
    volume: f64,
    valence: HashMap<u32, usize>,
}

fn measure(mesh: &QuadMesh) -> Measured {
    let mut valence_of = vec![0u32; mesh.positions.len() / 3];
    let mut undirected: HashMap<(u32, u32), u32> = HashMap::new();
    let mut directed: HashMap<(u32, u32), u32> = HashMap::new();
    let mut volume = 0.0;
    let at = |i: u32| [mesh.positions[3 * i as usize], mesh.positions[3 * i as usize + 1], mesh.positions[3 * i as usize + 2]];
    for q in mesh.quads.chunks(4) {
        for k in 0..4 {
            valence_of[q[k] as usize] += 1;
            let (a, b) = (q[k], q[(k + 1) % 4]);
            *undirected.entry((a.min(b), a.max(b))).or_default() += 1;
            *directed.entry((a, b)).or_default() += 1;
        }
        for triangle in [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] {
            let (a, b, c) = (at(triangle[0]), at(triangle[1]), at(triangle[2]));
            volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0;
        }
    }
    let mut valence = HashMap::new();
    for v in valence_of {
        *valence.entry(v).or_default() += 1;
    }
    Measured {
        quads: mesh.quads.len() / 4,
        open_edges: undirected.values().filter(|&&c| c == 1).count(),
        non_manifold_edges: undirected.values().filter(|&&c| c > 2).count(),
        inconsistent_edges: directed.values().filter(|&&c| c > 1).count(),
        volume,
        valence,
    }
}

/// Topology consistency of a closed genus-0 quad mesh: the sum over vertices of (4 - valence) is 8 (Euler characteristic 2), true of ANY such mesh, so this
/// checks that the result is a sphere, not how good it is; the quality asserts are the irregular-vertex count and the reference histogram below.
fn assert_sphere_topology(m: &Measured) {
    let defect: i64 = m.valence.iter().map(|(valence, count)| (4 - i64::from(*valence)) * *count as i64).sum();
    assert_eq!(defect, 8, "Euler characteristic 2: {:?}", m.valence);
    let irregular: usize = m.valence.iter().filter(|(valence, _)| **valence != 4).map(|(_, count)| *count).sum();
    assert!(irregular <= 12, "few singularities: {:?}", m.valence);
    assert!(m.valence.keys().all(|valence| (3..=5).contains(valence)), "valence 3, 4 or 5 only: {:?}", m.valence);
}

fn assert_closed_manifold(m: &Measured) {
    assert_eq!((m.open_edges, m.non_manifold_edges, m.inconsistent_edges), (0, 0, 0), "closed, manifold, consistently wound");
}

#[test]
fn sphere_quad_count_follows_the_target() {
    let (positions, triangles) = icosphere(4);
    for target in [100, 300, 600, 1000, 2000] {
        let m = measure(&quad_remesh(&positions, &triangles, &params(target)).expect("remesh"));
        assert_closed_manifold(&m);
        let ratio = m.quads as f64 / target as f64;
        assert!((0.85..=1.15).contains(&ratio), "target {target}: {} quads (ratio {ratio:.3})", m.quads);
    }
}

#[test]
fn sphere_is_regular_with_eight_corners_on_the_surface() {
    let (positions, triangles) = icosphere(4);
    let mesh = quad_remesh(&positions, &triangles, &params(600)).expect("remesh");
    let m = measure(&mesh);
    assert_closed_manifold(&m);
    assert_sphere_topology(&m);
    let sphere_volume = 4.0 / 3.0 * std::f64::consts::PI * RADIUS.powi(3);
    assert!(
        m.volume > 0.0 && (m.volume / sphere_volume - 1.0).abs() < 0.02,
        "outward winding, volume {} against {sphere_volume}",
        m.volume
    );
    let worst = mesh.positions.chunks(3).map(|p| ((p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt() - RADIUS).abs()).fold(0.0, f64::max);
    assert!(worst < 0.15, "every vertex lies on the sphere within 1.5 %: worst {worst}");
}

#[test]
fn the_result_is_reproducible() {
    let (positions, triangles) = icosphere(3);
    let first = quad_remesh(&positions, &triangles, &params(200)).expect("remesh");
    let second = quad_remesh(&positions, &triangles, &params(200)).expect("remesh");
    assert_eq!((first.positions, first.quads), (second.positions, second.quads));
}

#[test]
fn stages_come_in_order_with_rising_fractions_and_do_not_change_the_result() {
    let (positions, triangles) = icosphere(3);
    let mut stages: Vec<(String, f64)> = Vec::new();
    let heard =
        quad_remesh_with_stages(&positions, &triangles, &params(200), &mut |name, fraction| stages.push((name.to_string(), fraction)))
            .expect("remesh");
    let names: Vec<&str> = stages.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        [
            "prepare",
            "orientation_field",
            "scale",
            "position_field",
            "integer_constraints",
            "max_flow",
            "fix_flips",
            "final_positions",
            "extract_quads",
            "fix_valence"
        ]
    );
    assert!(stages.windows(2).all(|pair| pair[0].1 < pair[1].1) && stages[0].1 == 0.0 && stages[9].1 < 1.0);
    let silent = quad_remesh(&positions, &triangles, &params(200)).expect("remesh");
    assert_eq!((heard.positions, heard.quads), (silent.positions, silent.quads));
}

#[test]
fn a_failure_still_reports_the_stages_it_reached() {
    let (positions, triangles) = box_mesh(1, false);
    let mut reached = 0;
    let error = quad_remesh_with_stages(&positions, &triangles, &params(50), &mut |_, _| reached += 1).expect_err("a singular system");
    assert!(!error.0.is_empty() && reached >= 1);
}

#[test]
fn a_box_keeps_its_volume_with_and_without_sharp_alignment() {
    let (positions, triangles) = box_mesh(8, true);
    for preserve_sharp in [false, true] {
        let mut p = params(600);
        p.preserve_sharp = preserve_sharp;
        let m = measure(&quad_remesh(&positions, &triangles, &p).expect("remesh"));
        assert_closed_manifold(&m);
        assert_sphere_topology(&m);
        assert!((m.volume / 1000.0 - 1.0).abs() < 0.005, "sharp {preserve_sharp}: volume {}", m.volume);
    }
}

/// A cylinder (radius 5, height 10, flat caps, 90 degree rims): `segments` around, `rows` along.
fn cylinder(segments: u32, rows: u32) -> (Vec<f64>, Vec<u32>) {
    let mut p: Vec<f64> = Vec::new();
    for r in 0..=rows {
        for s in 0..segments {
            let a = 2.0 * std::f64::consts::PI * f64::from(s) / f64::from(segments);
            p.extend([5.0 * a.cos(), 5.0 * a.sin(), 10.0 * f64::from(r) / f64::from(rows)]);
        }
    }
    let bottom = p.len() as u32 / 3;
    p.extend([0.0, 0.0, 0.0, 0.0, 0.0, 10.0]);
    let top = bottom + 1;
    let id = |r: u32, s: u32| r * segments + s % segments;
    let mut t: Vec<u32> = Vec::new();
    for r in 0..rows {
        for s in 0..segments {
            t.extend([id(r, s), id(r, s + 1), id(r + 1, s + 1), id(r, s), id(r + 1, s + 1), id(r + 1, s)]);
        }
    }
    for s in 0..segments {
        t.extend([bottom, id(0, s + 1), id(0, s)]);
        t.extend([top, id(rows, s), id(rows, s + 1)]);
    }
    (p, t)
}

/// Largest distance from points of the two rim circles of the cylinder to the nearest quad edge: how well the quads follow the rims.
fn rim_gap(mesh: &QuadMesh) -> f64 {
    let at = |i: u32| [mesh.positions[3 * i as usize], mesh.positions[3 * i as usize + 1], mesh.positions[3 * i as usize + 2]];
    let segments: Vec<([f64; 3], [f64; 3])> =
        mesh.quads.chunks(4).flat_map(|q| (0..4).map(move |k| (q[k], q[(k + 1) % 4]))).map(|(a, b)| (at(a), at(b))).collect();
    let distance = |p: [f64; 3], (a, b): &([f64; 3], [f64; 3])| {
        let (ab, ap) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [p[0] - a[0], p[1] - a[1], p[2] - a[2]]);
        let s = ((ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2])).clamp(0.0, 1.0);
        ((ap[0] - s * ab[0]).powi(2) + (ap[1] - s * ab[1]).powi(2) + (ap[2] - s * ab[2]).powi(2)).sqrt()
    };
    let mut worst: f64 = 0.0;
    for z in [0.0, 10.0] {
        for k in 0..180 {
            let a = 2.0 * std::f64::consts::PI * f64::from(k) / 180.0;
            let p = [5.0 * a.cos(), 5.0 * a.sin(), z];
            worst = worst.max(segments.iter().map(|segment| distance(p, segment)).fold(f64::INFINITY, f64::min));
        }
    }
    worst
}

#[test]
fn sharp_alignment_puts_quad_edges_on_the_cylinder_rims() {
    let (positions, triangles) = cylinder(64, 8);
    let gap = |preserve_sharp: bool| {
        let mut p = params(300);
        p.preserve_sharp = preserve_sharp;
        let mesh = quad_remesh(&positions, &triangles, &p).expect("remesh");
        assert_closed_manifold(&measure(&mesh));
        rim_gap(&mesh)
    };
    // measured (target 300): 0.71 without, 0.15 with the alignment; a quad row straddling a rim leaves a gap of half its width
    let (free, aligned) = (gap(false), gap(true));
    assert!(aligned < 0.25, "aligned rims are covered by quad edges to 0.25 mm: {aligned}");
    assert!(free > 2.0 * aligned, "the alignment must change the result: {free} against {aligned}");
}

#[test]
fn adaptive_size_still_gives_a_closed_quad_mesh() {
    let (positions, triangles) = icosphere(4);
    let mut p = params(600);
    p.adaptive = true;
    assert_closed_manifold(&measure(&quad_remesh(&positions, &triangles, &p).expect("remesh")));
}

#[test]
fn an_inconsistently_wound_input_is_an_error_not_an_abort() {
    let (positions, triangles) = box_mesh(1, false);
    let error = quad_remesh(&positions, &triangles, &params(50)).expect_err("a singular system must come back as an error");
    assert!(error.0.contains("assertion failed"), "{error}");
}

#[test]
fn tetrahedron_six_quads_is_an_error() {
    // QuadriFlow extracts no quad here; upstream then solved an empty system and divided by zero inside Eigen's sparse LU (the process died)
    let positions = vec![1.0, 1.0, 1.0, 1.0, -1.0, -1.0, -1.0, 1.0, -1.0, -1.0, -1.0, 1.0];
    let triangles = vec![0u32, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
    let error = quad_remesh(&positions, &triangles, &params(6)).expect_err("a target too small for the mesh must come back as an error");
    assert!(error.0.contains("no quad"), "{error}");
}

/// The exact valence histogram of the reference build (Windows x86-64, MSVC): floating-point code generation differs between compilers, so other
/// platforms may land on another, equally valid, histogram (the tests above hold everywhere).
#[cfg(all(windows, target_arch = "x86_64"))]
#[test]
fn reference_build_valence_histogram_win32_x64() {
    let (positions, triangles) = icosphere(4);
    let m = measure(&quad_remesh(&positions, &triangles, &params(600)).expect("remesh"));
    let mut histogram: Vec<(u32, usize)> = m.valence.into_iter().collect();
    histogram.sort();
    assert_eq!((m.quads, histogram), (592, vec![(3, 9), (4, 584), (5, 1)]), "icosphere l4, 600 quads, win32-x64");
}

/// The upper hemisphere (the triangles whose corners all have z >= 0) of the level 4 icosphere: an open surface with one boundary loop.
fn hemisphere() -> (Vec<f64>, Vec<u32>) {
    let (positions, triangles) = icosphere(4);
    let kept = triangles.chunks_exact(3).filter(|t| t.iter().all(|&v| positions[v as usize * 3 + 2] > -1e-9)).flatten().copied().collect();
    (positions, kept)
}

/// (boundary edges, non-manifold edges, the largest distance of a boundary vertex of `mesh` to the boundary of `source`) of a quad mesh.
fn boundary_report(mesh: &QuadMesh, source: &(Vec<f64>, Vec<u32>)) -> (usize, usize, f64) {
    let uses = |indices: &[u32], size: usize| {
        let mut uses: HashMap<(u32, u32), u32> = HashMap::new();
        for face in indices.chunks_exact(size) {
            for k in 0..size {
                let (a, b) = (face[k], face[(k + 1) % size]);
                *uses.entry((a.min(b), a.max(b))).or_insert(0) += 1;
            }
        }
        uses
    };
    let rim: Vec<([f64; 3], [f64; 3])> = uses(&source.1, 3)
        .iter()
        .filter(|(_, &n)| n == 1)
        .map(|(&(a, b), _)| {
            let p = |v: u32| [source.0[v as usize * 3], source.0[v as usize * 3 + 1], source.0[v as usize * 3 + 2]];
            (p(a), p(b))
        })
        .collect();
    let result = uses(&mesh.quads, 4);
    let mut worst: f64 = 0.0;
    for (&(a, b), _) in result.iter().filter(|(_, &n)| n == 1) {
        for v in [a, b] {
            let p = [mesh.positions[v as usize * 3], mesh.positions[v as usize * 3 + 1], mesh.positions[v as usize * 3 + 2]];
            let nearest = rim
                .iter()
                .map(|(s, e)| {
                    let d = [e[0] - s[0], e[1] - s[1], e[2] - s[2]];
                    let t = (((p[0] - s[0]) * d[0] + (p[1] - s[1]) * d[1] + (p[2] - s[2]) * d[2])
                        / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]))
                        .clamp(0.0, 1.0);
                    ((p[0] - s[0] - t * d[0]).powi(2) + (p[1] - s[1] - t * d[1]).powi(2) + (p[2] - s[2] - t * d[2]).powi(2)).sqrt()
                })
                .fold(f64::INFINITY, f64::min);
            worst = worst.max(nearest);
        }
    }
    (result.values().filter(|&&n| n == 1).count(), result.values().filter(|&&n| n > 2).count(), worst)
}

#[test]
fn an_open_mesh_with_preserve_boundary_follows_its_rim_closer_than_without() {
    let source = hemisphere();
    let ask = |preserve_boundary: bool| {
        let params = QuadParams { target_faces: 300, preserve_sharp: false, sharp_cos: 0.5, adaptive: false, preserve_boundary };
        quad_remesh(&source.0, &source.1, &params).expect("an open hemisphere is remeshed")
    };
    let (free, kept) = (ask(false), ask(true));
    let (free_report, kept_report) = (boundary_report(&free, &source), boundary_report(&kept, &source));
    // an open surface of quads, never a non-manifold one; the preserved boundary is the closer to the rim (the host snaps the rest onto it)
    assert_eq!((free_report.1, kept_report.1), (0, 0));
    assert!(kept_report.0 > 20 && free_report.0 > 20, "{free_report:?} {kept_report:?}");
    assert!(kept_report.2 < free_report.2, "preserved {} against free {}", kept_report.2, free_report.2);
    let count = kept.quads.len() / 4;
    assert!((210..390).contains(&count), "{count} quads for a target of 300");
}
