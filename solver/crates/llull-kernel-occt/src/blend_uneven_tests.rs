//! DES-6c review: radius laws on an edge that does not run at a steady speed (cpp/law_fillet.cxx): the kernel reports its decision in the topology, a failed arc
//! length inversion is OCCT's own transition (even path) or a named refusal (never a crash, never a silently skipped edge), and a many-node law builds.

use crate::features::{chain_face, fillet, fillet_laws, prism_of_face};
use crate::queries::topology;
use crate::test_bridge::{set_law_inversion_fault, set_law_node_cap};
use crate::{make_cylinder, Shape};
use serde_json::Value;

const A: f64 = 12.0;
const B: f64 = 6.0;
const HEIGHT: f64 = 4.0;

/// A quarter of an elliptic cylinder (semi-axes 12 and 6, height 4): the top elliptic arc runs between two right-angle corners, alone in its tangent chain.
fn quarter_ellipse() -> Shape {
    // the winding the prism accepts (the other one gives an invalid zero-volume body): line up the y axis, the ellipse quarter [(0, b), centre, (a, 0)], line back
    let chain = [0.0, 0.0, 0.0, 0.0, 0.0, B, 0.0, 3.0, 0.0, B, 0.0, 0.0, 0.0, 0.0, A, 0.0, 0.0, 0.0, A, 0.0, 0.0, 0.0, 0.0, 0.0];
    let face = chain_face(&chain).unwrap().unwrap();
    prism_of_face(&face, [0.0, 0.0, HEIGHT]).unwrap().unwrap()
}

/// The unique edge index of the top elliptic arc.
fn top_arc(shape: &Shape) -> u32 {
    let topo = topology(shape).unwrap();
    let edges = topo["edges"].as_array().unwrap();
    edges
        .iter()
        .position(|edge| edge["curve"] == "ellipse" && edge["start"][2].as_f64().unwrap() > 0.5 * HEIGHT)
        .expect("the top elliptic arc") as u32
}

/// Restores the hooks whatever the test does.
struct FaultGuard;

impl FaultGuard {
    fn after(inversions: i32) -> Self {
        set_law_inversion_fault(inversions);
        FaultGuard
    }
}

impl Drop for FaultGuard {
    fn drop(&mut self) {
        set_law_inversion_fault(-1);
        set_law_node_cap(0);
    }
}

fn volume(shape: &Shape) -> f64 {
    crate::mass_properties(shape).unwrap().volume
}

#[test]
fn the_topology_reports_the_speed_decision_of_a_curved_edge_and_none_for_a_line() {
    let _serial = crate::serial_blends();
    let arc = quarter_ellipse();
    let topo = topology(&arc).unwrap();
    let edges = topo["edges"].as_array().unwrap();
    let elliptic = &edges[top_arc(&arc) as usize];
    assert_eq!(elliptic["unevenSpeed"], Value::Bool(true), "a 2:1 ellipse runs at an uneven speed");
    assert!(
        edges.iter().filter(|edge| edge["curve"] == "line").all(|edge| edge.get("unevenSpeed").is_none()),
        "a line carries no decision"
    );
    let cylinder = make_cylinder(5.0, 3.0).unwrap().unwrap();
    let circles: Vec<Value> =
        topology(&cylinder).unwrap()["edges"].as_array().unwrap().iter().filter(|edge| edge["curve"] == "circle").cloned().collect();
    assert!(
        !circles.is_empty() && circles.iter().all(|edge| edge["unevenSpeed"] == Value::Bool(false)),
        "a circle runs at a steady speed: {circles:?}"
    );
}

#[test]
fn a_radius_pair_on_an_uneven_edge_builds_on_the_arc_length_and_a_failed_inversion_in_the_decision_is_occt_s_own_transition() {
    let _serial = crate::serial_blends();
    let arc = quarter_ellipse();
    let edge = top_arc(&arc);
    let on_arc_length = fillet(&arc, &[edge], 0.5, Some(1.5)).unwrap().expect("the arc-length law builds");
    // the very first inversion fails inside the decision: the edge counts as even, OCCT's Add(r1, r2, e) builds (never an exception across the boundary)
    let own = {
        let _fault = FaultGuard::after(0);
        fillet(&arc, &[edge], 0.5, Some(1.5)).unwrap().expect("OCCT's own transition builds")
    };
    let (law, occt) = (volume(&on_arc_length), volume(&own));
    assert!(law > 0.0 && occt > 0.0 && (law - occt).abs() > 1e-9, "two different laws: arc length {law}, parameter {occt}");
    assert!(((law - occt) / law).abs() < 0.01, "both remove a similar amount of material: {law} vs {occt}");
}

#[test]
fn a_node_that_cannot_be_placed_is_a_named_refusal_not_a_skipped_edge_or_a_crash() {
    let _serial = crate::serial_blends();
    let arc = quarter_ellipse();
    let edge = top_arc(&arc);
    // the five probes of the decision succeed, the first node inversion fails: radius + radiusEnd, a three node law and a straight law all name the reason
    for refused in [
        {
            let _fault = FaultGuard::after(5);
            fillet(&arc, &[edge], 0.5, Some(1.5))
        },
        {
            let _fault = FaultGuard::after(5);
            fillet_laws(&arc, &[edge], &[0.5, 1.5, 0.0, 1.0, 0.5, 1.0])
        },
        {
            let _fault = FaultGuard::after(5);
            fillet_laws(&arc, &[edge], &[0.5, 1.5, 1.0, 0.0])
        },
    ] {
        let Err(reason) = refused else { panic!("a refusal with its reason") };
        assert!(reason.contains("law node not placed"), "named reason: {reason}");
    }
    // off again: the same fillet builds
    assert!(fillet(&arc, &[edge], 0.5, Some(1.5)).unwrap().is_some());
}

