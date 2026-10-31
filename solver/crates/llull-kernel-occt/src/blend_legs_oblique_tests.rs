//! BLD §13.40: a curvature (G2) section on an edge whose station plane is NOT a principal plane of the curved support: a cylinder (R 10, axis z) cut by the tilted
//! plane z = 20 + 0.3 x. The edge is an ellipse; the leg on the wall runs partly around the cylinder, so its normal curvature along the section is (t . tau)^2 / R
//! with tau the circumferential direction, neither 0 nor 1 / R. The oracle is a 3D numeric integration written here, independent of any revolution: the removed
//! volume is (1/3) of the closed surface integral of r . n dS over the ring bounded by the plane strip, the blend and the wall strip, taken with the section
//! computed at every angle (chord legs, tangent lines, bent quintic) and finite differences for the tangent vectors.

use crate::blend_legs_revolved_tests::curvature_jumps;
use crate::blend_legs_tests::{built, contacts, diagonal, edges_where, leg_row, plane_face, volume_of, NAN, PI};
use crate::{boolean, make_box, make_cylinder, placed, BooleanOp, Shape};

type V = [f64; 3];
const R: f64 = 10.0;
const H: f64 = 20.0;
const K: f64 = 0.3;

fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn mul(a: V, k: f64) -> V {
    [a[0] * k, a[1] * k, a[2] * k]
}
fn dot(a: V, b: V) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V, b: V) -> V {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn unit(a: V) -> V {
    mul(a, 1.0 / dot(a, a).sqrt())
}

/// Everything of the section at angle `theta`: the edge point, the contacts, the wall angle and height of B and the six poles.
struct Station {
    edge: V,
    a: V,
    phi: f64,
    wall_z: f64,
    poles: [V; 6],
}

fn station(theta: f64, d_plane: f64, d_wall: f64, shape: f64, bent: f64) -> Station {
    let edge = [R * theta.cos(), R * theta.sin(), H + K * R * theta.cos()];
    let e = unit([-R * theta.sin(), R * theta.cos(), -K * R * theta.sin()]);
    let plane_normal = unit([-K, 0.0, 1.0]);
    let mut u1 = unit(cross(plane_normal, e));
    if dot(u1, [-theta.cos(), -theta.sin(), 0.0]) < 0.0 {
        u1 = mul(u1, -1.0);
    }
    let a = add(edge, mul(u1, d_plane));
    // B: the point of the wall at the chord d_wall from the edge point in the plane perpendicular to e (the fixed point of project / drop e / rescale)
    let mut guess = add(edge, mul(unit(sub([0.0, 0.0, -1.0], mul(e, -e[2]))), d_wall));
    let mut b = guess;
    for _ in 0..200 {
        let phi = guess[1].atan2(guess[0]);
        let on = [R * phi.cos(), R * phi.sin(), guess[2]];
        let across = sub(on, edge);
        let across = sub(across, mul(e, dot(across, e)));
        let next = add(edge, mul(across, d_wall / dot(across, across).sqrt()));
        b = on;
        if dot(sub(next, on), sub(next, on)).sqrt() < 1e-14 {
            break;
        }
        guess = next;
    }
    let phi = b[1].atan2(b[0]);
    let normal = [phi.cos(), phi.sin(), 0.0];
    let tb = unit(cross(e, normal));
    // the apex: the meeting point of the tangent line of the plane at A (direction u1) and of the wall at B (direction tb), both perpendicular to e
    let c = dot(u1, tb);
    let det = 1.0 - c * c;
    let ab = sub(b, a);
    let (p, q) = (dot(ab, u1), dot(ab, tb));
    let (alpha, beta) = ((p - c * q) / det, (c * p - q) / det);
    let t = mul(add(add(a, mul(u1, alpha)), add(b, mul(tb, beta))), 0.5);
    // the normal curvature of the wall along the section direction (b -> t): (t . tau)^2 / R, toward the axis
    let tau = [-phi.sin(), phi.cos(), 0.0];
    let kappa = dot(tb, tau).powi(2) / R;
    let lead = 0.8 * shape * dot(sub(t, b), sub(t, b)).sqrt();
    let bend = mul(normal, -1.25 * kappa * lead * lead * bent);
    let (near, far) = (0.8 * shape, 0.4 * shape + 0.6);
    let poles = [
        a,
        add(a, mul(sub(t, a), near)),
        add(a, mul(sub(t, a), far)),
        add(add(b, mul(sub(t, b), far)), bend),
        add(b, mul(sub(t, b), near)),
        b,
    ];
    Station { edge, a, phi, wall_z: b[2], poles }
}

/// The point of the loop edge -> A -> (blend) -> B -> (wall) -> edge at `t` in [0, 3).
fn loop_point(st: &Station, theta: f64, t: f64) -> V {
    if t < 1.0 {
        return add(st.edge, mul(sub(st.a, st.edge), t));
    }
    if t < 2.0 {
        let u = t - 1.0;
        let binomial = [1.0, 5.0, 10.0, 10.0, 5.0, 1.0];
        let mut point = [0.0; 3];
        for (i, pole) in st.poles.iter().enumerate() {
            point = add(point, mul(*pole, binomial[i] * u.powi(i as i32) * (1.0 - u).powi(5 - i as i32)));
        }
        return point;
    }
    let s = t - 2.0;
    let mut delta = theta - st.phi;
    while delta > PI {
        delta -= 2.0 * PI;
    }
    while delta < -PI {
        delta += 2.0 * PI;
    }
    let phi = st.phi + s * delta;
    [R * phi.cos(), R * phi.sin(), st.wall_z + s * (st.edge[2] - st.wall_z)]
}

/// The volume of the ring between the plane, the wall and the blend: (1/3) |integral of r . (P_theta x P_t)|, r taken from the middle of the rim.
fn ring_volume(d_plane: f64, d_wall: f64, shape: f64, bent: f64) -> f64 {
    // 5-point Gauss-Legendre on 40 panels per piece of the loop; 720 angles (periodic trapezoid)
    let nodes = [-0.906_179_845_938_664, -0.538_469_310_105_683, 0.0, 0.538_469_310_105_683, 0.906_179_845_938_664];
    let weights = [0.236_926_885_056_189, 0.478_628_670_499_366, 0.568_888_888_888_889, 0.478_628_670_499_366, 0.236_926_885_056_189];
    let origin = [0.0, 0.0, H];
    let (steps, panels, dtheta, dt) = (720, 40 * 3, 1e-5, 1e-6);
    let mut total = 0.0;
    for step in 0..steps {
        let theta = 2.0 * PI * f64::from(step) / f64::from(steps);
        let (centre, ahead, behind) = (
            station(theta, d_plane, d_wall, shape, bent),
            station(theta + dtheta, d_plane, d_wall, shape, bent),
            station(theta - dtheta, d_plane, d_wall, shape, bent),
        );
        let mut ring = 0.0;
        for panel in 0..panels {
            for (node, weight) in nodes.iter().zip(weights) {
                let t = (f64::from(panel) + 0.5 + 0.5 * node) * 3.0 / f64::from(panels);
                let p = sub(loop_point(&centre, theta, t), origin);
                let p_theta = mul(sub(loop_point(&ahead, theta + dtheta, t), loop_point(&behind, theta - dtheta, t)), 0.5 / dtheta);
                let p_t = mul(sub(loop_point(&centre, theta, t + dt), loop_point(&centre, theta, t - dt)), 0.5 / dt);
                ring += 0.5 * weight * dot(p, cross(p_theta, p_t)) * 3.0 / f64::from(panels);
            }
        }
        total += ring * 2.0 * PI / f64::from(steps);
    }
    (total / 3.0).abs()
}

/// The cylinder R 10 (z in [0, 40]) cut by the plane z = 20 + 0.3 x: the box below the tilted plane intersected with the cylinder.
fn oblique_rim() -> Shape {
    let cylinder = make_cylinder(R, 40.0).unwrap().unwrap();
    let slab = make_box([-50.0, -50.0, -100.0], [100.0, 100.0, 100.0]).unwrap().unwrap();
    // tilt the top face (z = 0) about the y axis so that it reads z = 0.3 x, then lift it to z = 20
    let tilted = placed(&slab, [0.0, -K.atan(), 0.0], [0.0, 0.0, H], [0.0; 3]).unwrap().unwrap();
    boolean(BooleanOp::Intersect, &cylinder, &tilted, true).unwrap().unwrap()
}

#[test]
fn an_oblique_rim_with_a_curvature_section_matches_an_independent_3d_integral_and_is_g2_between_stations() {
    let _serial = crate::serial_blends();
    let part = oblique_rim();
    let top_normal = unit([-K, 0.0, 1.0]);
    let top = plane_face(&part, top_normal);
    let rim = edges_where(&part, |e| e["curve"] != "line" && e["mid"][2].as_f64().is_some_and(|z| z > 10.0));
    assert_eq!(rim.len(), 1, "the ellipse of the cut");
    for (d_plane, d_wall, shape) in [(1.0, 3.0, 0.5), (2.0, 1.0, 0.4)] {
        let expected = ring_volume(d_plane, d_wall, shape, 1.0);
        let unbent = ring_volume(d_plane, d_wall, shape, 0.0);
        let result = built(&part, &[leg_row(rim[0], top, d_plane, NAN, d_wall, NAN)], 1.0, shape);
        let removed = volume_of(&part) - volume_of(&result);
        // measured 6e-7 and 3e-6 relative; the section without the bend is 1.6e-2 and 4.6e-4 off, so the bend is what this tests
        let slack = 1e-5 * expected;
        assert!((unbent - expected).abs() > 10.0 * slack, "the bend changes the volume by {}", (unbent - expected).abs());
        assert!(
            (removed - expected).abs() < slack,
            "legs {d_plane} x {d_wall} shape {shape}: removed {removed} vs the 3D integral {expected}"
        );
        let (g0, g1, count) = contacts(&result);
        assert!(count >= 2 && g0 < 1e-6 * diagonal(&result) && g1 < 1e-4, "contacts {count} G0 {g0} G1 {g1}");
        // the wall bends along the section by (t . tau)^2 / R, not 0 and not 1 / R: read between the stations (97 samples, every 4th is a station)
        let (on, off, lines) = curvature_jumps(&result, 97.0, 4);
        assert_eq!(lines, 2);
        assert!(on * R < 0.02 && off * R < 0.02, "normal-curvature jump x R: stations {} between {}", on * R, off * R);
    }
}
