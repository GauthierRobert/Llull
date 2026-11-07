//! The stored flow field of a solve (`field.bin`, 12 CFD M3a): the time-averaged velocity (m/s) and gauge pressure (Pa) per
//! cell of the solver grid (case frame), the fluid mask and the symmetry planes of a half model, so probes, slices and
//! streamlines run on the recorded result without a re-solve.
//!
//! Layout (little-endian): `LLFD`, u32 version 1, u32 nx, u32 ny, u32 nz, f64 h, f64 origin[3], u32 mirrors, per mirror u32 axis,
//! u32 high (0 / 1), f64 plane; then f32 ux[n], f32 uy[n], f32 uz[n], f32 p[n], u8 valid[n] (n = nx ny nz, x fastest).

use crate::grid::Grid;
use crate::sample::{locate, Located, Stencil};

const MAGIC: &[u8; 4] = b"LLFD";
const VERSION: u32 = 1;
/// Named guard: the largest grid a field file may declare (the solver's own CPU cap is 2e7 cells).
pub const MAX_FIELD_CELLS: usize = 400_000_000;

/// A symmetry plane of a half model: the axis it is normal to, its coordinate, and whether the kept fluid lies below it
/// (`high`: the plane is the box's max face, the dropped half is above).
pub type Mirror = (usize, f64, bool);

/// The recorded field on the solver grid.
#[derive(Debug, Clone, PartialEq)]
pub struct FlowField {
    pub grid: Grid,
    pub mirrors: Vec<Mirror>,
    pub ux: Vec<f32>,
    pub uy: Vec<f32>,
    pub uz: Vec<f32>,
    pub p: Vec<f32>,
    pub valid: Vec<bool>,
}

/// One sample of the field at a point (case frame).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    pub velocity: [f64; 3],
    pub pressure: f64,
}

