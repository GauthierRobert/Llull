//! BLD §13.44: measurement of the loop-vertex compatibility of a G2 star (the third-order jets of the two supports at the vertex where a spoke leaves the loop).
//! A measurement, not a regression test: run with `cargo test --release -p llull-kernel-occt g2_vertex_probe -- --ignored --nocapture`.

use crate::blend_corner_tests::{num, point};
use crate::blend_g2corner_tests::profile_of;
use crate::features::shape_notes;
use crate::queries::{edge_samples, evaluate_face, face_bspline, face_graph, project_on_face, topology};
use crate::Shape;
use serde_json::Value;

type V3 = [f64; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn unit(a: V3) -> V3 {
    let n = dot(a, a).sqrt();
    [a[0] / n, a[1] / n, a[2] / n]
}
fn near(a: V3, b: V3) -> bool {
    dot(sub(a, b), sub(a, b)).sqrt() < 1e-6
}

/// Solves the least squares problem `rows * x = rhs` by the normal equations (Gaussian elimination, partial pivoting).
fn least_squares(rows: &[Vec<f64>], rhs: &[f64]) -> Vec<f64> {
    let n = rows[0].len();
    let mut a = vec![vec![0.0; n + 1]; n];
    for (row, b) in rows.iter().zip(rhs) {
        for i in 0..n {
            for j in 0..n {
                a[i][j] += row[i] * row[j];
            }
            a[i][n] += row[i] * b;
        }
    }
    for col in 0..n {
        let pivot = (col..n).max_by(|&p, &q| a[p][col].abs().total_cmp(&a[q][col].abs())).unwrap();
        a.swap(col, pivot);
        let pivot_row = a[col].clone();
        for row in a.iter_mut().skip(col + 1) {
            let factor = row[col] / pivot_row[col];
            for (value, lead) in row[col..].iter_mut().zip(&pivot_row[col..]) {
                *value -= factor * lead;
            }
        }
    }
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let tail: f64 = (i + 1..n).map(|j| a[i][j] * x[j]).sum();
        x[i] = (a[i][n] - tail) / a[i][i];
    }
    x
}

/// The cubic part `[c30, c21, c12, c03]` of the height of `face` over the plane (`origin`, `frame` = t1, t2, n) as a polynomial in (x, y) near `origin`, fitted over a quadrant of
/// the face's parameter box of 3D radius `radius` by a degree 5 least squares fit (the cubic coefficients carry an error of the order radius^3).
fn height_jet(shape: &Shape, face: f64, origin: V3, frame: [V3; 3], radius: f64) -> ([f64; 4], f64) {
    let surface = face_bspline(shape, face).unwrap();
    let range = |key: &str| {
        let knots = surface[key].as_array().unwrap();
        (num(&knots[0]), num(&knots[knots.len() - 1]))
    };
    let ((u_min, u_max), (v_min, v_max)) = (range("knotsU"), range("knotsV"));
    let projected = project_on_face(shape, face, &origin).unwrap();
    let uv = [num(&projected[0]["uv"][0]), num(&projected[0]["uv"][1])];
    let eval = |u: f64, v: f64| point(&evaluate_face(shape, face, &[u, v]).unwrap()[0]["point"]);
    let h = 1e-6 * (u_max - u_min).max(v_max - v_min);
    let (pu, pv) = (sub(eval(uv[0] + h, uv[1]), eval(uv[0], uv[1])), sub(eval(uv[0], uv[1] + h), eval(uv[0], uv[1])));
    let (su, sv) = (h / dot(pu, pu).sqrt(), h / dot(pv, pv).sqrt());
    let toward = |at: f64, low: f64, high: f64| if at - low < high - at { 1.0 } else { -1.0 };
    let (du, dv) = (toward(uv[0], u_min, u_max) * radius * su, toward(uv[1], v_min, v_max) * radius * sv);
    let degree = 5usize;
    let monomials: Vec<(usize, usize)> = (0..=degree).flat_map(|i| (0..=degree - i).map(move |j| (i, j))).collect();
    let (mut rows, mut rhs) = (Vec::new(), Vec::new());
    for a in 0..=10 {
        for b in 0..=10 {
            let p = eval(uv[0] + du * a as f64 / 10.0, uv[1] + dv * b as f64 / 10.0);
            let d = sub(p, origin);
            let (x, y, z) = (dot(d, frame[0]) / radius, dot(d, frame[1]) / radius, dot(d, frame[2]) / radius);
            rows.push(monomials.iter().map(|&(i, j)| x.powi(i as i32) * y.powi(j as i32)).collect());
            rhs.push(z);
        }
    }
    let coeff = least_squares(&rows, &rhs);
    let at = |i: usize, j: usize| coeff[monomials.iter().position(|&m| m == (i, j)).unwrap()] / radius.powi(i as i32 + j as i32 - 1);
    // the constant and linear terms must vanish (the tangent plane of the face at the vertex): returned as the size of the first order slope
    let slope = (at(1, 0) * radius).hypot(at(0, 1) * radius) / radius;
    ([at(3, 0), at(2, 1), at(1, 2), at(0, 3)], slope)
}

