//! VC-SCN-23 (STL-A: IPE 300 ranked first, h and b within 3 mm) on synthetic members in arbitrary orientation, the chirality of an unequal
//! angle, the axis hint, the warning of a non-catalogue section and the failure codes.

use llull_cloud::fit::steel::{fit, Outline};
use llull_cloud::fit::FitSettings;
use llull_cloud::kdtree::Rng;
use llull_cloud::linalg::{add, cross, dot, norm, scale, sub};

type V = [f64; 3];

fn gauss(rng: &mut Rng) -> f64 {
    let (a, b) = (rng.unit().max(1e-12), rng.unit());
    (-2.0 * a.ln()).sqrt() * (std::f64::consts::TAU * b).cos()
}

/// I outline in metres, x = width, y = depth (the TS `profileOutline` order).
fn i_loop(h: f64, b: f64, tw: f64, tf: f64) -> Vec<[f64; 2]> {
    let (x, y) = (b / 2.0, h / 2.0);
    vec![
        [-x, -y],
        [x, -y],
        [x, -y + tf],
        [tw / 2.0, -y + tf],
        [tw / 2.0, y - tf],
        [x, y - tf],
        [x, y],
        [-x, y],
        [-x, y - tf],
        [-tw / 2.0, y - tf],
        [-tw / 2.0, -y + tf],
        [-x, -y + tf],
    ]
}

fn l_loop(h: f64, b: f64, t: f64) -> Vec<[f64; 2]> {
    let (x, y) = (b / 2.0, h / 2.0);
    vec![[-x, -y], [x, -y], [x, -y + t], [-x + t, -y + t], [-x + t, y], [-x, y]]
}

fn outline(name: &str, loop_xy: Vec<[f64; 2]>) -> Outline {
    Outline { name: name.to_string(), loop_xy }
}

fn catalogue() -> Vec<Outline> {
    vec![
        outline("IPE200", i_loop(0.2, 0.1, 0.0056, 0.0085)),
        outline("IPE270", i_loop(0.27, 0.135, 0.0066, 0.0102)),
        outline("IPE300", i_loop(0.3, 0.15, 0.0071, 0.0107)),
        outline("IPE330", i_loop(0.33, 0.16, 0.0075, 0.0115)),
        outline("HEA300", i_loop(0.29, 0.3, 0.0085, 0.014)),
        outline("L150x100x10", l_loop(0.15, 0.1, 0.01)),
        outline("L100x150x10", l_loop(0.1, 0.15, 0.01)),
    ]
}

struct Frame {
    origin: V,
    x: V,
    y: V,
    z: V,
}

/// Surface points along a loop (mapped through the frame) over `length`, noise sigma `sigma`.
fn member(rng: &mut Rng, loop_xy: &[[f64; 2]], n: usize, length: f64, sigma: f64, f: &Frame) -> Vec<V> {
    let m = loop_xy.len();
    let lengths: Vec<f64> = (0..m)
        .map(|i| {
            let (a, b) = (loop_xy[i], loop_xy[(i + 1) % m]);
            ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt()
        })
        .collect();
    let total: f64 = lengths.iter().sum();
    (0..n)
        .map(|_| {
            let mut s = rng.unit() * total;
            let mut i = 0;
            while i + 1 < m && s > lengths[i] {
                s -= lengths[i];
                i += 1;
            }
            let (a, b) = (loop_xy[i], loop_xy[(i + 1) % m]);
            let t = s / lengths[i];
            let (px, py) = (a[0] + t * (b[0] - a[0]) + sigma * gauss(rng), a[1] + t * (b[1] - a[1]) + sigma * gauss(rng));
            add(&f.origin, &add(&scale(&f.x, px), &add(&scale(&f.y, py), &scale(&f.z, length * rng.unit()))))
        })
        .collect()
}

fn unit_v(v: V) -> V {
    scale(&v, 1.0 / norm(&v))
}

fn aligned() -> Frame {
    Frame { origin: [0.0; 3], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], z: [0.0, 0.0, 1.0] }
}

fn settings() -> FitSettings {
    FitSettings { noise_sigma: Some(0.0005), ..FitSettings::default() }
}

#[test]
fn vc_scn_23_stl_a_ipe_300_is_ranked_first_with_h_and_b_within_3_mm() {
    let mut rng = Rng::new(7);
    let z = unit_v([0.3, 0.8, 0.5]);
    let x = unit_v(cross(&z, &[0.0, 0.0, 1.0]));
    let y = cross(&z, &x);
    let frame = Frame { origin: [1.0, 2.0, 3.0], x, y, z };
    let points = member(&mut rng, &i_loop(0.3, 0.15, 0.0071, 0.0107), 6000, 3.0, 0.0005, &frame);
    let found = fit(&points, &catalogue(), None, 5, &settings()).unwrap();
    let best = &found.candidates[0];
    assert_eq!(best.profile, "IPE300");
    assert!((best.h - 0.3).abs() < 0.003 && (best.b - 0.15).abs() < 0.003, "h {} b {}", best.h, best.b);
    assert!(found.candidates[1].score > best.score);
    assert!(found.warnings.is_empty());
    assert!((found.length - 3.0).abs() < 0.05, "length {}", found.length);
    assert!(dot(&found.axis_direction, &z).abs() > 0.999);
    assert!(dot(&best.depth_direction, &found.axis_direction).abs() < 1e-9);
    assert!(dot(&best.depth_direction, &y).abs() > 0.999, "depth {:?} vs {:?}", best.depth_direction, y);
    assert!(dot(&sub(&found.end, &found.start), &found.axis_direction) > 0.0);
}