#[test]
fn a_nine_node_law_on_the_ellipse_builds_within_the_node_cap() {
    let _serial = crate::serial_blends();
    let arc = quarter_ellipse();
    let edge = top_arc(&arc);
    // start 0.4, end 0.6, seven interior nodes (relative position, radius) oscillating around 0.5
    let nodes = [0.125, 0.55, 0.25, 0.45, 0.375, 0.58, 0.5, 0.42, 0.625, 0.56, 0.75, 0.47, 0.875, 0.53];
    for mode in [0.0, 1.0, 2.0] {
        let mut laws = vec![0.4, 0.6, mode, 7.0];
        laws.extend_from_slice(&nodes);
        let started = std::time::Instant::now();
        let shape = fillet_laws(&arc, &[edge], &laws).unwrap().unwrap_or_else(|| panic!("mode {mode}: the nine node law builds"));
        let seconds = started.elapsed().as_secs_f64();
        assert!(volume(&shape) > 0.0 && seconds < 20.0, "mode {mode}: built in {seconds} s");
    }
}

#[test]
fn a_stretch_that_would_need_more_nodes_than_the_cap_is_refused_with_the_gap_never_accepted() {
    let _serial = crate::serial_blends();
    let arc = quarter_ellipse();
    let edge = top_arc(&arc);
    let _restore = FaultGuard::after(-1);
    // 8 nodes per stretch leave 4 pieces of the 2:1 ellipse whose parameter chord misses the arc-length law by more than 1e-4 of the radius
    set_law_node_cap(8);
    for laws in [vec![0.5, 1.5, 0.0, 0.0], vec![0.5, 1.5, 1.0, 1.0, 0.5, 1.0]] {
        let Err(reason) = fillet_laws(&arc, &[edge], &laws) else { panic!("refused with its reason") };
        assert!(reason.contains("law nodes not placed") && reason.contains("limit 8"), "named reason: {reason}");
    }
    let Err(reason) = fillet(&arc, &[edge], 0.5, Some(1.5)) else { panic!("radius + radiusEnd refused too") };
    assert!(reason.contains("limit 8"), "named reason: {reason}");
    set_law_node_cap(0);
    assert!(fillet(&arc, &[edge], 0.5, Some(1.5)).unwrap().is_some(), "the default cap builds the same law");
}

/// The unevenness the kernel probes (law_fillet.cxx `uneven_curve`: the largest |parameter fraction - arc fraction| at the arc fractions 0.1, 0.3, 0.45, 0.7, 0.9) of the
/// quarter ellipse x = 1 cos t, y = (1 - flattening) sin t, t in [0, pi/2], by Simpson's rule on the arc length and bisection for its inverse: independent of OCCT.
fn probed_unevenness(flattening: f64) -> f64 {
    let (a, b) = (1.0, 1.0 - flattening);
    let speed = |t: f64| (a * a * t.sin().powi(2) + b * b * t.cos().powi(2)).sqrt();
    let quarter = std::f64::consts::FRAC_PI_2;
    let length_to = |end: f64| {
        let steps = 4000;
        let h = end / f64::from(steps);
        (0..steps)
            .map(|k| {
                let t = f64::from(k) * h;
                h / 6.0 * (speed(t) + 4.0 * speed(t + 0.5 * h) + speed(t + h))
            })
            .sum::<f64>()
    };
    let total = length_to(quarter);
    [0.1, 0.3, 0.45, 0.7, 0.9]
        .iter()
        .map(|&arc| {
            let (mut low, mut high) = (0.0, quarter);
            for _ in 0..60 {
                let middle = 0.5 * (low + high);
                if length_to(middle) < arc * total {
                    low = middle
                } else {
                    high = middle
                }
            }
            (0.5 * (low + high) / quarter - arc).abs()
        })
        .fold(0.0, f64::max)
}

/// The elliptic quarter arc of flattening `flattening` as a planar face (a face has the same edges): its decision in the topology.
fn decided_uneven(flattening: f64) -> bool {
    let b = 1.0 - flattening;
    let chain = [0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 3.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, b, 0.0, 0.0, b, 0.0, 0.0, 0.0, 0.0, 0.0];
    let face = chain_face(&chain).unwrap().unwrap();
    let topo = topology(&face).unwrap();
    let edge = topo["edges"].as_array().unwrap().iter().find(|edge| edge["curve"] == "ellipse").expect("the elliptic arc").clone();
    edge["unevenSpeed"].as_bool().expect("the decision")
}

/// The flattening at which the probed unevenness equals `target` (it grows with the flattening).
fn flattening_for(target: f64) -> f64 {
    let (mut low, mut high) = (0.0, 0.2);
    for _ in 0..50 {
        let middle = 0.5 * (low + high);
        if probed_unevenness(middle) < target {
            low = middle
        } else {
            high = middle
        }
    }
    0.5 * (low + high)
}

#[test]
fn the_decision_flips_at_one_e_minus_five_of_the_probed_unevenness() {
    let _serial = crate::serial_blends();
    let (below, above) = (flattening_for(0.9e-5), flattening_for(1.1e-5));
    assert!((probed_unevenness(below) - 0.9e-5).abs() < 1e-8 && (probed_unevenness(above) - 1.1e-5).abs() < 1e-8);
    assert!(!decided_uneven(below), "0.9e-5 (flattening {below}) is a steady speed");
    assert!(decided_uneven(above), "1.1e-5 (flattening {above}) is an uneven speed");
}