/// The trilinear form of the cubic part `c` ([c30, c21, c12, c03]: h3 = c30 x^3 + c21 x^2 y + c12 x y^2 + c03 y^3) on two-dimensional vectors.
fn trilinear(c: [f64; 4], a: [f64; 2], b: [f64; 2], d: [f64; 2]) -> f64 {
    // C(x,x,x) = 6 c30, C(x,x,y) = 2 c21, C(x,y,y) = 2 c12, C(y,y,y) = 6 c03
    let comp = [6.0 * c[0], 2.0 * c[1], 2.0 * c[2], 6.0 * c[3]];
    let mut total = 0.0;
    for (i, &ai) in [a[0], a[1]].iter().enumerate() {
        for (j, &bj) in [b[0], b[1]].iter().enumerate() {
            for (k, &dk) in [d[0], d[1]].iter().enumerate() {
                total += comp[i + j + k] * ai * bj * dk;
            }
        }
    }
    total
}

struct Vertex {
    at: V3,
    spoke: V3,
    edges: [V3; 2],
    faces: [usize; 2],
    supports: [usize; 2],
    length: f64,
}

/// Every (spoke, loop vertex) of the star corners of `shape`: the two sub-patches on each side of the spoke with their contact edge (direction away from the vertex) and support face.
fn vertices(shape: &Shape) -> Vec<Vertex> {
    let topo = topology(shape).unwrap();
    let names: Vec<String> = topo["faces"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap_or("").to_string()).collect();
    let is_patch = |f: usize| names[f].starts_with("blend(v:");
    let graph = face_graph(shape).unwrap();
    let edge_faces: Vec<Vec<usize>> = graph["edgeFaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|faces| faces.as_array().unwrap().iter().map(|f| f.as_u64().unwrap() as usize).collect())
        .collect();
    let edges = topo["edges"].as_array().unwrap();
    let ends = |e: usize| (point(&edges[e]["start"]), point(&edges[e]["end"]));
    let direction_from = |e: usize, at: V3| {
        let samples = edge_samples(shape, e as f64, 2.0).unwrap();
        let (start, _) = ends(e);
        if near(start, at) {
            unit(point(&samples[0]["tangent"]))
        } else {
            let t = unit(point(&samples[1]["tangent"]));
            [-t[0], -t[1], -t[2]]
        }
    };
    let contacts: Vec<usize> =
        (0..edges.len()).filter(|&e| edge_faces[e].len() == 2 && edge_faces[e].iter().filter(|&&f| is_patch(f)).count() == 1).collect();
    let mut found = Vec::new();
    for spoke in 0..edges.len() {
        if edge_faces[spoke].len() != 2 || !edge_faces[spoke].iter().all(|&f| is_patch(f)) {
            continue;
        }
        let (a, b) = ends(spoke);
        let on_contact = |p: V3| contacts.iter().any(|&c| near(ends(c).0, p) || near(ends(c).1, p));
        let at = if on_contact(a) {
            a
        } else if on_contact(b) {
            b
        } else {
            continue;
        };
        if on_contact(a) && on_contact(b) {
            continue;
        }
        let (mut edge_dirs, mut supports, mut faces) = (Vec::new(), Vec::new(), Vec::new());
        for &patch in &edge_faces[spoke] {
            let contact =
                contacts.iter().find(|&&c| edge_faces[c].contains(&patch) && (near(ends(c).0, at) || near(ends(c).1, at))).unwrap();
            edge_dirs.push(direction_from(*contact, at));
            supports.push(*edge_faces[*contact].iter().find(|&&f| f != patch).unwrap());
            faces.push(patch);
        }
        let length = num(&edges[spoke]["length"]);
        found.push(Vertex {
            at,
            spoke: direction_from(spoke, at),
            edges: [edge_dirs[0], edge_dirs[1]],
            faces: [faces[0], faces[1]],
            supports: [supports[0], supports[1]],
            length,
        });
    }
    found
}

fn report(label: &str, shape: &Shape) {
    let notes: Value = serde_json::from_str(&shape_notes(shape).unwrap()).unwrap();
    let vertex_relative: Vec<f64> =
        notes["corners"].as_array().unwrap().iter().map(|c| c["spokeVertexRelative"].as_f64().unwrap_or(f64::NAN)).collect();
    println!("== {label}: spokeVertexRelative {:.3?}", &vertex_relative[..vertex_relative.len().min(8)]);
    for (index, vertex) in vertices(shape).iter().enumerate().take(3) {
        let normal = {
            let projected = project_on_face(shape, vertex.faces[0] as f64, &vertex.at).unwrap();
            unit(point(&projected[0]["normal"]))
        };
        let s = unit(sub(
            vertex.spoke,
            [normal[0] * dot(vertex.spoke, normal), normal[1] * dot(vertex.spoke, normal), normal[2] * dot(vertex.spoke, normal)],
        ));
        let w = cross(normal, s);
        let frame = [s, w, normal];
        let flat = |v: V3| [dot(v, s), dot(v, w)];
        let (ea, eb) = (flat(vertex.edges[0]), flat(vertex.edges[1]));
        for radius in [0.04, 0.08, 0.12] {
            let mut jets = Vec::new();
            for (side, face) in [(0, vertex.supports[0]), (1, vertex.supports[1]), (0, vertex.faces[0]), (1, vertex.faces[1])] {
                let _ = side;
                let (c, slope) = height_jet(shape, face as f64, vertex.at, frame, radius);
                jets.push((c, slope));
            }
            let [(ta, sa), (tb, sb), (pa, _), (pb, _)] = [jets[0], jets[1], jets[2], jets[3]];
            let e = |t: [f64; 4], x: [f64; 2], y: [f64; 2], z: [f64; 2]| trilinear(t, x, y, z);
            // the support condition: both sides use their own support's jet
            let (ma, mb) = (e(ta, [1.0, 0.0], ea, eb), e(tb, [1.0, 0.0], ea, eb));
            // the same read from the built sub-patches (their own jets; equal where they are G2 to the supports along their edges)
            let (qa, qb) = (e(pa, [1.0, 0.0], ea, eb), e(pb, [1.0, 0.0], ea, eb));
            // the natural difference of the two sub-patches in the curvature across the spoke: K(w, w) per unit length of the spoke
            let k_ww = |t: [f64; 4]| trilinear(t, [1.0, 0.0], [0.0, 1.0], [0.0, 1.0]);
            println!(
            "V{index} L={:.3} angle(eA,eB)={:.1}deg slope(supports)={sa:.1e},{sb:.1e}: C_A(s,eA,eB)={ma:+.4e} C_B(s,eA,eB)={mb:+.4e} mismatch={:+.4e} | patches {qa:+.4e} {qb:+.4e} | K_ww support {:+.4} {:+.4} patch {:+.4} {:+.4}",
            vertex.length,
            (ea[0] * eb[0] + ea[1] * eb[1]).acos().to_degrees(),
            ma - mb,
            k_ww(ta),
            k_ww(tb),
            k_ww(pa),
            k_ww(pb)
        );
            // the least residual of K_A - K_B (symmetric forms on (s, w)) once the free terms t_A eps_A^2, t_B eps_B^2 are chosen to cancel what they can
            let form = |t: [f64; 4]| {
                let c = |a: [f64; 2], b: [f64; 2]| trilinear(t, [1.0, 0.0], a, b);
                [c([1.0, 0.0], [1.0, 0.0]), c([1.0, 0.0], [0.0, 1.0]), c([0.0, 1.0], [0.0, 1.0])]
            };
            let (fa, fb) = (form(ta), form(tb));
            let d = [fa[0] - fb[0], fa[1] - fb[1], fa[2] - fb[2]];
            let outer = |e: [f64; 2]| {
                let eps = [e[1], -e[0]];
                [eps[0] * eps[0], eps[0] * eps[1], eps[1] * eps[1]]
            };
            // Frobenius inner product of symmetric 2 x 2 forms stored as (xx, xy, yy): xx*xx + 2 xy*xy + yy*yy
            let ip = |p: [f64; 3], q: [f64; 3]| p[0] * q[0] + 2.0 * p[1] * q[1] + p[2] * q[2];
            let (ua, ub) = (outer(ea), outer(eb));
            let det = ip(ua, ua) * ip(ub, ub) - ip(ua, ub) * ip(ua, ub);
            let (da, db) = (ip(d, ua), ip(d, ub));
            let (x, y) = ((da * ip(ub, ub) - db * ip(ua, ub)) / det, (db * ip(ua, ua) - da * ip(ua, ub)) / det);
            let r = [d[0] - x * ua[0] - y * ub[0], d[1] - x * ua[1] - y * ub[1], d[2] - x * ua[2] - y * ub[2]];
            println!(
                "    r={radius}: least residual of K_A - K_B (ss, sw, ww) = {:+.4e} {:+.4e} {:+.4e}, norm {:.4e}",
                r[0],
                r[1],
                r[2],
                ip(r, r).sqrt()
            );
        }
    }
}

#[test]
#[ignore = "measurement (13.44.2)"]
fn g2_vertex_probe_cube_and_box() {
    let _serial = crate::serial_blends();
    let cube = profile_of(&crate::blend_corner_tests::cube(10.0), 1.0, 1.0, 0.5).unwrap();
    report("cube 10, size 1, shape 0.5", &cube);
    let uneven = crate::make_box([0.0; 3], [10.0, 7.0, 5.0]).unwrap().unwrap();
    let count = topology(&uneven).unwrap()["edges"].as_array().unwrap().len();
    let specs: Vec<f64> = (0..count).flat_map(|edge| [edge as f64, 1.0, 0.5, 0.8 + 0.1 * (edge % 4) as f64, f64::NAN, -1.0, 0.0]).collect();
    let built = crate::features::fillet_profile_blend(&uneven, &specs, &[], &[], 1.0, 0.5).unwrap().unwrap();
    report("box 10x7x5, sizes 0.8..1.1", &built);
    report("cube 10, size 2.4", &profile_of(&crate::blend_corner_tests::cube(10.0), 2.4, 1.0, 0.5).unwrap());
}
