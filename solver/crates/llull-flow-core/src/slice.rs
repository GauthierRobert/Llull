//! Plane slices of a cell field (TECHNICAL_SPEC §5.5): a square patch of the plane centred on its origin, sampled on a regular
//! `nu × nv` lattice, written as `LLSL` (u32 version 1, u32 nu, u32 nv, f32 origin[3], f32 axisU[3], f32 axisV[3], f32 spacing,
//! 16-byte field name, f32 × nu × nv row-major in v then u; NaN where the sample has no value).

/// Largest slice resolution per axis.
pub const MAX_SLICE_SAMPLES: usize = 512;

/// The sampled patch: sample `(iu, iv)` sits at `origin + iu spacing axis_u + iv spacing axis_v`.
#[derive(Debug, Clone, PartialEq)]
pub struct Plane {
    pub origin: [f64; 3],
    pub axis_u: [f64; 3],
    pub axis_v: [f64; 3],
    pub spacing: f64,
    pub samples: usize,
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn unit(v: [f64; 3]) -> Option<[f64; 3]> {
    let length = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    (length > 1e-12).then(|| [v[0] / length, v[1] / length, v[2] / length])
}

/// The square patch of side `extent` (m) through `centre` normal to `normal`, about one sample per `spacing` (m), capped at
/// [`MAX_SLICE_SAMPLES`] per axis (the spacing then grows). `axis_u` is `normal × (x or y)`, `axis_v = normal × axis_u`.
/// @failure a zero normal, or a non-positive spacing / extent -> Err
pub fn square_plane(centre: [f64; 3], normal: [f64; 3], spacing: f64, extent: f64) -> Result<Plane, String> {
    let normal = unit(normal).ok_or("a slice normal must be non-zero")?;
    if !(spacing > 0.0 && spacing.is_finite() && extent > 0.0 && extent.is_finite()) {
        return Err(format!("a slice needs a positive spacing and extent (got {spacing}, {extent})"));
    }
    let helper = if normal[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let axis_u = unit(cross(normal, helper)).unwrap_or([0.0, 1.0, 0.0]);
    let axis_v = cross(normal, axis_u);
    let samples = ((extent / spacing).ceil() as usize + 1).min(MAX_SLICE_SAMPLES);
    let spacing = extent / (samples.max(2) - 1) as f64;
    let half = extent / 2.0;
    let origin = [
        centre[0] - half * (axis_u[0] + axis_v[0]),
        centre[1] - half * (axis_u[1] + axis_v[1]),
        centre[2] - half * (axis_u[2] + axis_v[2]),
    ];
    Ok(Plane { origin, axis_u, axis_v, spacing, samples })
}

impl Plane {
    pub fn point(&self, iu: usize, iv: usize) -> [f64; 3] {
        let (su, sv) = (iu as f64 * self.spacing, iv as f64 * self.spacing);
        [
            self.origin[0] + su * self.axis_u[0] + sv * self.axis_v[0],
            self.origin[1] + su * self.axis_u[1] + sv * self.axis_v[1],
            self.origin[2] + su * self.axis_u[2] + sv * self.axis_v[2],
        ]
    }

    /// `value(point)` at every sample, row-major in v then u (NaN where it has none).
    pub fn sample(&self, value: impl Fn([f64; 3]) -> Option<f64>) -> Vec<f32> {
        let mut values = Vec::with_capacity(self.samples * self.samples);
        for iv in 0..self.samples {
            for iu in 0..self.samples {
                values.push(value(self.point(iu, iv)).map_or(f32::NAN, |v| v as f32));
            }
        }
        values
    }

    /// The `LLSL` file of `values` (from [`Plane::sample`]) named `name` (at most 16 bytes kept).
    pub fn encode(&self, name: &str, values: &[f32]) -> Vec<u8> {
        let mut bytes = b"LLSL".to_vec();
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&(self.samples as u32).to_le_bytes());
        bytes.extend_from_slice(&(self.samples as u32).to_le_bytes());
        for value in self.origin.iter().chain(self.axis_u.iter()).chain(self.axis_v.iter()) {
            bytes.extend_from_slice(&(*value as f32).to_le_bytes());
        }
        bytes.extend_from_slice(&(self.spacing as f32).to_le_bytes());
        let mut field = [0u8; 16];
        for (slot, byte) in field.iter_mut().zip(name.bytes()) {
            *slot = byte;
        }
        bytes.extend_from_slice(&field);
        for value in values {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_patch_is_centred_orthonormal_and_capped() {
        let plane = square_plane([1.0, 2.0, 3.0], [0.0, 0.0, 2.0], 0.5, 4.0).unwrap();
        assert_eq!(plane.samples, 9);
        assert_eq!(plane.spacing, 0.5);
        let centre = plane.point(4, 4);
        assert!((0..3).all(|axis| (centre[axis] - [1.0, 2.0, 3.0][axis]).abs() < 1e-12), "{centre:?}");
        let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        assert!(dot(plane.axis_u, plane.axis_v).abs() < 1e-12 && dot(plane.axis_u, [0.0, 0.0, 1.0]).abs() < 1e-12);
        let capped = square_plane([0.0; 3], [1.0, 0.0, 0.0], 1e-3, 10.0).unwrap();
        assert_eq!(capped.samples, MAX_SLICE_SAMPLES);
        assert!(square_plane([0.0; 3], [0.0; 3], 1.0, 1.0).is_err());
        assert!(square_plane([0.0; 3], [1.0, 0.0, 0.0], 0.0, 1.0).is_err());
    }

    #[test]
    fn encoding_has_the_header_then_one_float_per_sample() {
        let plane = square_plane([0.0; 3], [0.0, 1.0, 0.0], 1.0, 1.0).unwrap();
        let values = plane.sample(|p| (p[0] > 0.0).then_some(1.0));
        assert_eq!(values.len(), 4);
        let bytes = plane.encode("speed", &values);
        assert_eq!(&bytes[..4], b"LLSL");
        assert_eq!(bytes.len(), 4 + 12 + 40 + 16 + 16);
        assert_eq!(&bytes[56..61], b"speed");
    }
}
