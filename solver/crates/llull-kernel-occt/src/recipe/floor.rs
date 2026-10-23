//! Floor-edge selection of a pocket floor fillet (07 FTR §5.5), mirroring `featureFillet.ts` `floorEdgeIndices`: the unique edges of the
//! cut result that lie on the floor plane and on a pocket outline / island curve, matched by geometry because the boolean may split the
//! tool's edges. The host sends the frame, the floor depth and the outline curves in frame-local coordinates (lines and circular arcs).

use serde_json::Value;
use std::f64::consts::TAU;

type P2 = [f64; 2];
type P3 = [f64; 3];

enum Curve {
    Line(P2, P2),
    Arc { center: P2, radius: f64, start_angle: f64, direction: f64, sweep: f64, ends: [P2; 2] },
}

fn p2(value: &Value) -> Option<P2> {
    let items = value.as_array()?;
    Some([items.first()?.as_f64()?, items.get(1)?.as_f64()?])
}

fn p3(value: Option<&Value>) -> Option<P3> {
    let items = value?.as_array()?;
    Some([items.first()?.as_f64()?, items.get(1)?.as_f64()?, items.get(2)?.as_f64()?])
}

fn positive_sweep(angle: f64) -> f64 {
    let mut result = angle;
    while result <= 0.0 {
        result += TAU;
    }
    result
}

/// `arcGeometry`: the circle through three points; `None` for collinear points (core skips such a segment too).
fn arc(start: P2, through: P2, end: P2) -> Option<Curve> {
    let (e1, e2) = ([through[0] - start[0], through[1] - start[1]], [end[0] - start[0], end[1] - start[1]]);
    let cross = e1[0] * e2[1] - e1[1] * e2[0];
    let (d1, d2) = (e1[0] * e1[0] + e1[1] * e1[1], e2[0] * e2[0] + e2[1] * e2[1]);
    if cross * cross < 1e-18 * f64::max(1.0, d1 * d2) {
        return None;
    }
    let ox = (e2[1] * d1 - e1[1] * d2) / (2.0 * cross);
    let oy = (e1[0] * d2 - e2[0] * d1) / (2.0 * cross);
    let center = [start[0] + ox, start[1] + oy];
    let direction = cross.signum();
    let start_angle = (start[1] - center[1]).atan2(start[0] - center[0]);
    let end_angle = (end[1] - center[1]).atan2(end[0] - center[0]);
    let sweep = positive_sweep(direction * (end_angle - start_angle));
    Some(Curve::Arc { center, radius: ox.hypot(oy), start_angle, direction, sweep, ends: [start, end] })
}

/// Lines and circular arcs only: pocket outlines are polygons with rounded corners, so `bezier` and `ellipse` pieces (other callers' chains) are skipped.
fn curves(outlines: &Value) -> Vec<Curve> {
    let mut result = Vec::new();
    for segment in outlines.as_array().into_iter().flatten().flat_map(|outline| outline.as_array().into_iter().flatten()) {
        let points: Vec<P2> = segment.get("points").and_then(Value::as_array).into_iter().flatten().filter_map(p2).collect();
        match (segment.get("type").and_then(Value::as_str), points.as_slice()) {
            (Some("line"), [a, b]) => result.push(Curve::Line(*a, *b)),
            (Some("arc"), [a, b, c]) => result.extend(arc(*a, *b, *c)),
            _ => {}
        }
    }
    result
}

fn distance(curve: &Curve, p: P2) -> f64 {
    match curve {
        Curve::Line(a, b) => {
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let length_squared = dx * dx + dy * dy;
            let raw = if length_squared == 0.0 { 0.0 } else { ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length_squared };
            let t = raw.clamp(0.0, 1.0);
            (p[0] - (a[0] + t * dx)).hypot(p[1] - (a[1] + t * dy))
        }
        Curve::Arc { center, radius, start_angle, direction, sweep, ends } => {
            let relative = [p[0] - center[0], p[1] - center[1]];
            let angle = positive_sweep(direction * (relative[1].atan2(relative[0]) - start_angle));
            if angle <= *sweep {
                (relative[0].hypot(relative[1]) - radius).abs()
            } else {
                ends.iter().map(|end| (end[0] - p[0]).hypot(end[1] - p[1])).fold(f64::INFINITY, f64::min)
            }
        }
    }
}

