//! Binary STL (80-byte header, u32 count, 50 bytes per facet: normal, 3 vertices as f32, u16 attribute). The flow surface the
//! host exports is in metres; the facet normal is ignored (recomputed from the winding), the attribute is ignored.

/// One triangle, counter-clockwise seen from outside, m.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Triangle {
    pub v: [[f64; 3]; 3],
}

impl Triangle {
    /// Unnormalised outward normal (twice the area vector).
    pub fn area_vector(&self) -> [f64; 3] {
        let [a, b, c] = self.v;
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
    }

    pub fn centroid(&self) -> [f64; 3] {
        let [a, b, c] = self.v;
        [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0]
    }

    /// Unit outward normal, or `[0, 0, 0]` for a degenerate triangle.
    pub fn unit_normal(&self) -> [f64; 3] {
        let n = self.area_vector();
        let length = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if length > 0.0 {
            [n[0] / length, n[1] / length, n[2] / length]
        } else {
            [0.0; 3]
        }
    }

    pub fn area(&self) -> f64 {
        let n = self.area_vector();
        0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt()
    }
}

const HEADER: usize = 80;
const FACET: usize = 50;

fn f32_at(bytes: &[u8], at: usize) -> f64 {
    f64::from(f32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]))
}

/// Parses a binary STL; the facet count must match the length.
/// @failure shorter than a header, or a length that is not `84 + 50 n` -> an explanation
pub fn read_binary_stl(bytes: &[u8]) -> Result<Vec<Triangle>, String> {
    if bytes.len() < HEADER + 4 {
        return Err(format!("binary STL needs at least 84 bytes, got {}", bytes.len()));
    }
    let count = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
    if bytes.len() != HEADER + 4 + count * FACET {
        return Err(format!("binary STL announces {count} facets, which needs {} bytes, got {}", HEADER + 4 + count * FACET, bytes.len()));
    }
    Ok((0..count)
        .map(|t| {
            let base = HEADER + 4 + t * FACET + 12;
            let vertex = |k: usize| [f32_at(bytes, base + 12 * k), f32_at(bytes, base + 12 * k + 4), f32_at(bytes, base + 12 * k + 8)];
            Triangle { v: [vertex(0), vertex(1), vertex(2)] }
        })
        .collect())
}

/// Writes a binary STL (normals recomputed, attribute 0).
pub fn write_binary_stl(triangles: &[Triangle], header: &str) -> Vec<u8> {
    let mut bytes = vec![0u8; HEADER];
    for (slot, byte) in bytes.iter_mut().zip(header.bytes()) {
        *slot = byte;
    }
    bytes.extend_from_slice(&(triangles.len() as u32).to_le_bytes());
    for triangle in triangles {
        for value in triangle.unit_normal().iter().chain(triangle.v.iter().flatten()) {
            bytes.extend_from_slice(&(*value as f32).to_le_bytes());
        }
        bytes.extend_from_slice(&[0, 0]);
    }
    bytes
}

/// Axis-aligned bounds of the triangles (None when there is none).
pub fn bounds(triangles: &[Triangle]) -> Option<([f64; 3], [f64; 3])> {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for vertex in triangles.iter().flat_map(|t| t.v.iter()) {
        for axis in 0..3 {
            min[axis] = min[axis].min(vertex[axis]);
            max[axis] = max[axis].max(vertex[axis]);
        }
    }
    (!triangles.is_empty()).then_some((min, max))
}

/// Twelve triangles of the box `[min, max]`, outward winding.
pub fn box_triangles(min: [f64; 3], max: [f64; 3]) -> Vec<Triangle> {
    let p = |x: bool, y: bool, z: bool| [if x { max[0] } else { min[0] }, if y { max[1] } else { min[1] }, if z { max[2] } else { min[2] }];
    let quad = |a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]| [Triangle { v: [a, b, c] }, Triangle { v: [a, c, d] }];
    let (f, t) = (false, true);
    [
        quad(p(f, f, f), p(f, t, f), p(t, t, f), p(t, f, f)),
        quad(p(f, f, t), p(t, f, t), p(t, t, t), p(f, t, t)),
        quad(p(f, f, f), p(t, f, f), p(t, f, t), p(f, f, t)),
        quad(p(f, t, f), p(f, t, t), p(t, t, t), p(t, t, f)),
        quad(p(f, f, f), p(f, f, t), p(f, t, t), p(f, t, f)),
        quad(p(t, f, f), p(t, t, f), p(t, t, t), p(t, f, t)),
    ]
    .concat()
}

/// A UV sphere of `rings × segments` quads (two triangles each), outward winding.
pub fn sphere_triangles(centre: [f64; 3], radius: f64, rings: usize, segments: usize) -> Vec<Triangle> {
    let point = |ring: usize, segment: usize| {
        let theta = std::f64::consts::PI * ring as f64 / rings as f64;
        let phi = 2.0 * std::f64::consts::PI * segment as f64 / segments as f64;
        [centre[0] + radius * theta.sin() * phi.cos(), centre[1] + radius * theta.sin() * phi.sin(), centre[2] + radius * theta.cos()]
    };
    let mut triangles = Vec::with_capacity(2 * rings * segments);
    for ring in 0..rings {
        for segment in 0..segments {
            let (a, b) = (point(ring, segment), point(ring, segment + 1));
            let (c, d) = (point(ring + 1, segment + 1), point(ring + 1, segment));
            if ring > 0 {
                triangles.push(Triangle { v: [a, d, c] });
            }
            if ring + 1 < rings {
                triangles.push(Triangle { v: [a, c, b] });
            }
        }
    }
    triangles
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_rejects_bad_lengths() {
        let triangles = box_triangles([0.0; 3], [1.0, 2.0, 3.0]);
        let bytes = write_binary_stl(&triangles, "llull");
        assert_eq!(bytes.len(), 84 + 12 * 50);
        let back = read_binary_stl(&bytes).unwrap();
        assert_eq!(back, triangles);
        assert!(read_binary_stl(&bytes[..100]).unwrap_err().contains("announces 12 facets"));
        assert!(read_binary_stl(&bytes[..10]).unwrap_err().contains("at least 84"));
        assert_eq!(bounds(&triangles), Some(([0.0; 3], [1.0, 2.0, 3.0])));
    }

    #[test]
    fn box_is_closed_and_outward() {
        let triangles = box_triangles([0.0; 3], [1.0; 3]);
        let area: f64 = triangles.iter().map(Triangle::area).sum();
        assert!((area - 6.0).abs() < 1e-12);
        // Signed volume Σ (c · n) / 3 of an outward surface is positive.
        let volume: f64 = triangles
            .iter()
            .map(|t| {
                let n = t.area_vector();
                let c = t.centroid();
                (c[0] * n[0] + c[1] * n[1] + c[2] * n[2]) / 6.0
            })
            .sum();
        assert!((volume - 1.0).abs() < 1e-12, "{volume}");
    }

    #[test]
    fn sphere_volume_approaches_the_exact_value_from_below() {
        let triangles = sphere_triangles([0.0; 3], 1.0, 32, 64);
        let volume: f64 = triangles
            .iter()
            .map(|t| {
                let n = t.area_vector();
                let c = t.centroid();
                (c[0] * n[0] + c[1] * n[1] + c[2] * n[2]) / 6.0
            })
            .sum();
        let exact = 4.0 / 3.0 * std::f64::consts::PI;
        assert!(volume < exact && volume > 0.99 * exact, "{volume}");
    }
}
