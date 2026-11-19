//! Divergence-theorem volume and area of the mesh a `mesh` job returns: the twin of `meshMeasures` (`packages/core/src/lib/isosurface/measures.ts`).
//! Same expressions, same triangle order, one running sum per figure and V8's `Math.hypot`, so the two numbers are bit-identical to what the
//! TypeScript side computes from the returned mesh (it then skips its own pass over the triangles).

/// Signed volume and total area of the indexed triangles, summed in index order. An index past the vertices reads NaN, as the TypeScript twin does.
pub fn mesh_measures(positions: &[f64], indices: &[u32]) -> (f64, f64) {
    let at = |vertex: u32, axis: usize| positions.get(3 * vertex as usize + axis).copied().unwrap_or(f64::NAN);
    let mut volume = 0.0;
    let mut area = 0.0;
    for triangle in indices.chunks_exact(3) {
        let (a, b, c) = (triangle[0], triangle[1], triangle[2]);
        let (ax, ay, az) = (at(a, 0), at(a, 1), at(a, 2));
        let (bx, by, bz) = (at(b, 0), at(b, 1), at(b, 2));
        let (cx, cy, cz) = (at(c, 0), at(c, 1), at(c, 2));
        volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6.0;
        let (ux, uy, uz, vx, vy, vz) = (bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az);
        area += llull_jsmath::hypot(&[uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]) / 2.0;
    }
    (volume, area)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cube [0, s]^3, outward oriented, 12 triangles.
    fn cube(s: f64) -> (Vec<f64>, Vec<u32>) {
        let positions = vec![0.0, 0.0, 0.0, s, 0.0, 0.0, s, s, 0.0, 0.0, s, 0.0, 0.0, 0.0, s, s, 0.0, s, s, s, s, 0.0, s, s];
        let indices = vec![0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
        (positions, indices)
    }

    #[test]
    fn a_cube_has_its_volume_and_area() {
        let (positions, indices) = cube(6.0);
        assert_eq!(mesh_measures(&positions, &indices), (216.0, 216.0));
    }

    #[test]
    fn an_inward_cube_has_the_opposite_volume_and_the_same_area() {
        let (positions, mut indices) = cube(6.0);
        indices.chunks_exact_mut(3).for_each(|t| t.swap(1, 2));
        assert_eq!(mesh_measures(&positions, &indices), (-216.0, 216.0));
    }

    /// Figures of `meshMeasures` in Node 22 (V8 12.4) for this mesh, by bit pattern: irrational coordinates, so every rounding of the running sums
    /// and of `Math.hypot` counts (`tests/unit/implicit/meshFacts.test.ts` pins the same pair on the TypeScript side).
    #[test]
    fn the_running_sums_match_v8_bit_for_bit() {
        let positions: Vec<f64> =
            (0..24).map(|i| f64::from(i) * 0.37 + (f64::from(i) * 0.61).fract() * 3.1 + 1.0 / (f64::from(i) + 3.0)).collect();
        let (_, indices) = cube(1.0);
        let (volume, area) = mesh_measures(&positions, &indices);
        assert_eq!((volume.to_bits(), area.to_bits()), (V8_VOLUME_BITS, V8_AREA_BITS), "volume {volume:e} area {area:e}");
    }

    const V8_VOLUME_BITS: u64 = 0xc033_9b85_9a5e_ab7e;
    const V8_AREA_BITS: u64 = 0x4051_de15_bdb3_3baa;

    #[test]
    fn an_empty_mesh_measures_zero_and_a_dangling_index_is_not_a_number() {
        assert_eq!(mesh_measures(&[], &[]), (0.0, 0.0));
        let (volume, area) = mesh_measures(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0], &[0, 1, 2]);
        assert!(volume.is_nan() && area.is_nan());
    }
}