#[test]
fn an_unequal_angle_keeps_its_chirality_through_the_axis_direction() {
    let mut rng = Rng::new(11);
    let frame = aligned();
    let points = member(&mut rng, &l_loop(0.15, 0.1, 0.01), 4000, 2.0, 0.0005, &frame);
    let found = fit(&points, &catalogue(), None, 3, &settings()).unwrap();
    let best = &found.candidates[0];
    assert_eq!(best.profile, "L150x100x10");
    let handed = cross(&best.width_direction, &best.depth_direction);
    assert!(dot(&handed, &best.axis_direction) > 0.999);
    assert!(dot(&best.depth_direction, &frame.y).abs() > 0.99 && dot(&best.width_direction, &frame.x).abs() > 0.99);
    assert!(dot(&best.width_direction, &frame.x) * dot(&best.axis_direction, &frame.z) > 0.0);
}

#[test]
fn the_axis_hint_overrides_the_principal_axis_of_a_short_member() {
    let mut rng = Rng::new(3);
    let points = member(&mut rng, &i_loop(0.3, 0.15, 0.0071, 0.0107), 4000, 0.12, 0.0004, &aligned());
    let found = fit(&points, &catalogue(), Some([0.0, 0.0, 2.0]), 2, &settings()).unwrap();
    assert_eq!(found.candidates[0].profile, "IPE300");
    assert_eq!(found.candidates.len(), 2);
    assert!((found.length - 0.12).abs() < 0.01);
}

#[test]
fn a_built_up_section_warns_no_match() {
    let mut rng = Rng::new(5);
    let boxed = vec![[-0.075, -0.08], [0.075, -0.08], [0.075, 0.08], [-0.075, 0.08]];
    let points = member(&mut rng, &boxed, 4000, 2.0, 0.0005, &aligned());
    let found = fit(&points, &catalogue(), None, 3, &settings()).unwrap();
    assert!(found.warnings.iter().any(|w| w.code == "SCN_STEEL_NO_MATCH"));
}

#[test]
fn failures_are_named() {
    let few: Vec<V> = (0..10).map(|i| [i as f64, 0.0, 0.0]).collect();
    assert_eq!(fit(&few, &catalogue(), None, 5, &settings()).unwrap_err().code, "SCN_FIT_TOO_FEW_POINTS");
    let mut rng = Rng::new(1);
    let points = member(&mut rng, &i_loop(0.3, 0.15, 0.0071, 0.0107), 800, 2.0, 0.0004, &aligned());
    assert_eq!(fit(&points, &[], None, 5, &settings()).unwrap_err().code, "NATIVE_JOB_INPUT");
    assert_eq!(fit(&points, &[outline("bad", vec![[0.0, 0.0], [1.0, 0.0]])], None, 5, &settings()).unwrap_err().code, "NATIVE_JOB_INPUT");
    assert_eq!(fit(&points, &catalogue(), Some([0.0; 3]), 5, &settings()).unwrap_err().code, "NATIVE_JOB_INPUT");
    let wire: Vec<V> = (0..100).map(|i| [0.001 * rng.unit(), 0.001 * rng.unit(), i as f64 * 0.02]).collect();
    assert_eq!(fit(&wire, &catalogue(), None, 5, &settings()).unwrap_err().code, "SCN_FIT_NO_MODEL");
    let bar = vec![[-0.01, -0.01], [0.01, -0.01], [0.01, 0.01], [-0.01, 0.01]];
    let thin = member(&mut rng, &bar, 600, 2.0, 0.0001, &aligned());
    assert_eq!(fit(&thin, &catalogue(), None, 5, &settings()).unwrap_err().code, "SCN_STEEL_NO_MATCH");
}

#[test]
fn vc_scn_23_on_the_pack_file_stl_a() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/plant/10-pointcloud-brownfield/validation/data/synthetic/stl-a.csv");
    let text = std::fs::read_to_string(path).unwrap();
    let points: Vec<V> = text
        .lines()
        .skip(1)
        .map(|line| {
            let v: Vec<f64> = line.split(',').map(|s| s.trim().parse().unwrap()).collect();
            [v[0], v[1], v[2]]
        })
        .collect();
    assert_eq!(points.len(), 8000);
    let found = fit(&points, &catalogue(), None, 5, &FitSettings { noise_sigma: Some(0.001), ..FitSettings::default() }).unwrap();
    let best = &found.candidates[0];
    assert_eq!(best.profile, "IPE300");
    assert!((best.h - 0.3).abs() < 0.003 && (best.b - 0.15).abs() < 0.003, "h {} b {}", best.h, best.b);
    assert!(dot(&found.axis_direction, &[0.0, 1.0, 0.0]).abs() > 0.99999, "axis {:?}", found.axis_direction);
    let off = sub(&best.centre, &[5.0, best.centre[1], 4.0]);
    assert!(norm(&off) < 0.003, "centre {:?}", best.centre);
}