/// Indices of the `topology` edges on the floor plane and on an outline; `None` when the spec is malformed.
pub(super) fn floor_edge_indices(topology: &Value, spec: &Value) -> Option<Vec<u32>> {
    let floor_depth = spec.get("floorDepth")?.as_f64()?;
    let (origin, normal, x_dir) = (p3(spec.get("origin"))?, p3(spec.get("normal"))?, p3(spec.get("xDir"))?);
    let y_dir = [
        normal[1] * x_dir[2] - normal[2] * x_dir[1],
        normal[2] * x_dir[0] - normal[0] * x_dir[2],
        normal[0] * x_dir[1] - normal[1] * x_dir[0],
    ];
    let dot = |a: P3, b: P3| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let rel = |p: P3| [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    let tolerance = 1e-5 * (1.0 + floor_depth);
    let outlines = curves(spec.get("outlines")?);
    let mut picked = Vec::new();
    for edge in topology.get("edges")?.as_array()? {
        let flag = |name: &str| edge.get(name).and_then(Value::as_bool).unwrap_or(false);
        if flag("seam") || flag("degenerate") {
            continue;
        }
        let points = [p3(edge.get("start"))?, p3(edge.get("mid"))?, p3(edge.get("end"))?];
        let on_floor = points.iter().all(|point| (dot(rel(*point), normal) + floor_depth).abs() < tolerance);
        let on_outline = |point: &P3| {
            let local = [dot(rel(*point), x_dir), dot(rel(*point), y_dir)];
            outlines.iter().any(|curve| distance(curve, local) < tolerance)
        };
        if on_floor && points.iter().all(on_outline) {
            picked.push(u32::try_from(edge.get("index")?.as_u64()?).ok()?);
        }
    }
    Some(picked)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec() -> Value {
        let square = json!([
            { "type": "line", "points": [[-1, -1], [1, -1]] }, { "type": "line", "points": [[1, -1], [1, 1]] },
            { "type": "line", "points": [[1, 1], [-1, 1]] }, { "type": "line", "points": [[-1, 1], [-1, -1]] },
        ]);
        json!({ "floorDepth": 1.0, "origin": [0, 0, 2], "normal": [0, 0, 1], "xDir": [1, 0, 0], "outlines": [square], "radius": 0.2 })
    }

    fn edge(index: u32, start: P3, end: P3) -> Value {
        let mid = [(start[0] + end[0]) / 2.0, (start[1] + end[1]) / 2.0, (start[2] + end[2]) / 2.0];
        json!({ "index": index, "start": start, "mid": mid, "end": end, "seam": false, "degenerate": false })
    }

    #[test]
    fn floor_edges_lie_on_the_floor_plane_and_the_outline() {
        let topology = json!({ "edges": [
            edge(0, [-1.0, -1.0, 1.0], [1.0, -1.0, 1.0]),
            edge(1, [-1.0, -1.0, 2.0], [1.0, -1.0, 2.0]),
            edge(2, [-1.0, -1.0, 1.0], [-1.0, -1.0, 2.0]),
            edge(3, [-0.5, -0.5, 1.0], [0.5, 0.5, 1.0]),
            { "index": 4, "start": [-1.0, -1.0, 1.0], "mid": [0.0, -1.0, 1.0], "end": [1.0, -1.0, 1.0], "seam": true, "degenerate": false },
        ] });
        assert_eq!(floor_edge_indices(&topology, &spec()), Some(vec![0]));
        assert_eq!(floor_edge_indices(&topology, &json!({})), None);
    }

    #[test]
    fn arc_outlines_match_inside_their_sweep_only() {
        let h = std::f64::consts::FRAC_1_SQRT_2;
        let counter = curves(&json!([[{ "type": "arc", "points": [[1, 0], [h, h], [0, 1]] }]]));
        assert!(distance(&counter[0], [0.0, 1.0]) < 1e-9);
        assert!(distance(&counter[0], [h, h]) < 1e-9);
        assert!(distance(&counter[0], [0.0, -1.0]) > 1.0, "outside the sweep it measures to the ends");
        let clockwise = curves(&json!([[{ "type": "arc", "points": [[0, 1], [h, h], [1, 0]] }]]));
        assert!(distance(&clockwise[0], [h, h]) < 1e-9);
        assert!(distance(&clockwise[0], [-h, -h]) > 1.0);
        assert!(curves(&json!([[{ "type": "arc", "points": [[0, 0], [1, 0], [2, 0]] }, { "type": "bezier", "points": [] }]])).is_empty());
    }
}