/// Why a point has no sample: outside the grid (or in its boundary layer of face cells), or inside a body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Miss {
    Outside,
    Solid,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, count: usize) -> Result<&[u8], String> {
        let end = self.at.checked_add(count).filter(|end| *end <= self.bytes.len()).ok_or("field.bin is truncated")?;
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }

    fn u32(&mut self) -> Result<u32, String> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn f64(&mut self) -> Result<f64, String> {
        let b = self.take(8)?;
        Ok(f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
    }

    fn f32s(&mut self, count: usize) -> Result<Vec<f32>, String> {
        Ok(self.take(count * 4)?.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
    }
}

impl FlowField {
    /// The `field.bin` bytes.
    pub fn to_bytes(&self) -> Vec<u8> {
        let n = self.grid.cells();
        let mut bytes = Vec::with_capacity(56 + 16 * self.mirrors.len() + 17 * n);
        bytes.extend_from_slice(MAGIC);
        for value in [VERSION, self.grid.nx as u32, self.grid.ny as u32, self.grid.nz as u32] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(&self.grid.h.to_le_bytes());
        for value in self.grid.origin {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(&(self.mirrors.len() as u32).to_le_bytes());
        for (axis, plane, high) in &self.mirrors {
            bytes.extend_from_slice(&(*axis as u32).to_le_bytes());
            bytes.extend_from_slice(&u32::from(*high).to_le_bytes());
            bytes.extend_from_slice(&plane.to_le_bytes());
        }
        for values in [&self.ux, &self.uy, &self.uz, &self.p] {
            for value in values.iter() {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        bytes.extend(self.valid.iter().map(|valid| u8::from(*valid)));
        bytes
    }

    /// Parses `field.bin`; an Err names what is wrong (magic, version, sizes, a non-finite value in a fluid cell).
    pub fn from_bytes(bytes: &[u8]) -> Result<FlowField, String> {
        let mut reader = Reader { bytes, at: 0 };
        if reader.take(4)? != MAGIC {
            return Err("field.bin does not start with LLFD".into());
        }
        let version = reader.u32()?;
        if version != VERSION {
            return Err(format!("field.bin version {version} is not {VERSION}"));
        }
        let (nx, ny, nz) = (reader.u32()? as usize, reader.u32()? as usize, reader.u32()? as usize);
        let h = reader.f64()?;
        let origin = [reader.f64()?, reader.f64()?, reader.f64()?];
        if nx < 2 || ny < 2 || nz < 2 || !(h > 0.0 && h.is_finite()) || origin.iter().any(|v| !v.is_finite()) {
            return Err(format!("field.bin declares an invalid grid {nx} x {ny} x {nz}, h {h}"));
        }
        let n =
            nx.checked_mul(ny).and_then(|v| v.checked_mul(nz)).filter(|n| *n <= MAX_FIELD_CELLS).ok_or("field.bin grid is too large")?;
        let mirror_count = reader.u32()? as usize;
        if mirror_count > 3 {
            return Err(format!("field.bin declares {mirror_count} symmetry planes"));
        }
        let mut mirrors = Vec::with_capacity(mirror_count);
        for _ in 0..mirror_count {
            let (axis, high, plane) = (reader.u32()? as usize, reader.u32()?, reader.f64()?);
            if axis > 2 || high > 1 || !plane.is_finite() {
                return Err("field.bin declares an invalid symmetry plane".into());
            }
            mirrors.push((axis, plane, high == 1));
        }
        if bytes.len() - reader.at != 17 * n {
            return Err(format!("field.bin holds {} data bytes, {n} cells need {}", bytes.len() - reader.at, 17 * n));
        }
        let (ux, uy, uz, p) = (reader.f32s(n)?, reader.f32s(n)?, reader.f32s(n)?, reader.f32s(n)?);
        let valid: Vec<bool> = reader.take(n)?.iter().map(|flag| *flag != 0).collect();
        if let Some(cell) = (0..n).find(|cell| valid[*cell] && ![ux[*cell], uy[*cell], uz[*cell], p[*cell]].iter().all(|v| v.is_finite())) {
            return Err(format!("field.bin has a non-finite value in fluid cell {cell}"));
        }
        Ok(FlowField { grid: Grid { nx, ny, nz, h, origin }, mirrors, ux, uy, uz, p, valid })
    }

    /// `point` folded into the solved half of a half model, and which velocity components the fold reverses.
    pub fn fold(&self, point: [f64; 3]) -> ([f64; 3], [bool; 3]) {
        let mut folded = point;
        let mut flipped = [false; 3];
        for (axis, plane, high) in &self.mirrors {
            let beyond = if *high { folded[*axis] > *plane } else { folded[*axis] < *plane };
            if beyond {
                folded[*axis] = 2.0 * plane - folded[*axis];
                flipped[*axis] = !flipped[*axis];
            }
        }
        (folded, flipped)
    }

    /// Whether the folded point lies in the grid's boundary layer of face cells or outside it (the flow left the domain).
    fn outside(&self, point: [f64; 3]) -> bool {
        let Some((i, j, k)) = self.grid.cell_at(point) else { return true };
        let n = [self.grid.nx, self.grid.ny, self.grid.nz];
        [i, j, k].iter().zip(n).any(|(index, size)| *index == 0 || *index + 1 == size)
    }

    /// The stencil at a folded point; `None` with the reason when it has no value. A point in a solid cell is a wall hit even
    /// when fluid neighbours would interpolate (streamlines stop at the staircase surface).
    fn stencil(&self, folded: [f64; 3], strict: bool) -> Result<Stencil, Miss> {
        if strict {
            if self.outside(folded) {
                return Err(Miss::Outside);
            }
            if let Some((i, j, k)) = self.grid.cell_at(folded) {
                if !self.valid[self.grid.index(i, j, k)] {
                    return Err(Miss::Solid);
                }
            }
        }
        match locate(&self.grid, &self.valid, folded) {
            Located::Inside(stencil) => Ok(stencil),
            Located::Outside => Err(Miss::Outside),
            Located::NoValidCell => Err(Miss::Solid),
        }
    }

    /// Velocity and pressure at `point` by the trilinear rule of `sample::trilinear` (probes and slices: a point next to the
    /// surface still samples its fluid neighbours). Half models sample the mirror image with the normal velocity reversed.
    pub fn sample(&self, point: [f64; 3]) -> Result<Sample, Miss> {
        let (folded, flipped) = self.fold(point);
        let stencil = self.stencil(folded, false)?;
        Ok(self.evaluate(&stencil, flipped))
    }

    /// Velocity at `point` for streamline integration: a miss when the point left the fluid box or entered a solid cell.
    pub fn velocity_strict(&self, point: [f64; 3]) -> Result<[f64; 3], Miss> {
        let (folded, flipped) = self.fold(point);
        let stencil = self.stencil(folded, true)?;
        Ok(self.evaluate(&stencil, flipped).velocity)
    }

    fn evaluate(&self, stencil: &Stencil, flipped: [bool; 3]) -> Sample {
        let sign = |axis: usize| if flipped[axis] { -1.0 } else { 1.0 };
        Sample {
            velocity: [stencil.apply(&self.ux) * sign(0), stencil.apply(&self.uy) * sign(1), stencil.apply(&self.uz) * sign(2)],
            pressure: stencil.apply(&self.p),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(mirrors: Vec<Mirror>) -> FlowField {
        let grid = Grid::covering([0.0; 3], [1.0, 1.0, 1.0], 0.25);
        let n = grid.cells();
        let centre = |cell: usize| {
            let (i, j, k) = grid.coords(cell);
            grid.centre(i, j, k)
        };
        FlowField {
            ux: (0..n).map(|c| (1.0 + centre(c)[0]) as f32).collect(),
            uy: (0..n).map(|c| centre(c)[1] as f32).collect(),
            uz: vec![0.0; n],
            p: (0..n).map(|c| (2.0 * centre(c)[2]) as f32).collect(),
            valid: (0..n).map(|c| c != 21).collect(),
            grid,
            mirrors,
        }
    }

    #[test]
    fn bytes_round_trip_and_damage_is_named() {
        let original = field(vec![(1, 0.0, false)]);
        let bytes = original.to_bytes();
        assert_eq!(FlowField::from_bytes(&bytes).unwrap(), original);
        assert!(FlowField::from_bytes(&bytes[..bytes.len() - 1]).unwrap_err().contains("data bytes"));
        let mut wrong = bytes.clone();
        wrong[0] = b'X';
        assert!(FlowField::from_bytes(&wrong).unwrap_err().contains("LLFD"));
        let mut nan = bytes.clone();
        let first_value = 56 + 16;
        nan[first_value..first_value + 4].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(FlowField::from_bytes(&nan).unwrap_err().contains("non-finite"));
        assert!(FlowField::from_bytes(b"LLFD").unwrap_err().contains("truncated"));
    }

    #[test]
    fn a_half_model_samples_the_mirror_image_with_the_normal_velocity_reversed() {
        let half = field(vec![(1, 0.0, false)]);
        let inside = half.sample([0.4, 0.3, 0.5]).unwrap();
        let mirrored = half.sample([0.4, -0.3, 0.5]).unwrap();
        assert_eq!(mirrored.velocity[0], inside.velocity[0]);
        assert_eq!(mirrored.velocity[1], -inside.velocity[1]);
        assert_eq!(mirrored.pressure, inside.pressure);
        let whole = field(vec![]);
        assert_eq!(whole.sample([0.4, -0.3, 0.5]), Err(Miss::Outside));
    }

    #[test]
    fn strict_velocity_stops_at_solid_cells_and_the_face_layer() {
        let f = field(vec![]);
        let (i, j, k) = f.grid.coords(21);
        let centre = f.grid.centre(i, j, k);
        let solid = [centre[0] + 0.1, centre[1] + 0.1, centre[2] - 0.1];
        assert_eq!(f.velocity_strict(solid), Err(Miss::Solid));
        assert!(f.sample(solid).is_ok(), "probes interpolate the fluid neighbours of a solid cell");
        assert_eq!(f.velocity_strict([0.1, 0.5, 0.5]), Err(Miss::Outside));
        assert!(f.velocity_strict([0.6, 0.6, 0.4]).is_ok());
    }
}
