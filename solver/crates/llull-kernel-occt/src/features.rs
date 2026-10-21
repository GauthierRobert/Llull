//! Feature operations over the cxx facade (`cpp/features.{hxx,cxx}`): fillet, chamfer, blend, shell, exact curve faces, loft,
//! sweep, B-spline subdivision patches and the BRepFeat hole / pocket cuts. A second bridge that reuses the facade's opaque
//! `Shape`, so these builders live apart from the primitive makers of `lib.rs`.

use crate::{built, inner, occt, Built, OcctResult, Shape};

// Generated FFI glue (unsafe by construction), like the bridge in lib.rs; no hand-written unsafe block.
#[allow(unsafe_code)]
#[cxx::bridge(namespace = "llull")]
mod ffi {
    unsafe extern "C++" {
        include!("llull-kernel-occt/cpp/features.hxx");

        type Shape = crate::ffi::Shape;
        type ShapeList;

        fn new_shape_list() -> UniquePtr<ShapeList>;
        fn shape_list_add(list: Pin<&mut ShapeList>, shape: &Shape);

        fn fillet_edges(shape: &Shape, edges: &[u32], radius: f64, radius_end: f64) -> Result<UniquePtr<Shape>>;
        fn fillet_laws(shape: &Shape, edges: &[u32], laws: &[f64]) -> Result<UniquePtr<Shape>>;
        fn chamfer_edges(shape: &Shape, edges: &[u32], distance: f64) -> Result<UniquePtr<Shape>>;
        fn blend_union(list: &ShapeList, radius: f64) -> Result<UniquePtr<Shape>>;
        fn shell_hollow(shape: &Shape, thickness: f64) -> Result<UniquePtr<Shape>>;
        fn shell_open(shape: &Shape, thickness: f64, open_near: &[f64]) -> Result<UniquePtr<Shape>>;

        fn chain_face(chain: &[f64]) -> Result<UniquePtr<Shape>>;
        fn chain_wire_ok(chain: &[f64]) -> Result<bool>;
        fn circle_section(center: &[f64], normal: &[f64], radius: f64, inner_radius: f64) -> Result<UniquePtr<Shape>>;
        fn prism_of_face(face: &Shape, direction: &[f64]) -> Result<UniquePtr<Shape>>;
        fn revolution_of_face(face: &Shape, axis: &[f64], angle: f64) -> Result<UniquePtr<Shape>>;
        fn skinned_solid(chains: &[f64], lengths: &[u32], ruled: bool) -> Result<UniquePtr<Shape>>;
        fn skinned_solid_bsplines(curves: &[f64], lengths: &[u32], ruled: bool) -> Result<UniquePtr<Shape>>;
        fn pipe_solid(spine: &[f64], section: &Shape) -> Result<UniquePtr<Shape>>;
        fn bspline_patch_solid(poles: &[f64], tolerance: f64) -> Result<UniquePtr<Shape>>;

        fn surface_face(kind: i32, surface: &[f64], loops: &[f64]) -> Result<UniquePtr<Shape>>;
        fn face_slab(
            kind: i32,
            surface: &[f64],
            loops: &[f64],
            from: f64,
            to: f64,
            direction: &[f64],
            tolerance: f64,
        ) -> Result<UniquePtr<Shape>>;

        fn feature_revol_cut(source: &Shape, profile: &[f64], origin: &[f64], normal: &[f64], tag: &str) -> Result<UniquePtr<Shape>>;
        fn feature_prism_cut(
            source: &Shape,
            chain: &[f64],
            origin: &[f64],
            normal: &[f64],
            probes: &[f64],
            length: f64,
            tag: &str,
        ) -> Result<UniquePtr<Shape>>;
        fn draft_faces(shape: &Shape, faces: &[u32], angle: f64, pull: &[f64], origin: &[f64], normal: &[f64]) -> Result<UniquePtr<Shape>>;
        fn push_pull(shape: &Shape, face: u32, distance: f64) -> Result<UniquePtr<Shape>>;
        fn split_faces(shape: &Shape, faces: &[u32], origin: &[f64], normal: &[f64]) -> Result<UniquePtr<Shape>>;
        fn is_valid_shape(shape: &Shape) -> Result<bool>;
        fn unified_shape(shape: &Shape) -> Result<UniquePtr<Shape>>;
    }
}

/// Fillet of the unique edges `edges` (explorer order, `[]` = all); `radius_end` varies the radius linearly along each edge.
/// One radius law per edge (`radii`): `laws` per edge: size, sizeEnd (NaN = constant), n, then n (t, size) pairs.
pub fn fillet_laws(shape: &Shape, edges: &[u32], laws: &[f64]) -> Built {
    built(ffi::fillet_laws(inner(shape)?, edges, laws))
}

pub fn fillet(shape: &Shape, edges: &[u32], radius: f64, radius_end: Option<f64>) -> Built {
    built(ffi::fillet_edges(inner(shape)?, edges, radius, radius_end.unwrap_or(f64::NAN)))
}

/// Symmetric chamfer of the unique edges `edges` (`[]` = all).
pub fn chamfer(shape: &Shape, edges: &[u32], distance: f64) -> Built {
    built(ffi::chamfer_edges(inner(shape)?, edges, distance))
}

/// One fuse of `shapes` whose joint (section) edges are filleted by `radius`.
pub fn blend(shapes: &[&Shape], radius: f64) -> Built {
    let mut list = ffi::new_shape_list();
    for shape in shapes {
        let Some(pinned) = list.as_mut() else { return Err("shape list not created".to_string()) };
        ffi::shape_list_add(pinned, inner(shape)?);
    }
    let Some(list) = list.as_ref() else { return Err("shape list not created".to_string()) };
    built(ffi::blend_union(list, radius))
}

/// Sealed hollow: the solid minus its inward offset.
pub fn shell_hollow(shape: &Shape, thickness: f64) -> Built {
    built(ffi::shell_hollow(inner(shape)?, thickness))
}

/// Open shell: walls grown inward, the faces nearest to each `open_near` point (xyz triples) removed.
pub fn shell_open(shape: &Shape, thickness: f64, open_near: &[f64]) -> Built {
    built(ffi::shell_open(inner(shape)?, thickness, open_near))
}

/// Planar face bounded by an encoded closed chain (per segment: type code 0 line / 1 arc / 2 Bezier, then its xyz points).
pub fn chain_face(chain: &[f64]) -> Built {
    built(ffi::chain_face(chain))
}

/// Whether the encoded chain makes a wire.
pub fn chain_wire_ok(chain: &[f64]) -> OcctResult<bool> {
    occt(ffi::chain_wire_ok(chain))
}

/// Circular section face (an annulus when `inner_radius` is set) in the plane normal to `normal`.
pub fn circle_section(center: [f64; 3], normal: [f64; 3], radius: f64, inner_radius: Option<f64>) -> Built {
    built(ffi::circle_section(&center, &normal, radius, inner_radius.unwrap_or(f64::NAN)))
}

pub fn prism_of_face(face: &Shape, direction: [f64; 3]) -> Built {
    built(ffi::prism_of_face(inner(face)?, &direction))
}

pub fn revolution_of_face(face: &Shape, axis: [f64; 3], angle: f64) -> Built {
    built(ffi::revolution_of_face(inner(face)?, &axis, angle))
}

/// BRepOffsetAPI_ThruSections solid through encoded closed chains.
pub fn skinned_solid(chains: &[Vec<f64>], ruled: bool) -> Built {
    let lengths: Option<Vec<u32>> = chains.iter().map(|chain| u32::try_from(chain.len()).ok()).collect();
    let Some(lengths) = lengths else { return Err("loft: chain too long".to_string()) };
    built(ffi::skinned_solid(&chains.concat(), &lengths, ruled))
}

/// BRepOffsetAPI_ThruSections solid through B-spline sections (`bsplineSections`): one Geom_BSplineCurve per encoded section (degree, counts,
/// flags, poles, weights, knots, multiplicities; see server/src/native/kernelLeaves.ts `encodeBspline`) plus its optional closing line.
pub fn skinned_solid_bsplines(curves: &[Vec<f64>], ruled: bool) -> Built {
    let lengths: Option<Vec<u32>> = curves.iter().map(|curve| u32::try_from(curve.len()).ok()).collect();
    let Some(lengths) = lengths else { return Err("loft: section too long".to_string()) };
    built(ffi::skinned_solid_bsplines(&curves.concat(), &lengths, ruled))
}

/// BRepOffsetAPI_MakePipe of `section` along the encoded spine (corrected Frenet trihedron).
pub fn pipe_solid(spine: &[f64], section: &Shape) -> Built {
    built(ffi::pipe_solid(spine, inner(section)?))
}

/// Sewn solid of bicubic B-spline patches (16 xyz poles each); `None` when any patch or the sewing fails.
pub fn bspline_patch_solid(poles: &[f64], tolerance: f64) -> Built {
    built(ffi::bspline_patch_solid(poles, tolerance))
}

/// Exact face of a surface description (B-spline, plane, cylinder, cone: see `cpp/features.hxx`) trimmed by (u, v) loops; `None` when OCC refuses.
pub fn surface_face(kind: i32, surface: &[f64], loops: &[f64]) -> Built {
    built(ffi::surface_face(kind, surface, loops))
}

/// Solid between the offsets `range` of such a face along `direction` (sewn base, offset face and ruled walls); `None` when OCC refuses.
pub fn face_slab(kind: i32, surface: &[f64], loops: &[f64], range: [f64; 2], direction: [f64; 3], tolerance: f64) -> Built {
    built(ffi::face_slab(kind, surface, loops, range[0], range[1], &direction, tolerance))
}

/// `tag` names the faces the cut generates (SC-N1, `hole<n>.<k>`).
pub fn feature_revol_cut(source: &Shape, profile: &[f64], origin: [f64; 3], normal: [f64; 3], tag: &str) -> Built {
    built(ffi::feature_revol_cut(inner(source)?, profile, &origin, &normal, tag))
}

/// `tag` names the faces the cut generates (SC-N1, `pocket<n>`).
pub fn feature_prism_cut(
    source: &Shape,
    chain: &[f64],
    origin: [f64; 3],
    normal: [f64; 3],
    probes: &[f64],
    length: f64,
    tag: &str,
) -> Built {
    built(ffi::feature_prism_cut(inner(source)?, chain, &origin, &normal, probes, length, tag))
}

/// Draft `faces` by `angle` radians along `pull` about the neutral plane (`origin`, `normal`).
pub fn draft(shape: &Shape, faces: &[u32], angle: f64, pull: [f64; 3], origin: [f64; 3], normal: [f64; 3]) -> Built {
    built(ffi::draft_faces(inner(shape)?, faces, angle, &pull, &origin, &normal))
}

/// Move planar `face` along its outward normal by `distance` (> 0 adds material).
pub fn push_pull(shape: &Shape, face: u32, distance: f64) -> Built {
    built(ffi::push_pull(inner(shape)?, face, distance))
}

/// Split `faces` along the plane (`origin`, `normal`); the body stays one solid.
pub fn split_faces(shape: &Shape, faces: &[u32], origin: [f64; 3], normal: [f64; 3]) -> Built {
    built(ffi::split_faces(inner(shape)?, faces, &origin, &normal))
}

pub fn is_valid(shape: &Shape) -> OcctResult<bool> {
    occt(ffi::is_valid_shape(inner(shape)?))
}

/// ShapeUpgrade_UnifySameDomain of a cut result (the shape itself when OCC fails).
pub fn unified(shape: &Shape) -> Built {
    built(ffi::unified_shape(inner(shape)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn volume(shape: &Shape) -> f64 {
        crate::mass_properties(shape).unwrap().volume
    }

    fn cube() -> Shape {
        crate::make_box([0.0; 3], [2.0, 2.0, 2.0]).unwrap().unwrap()
    }

    #[test]
    fn a_filleted_edge_removes_the_corner_material() {
        let rounded = fillet(&cube(), &[0], 0.5, None).unwrap().unwrap();
        let removed = 0.25 * (1.0 - std::f64::consts::PI / 4.0) * 2.0;
        assert!((volume(&rounded) - (8.0 - removed)).abs() < 1e-6);
        assert!(fillet(&cube(), &[99], 0.5, None).unwrap().is_none(), "an edge index out of range is refused");
    }

    #[test]
    fn a_chamfered_edge_removes_a_prism() {
        let cut = chamfer(&cube(), &[0], 0.5).unwrap().unwrap();
        assert!((volume(&cut) - (8.0 - 0.125 * 2.0)).abs() < 1e-6);
    }

    #[test]
    fn shells_hollow_and_open() {
        let sealed = shell_hollow(&cube(), 0.25).unwrap().unwrap();
        assert!((volume(&sealed) - (8.0 - 1.5f64.powi(3))).abs() < 1e-6);
        let open = shell_open(&cube(), 0.25, &[1.0, 1.0, 2.0]).unwrap().unwrap();
        assert!((volume(&open) - (8.0 - 1.5 * 1.5 * 1.75)).abs() < 1e-6);
    }

    #[test]
    fn a_chain_face_extrudes_and_a_sweep_follows_its_spine() {
        let half_disc = [1.0, -1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0];
        let face = chain_face(&half_disc).unwrap().unwrap();
        let prism = prism_of_face(&face, [0.0, 0.0, 2.0]).unwrap().unwrap();
        assert!((volume(&prism) - std::f64::consts::PI).abs() < 1e-6);
        let section = circle_section([0.0; 3], [0.0, 0.0, 1.0], 1.0, Some(0.5)).unwrap().unwrap();
        let pipe = pipe_solid(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 3.0], &section).unwrap().unwrap();
        assert!((volume(&pipe) - std::f64::consts::PI * 0.75 * 3.0).abs() < 1e-6);
    }

    /// LIM-1 (9): an annulus swept around a closed spine is a valid hollow ring (no caps), like the full section.
    #[test]
    fn a_hollow_section_around_a_closed_spine_is_a_valid_ring() {
        let ring = [1.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0, -10.0, 0.0, 0.0, 1.0, -10.0, 0.0, 0.0, 0.0, -10.0, 0.0, 10.0, 0.0, 0.0];
        let pi = std::f64::consts::PI;
        for (inner_radius, area) in [(None, 4.0), (Some(1.0), 3.0)] {
            let section = circle_section([10.0, 0.0, 0.0], [0.0, 1.0, 0.0], 2.0, inner_radius).unwrap().unwrap();
            let pipe = pipe_solid(&ring, &section).unwrap().unwrap();
            assert!(is_valid(&pipe).unwrap(), "ring with inner radius {inner_radius:?} is a valid solid");
            let torus = 2.0 * pi * 10.0 * pi * area;
            assert!((volume(&pipe) - torus).abs() < 1e-6 * torus, "volume {} vs {torus}", volume(&pipe));
        }
    }

    /// Bilinear sheet over [0, 4] x [0, 3] (degree 1 x 1, one span, 2 x 2 poles).
    fn flat_sheet() -> Vec<f64> {
        let mut data = vec![1.0, 1.0, 2.0, 2.0, 2.0, 2.0, 0.0];
        data.extend([0.0, 0.0, 0.0, 0.0, 3.0, 0.0, 4.0, 0.0, 0.0, 4.0, 3.0, 0.0]);
        data.extend([0.0, 1.0, 2.0, 2.0, 0.0, 1.0, 2.0, 2.0]);
        data
    }

    /// Exact quarter cylinder (radius 10, axis z, height 5) as a rational degree 2 x 1 patch: u along the arc, v along the axis.
    fn quarter_cylinder_sheet() -> Vec<f64> {
        let w = std::f64::consts::FRAC_1_SQRT_2;
        let mut data = vec![2.0, 1.0, 3.0, 2.0, 2.0, 2.0, 1.0];
        for (x, y) in [(10.0, 0.0), (10.0, 10.0), (0.0, 10.0)] {
            data.extend([x, y, 0.0, x, y, 5.0]);
        }
        data.extend([1.0, 1.0, w, w, 1.0, 1.0]);
        data.extend([0.0, 1.0, 3.0, 3.0, 0.0, 1.0, 2.0, 2.0]);
        data
    }

    fn rectangle(u0: f64, v0: f64, u1: f64, v1: f64) -> Vec<f64> {
        vec![1.0, 4.0, 1.0, u0, v0, u1, v0, u1, v1, u0, v1]
    }

    #[test]
    fn a_b_spline_sheet_is_an_exact_face_with_optional_trims() {
        let whole = surface_face(0, &flat_sheet(), &[]).unwrap().unwrap();
        let area = crate::mass_properties(&whole).unwrap().area;
        assert!((area - 12.0).abs() < 1e-9, "sheet area {area}");
        let trimmed = surface_face(0, &flat_sheet(), &rectangle(0.25, 1.0 / 6.0, 0.75, 5.0 / 6.0)).unwrap().unwrap();
        let area = crate::mass_properties(&trimmed).unwrap().area;
        assert!((area - 4.0).abs() < 1e-9, "trimmed area {area}");
        // the whole sheet minus the hole [0.25, 0.75] x [1/3, 2/3] (2 x 1 in space)
        let mut with_hole = vec![2.0, 4.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0];
        with_hole.extend([4.0, 0.0, 0.25, 1.0 / 3.0, 0.75, 1.0 / 3.0, 0.75, 2.0 / 3.0, 0.25, 2.0 / 3.0]);
        let holed = surface_face(0, &flat_sheet(), &with_hole).unwrap().unwrap();
        let area = crate::mass_properties(&holed).unwrap().area;
        assert!((area - 10.0).abs() < 1e-9, "holed area {area}");
        assert!(surface_face(0, &[1.0, 1.0], &[]).is_err(), "inconsistent data is an error");
    }

    /// Loop and surface lists come from stored documents: counts that are fractional, huge, negative or NaN must be errors, never an out-of-range read.
    #[test]
    fn malformed_surface_and_loop_data_is_an_error_not_a_crash() {
        let plane = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let good = rectangle(0.0, 0.0, 1.0, 1.0);
        let bad_loops: Vec<Vec<f64>> = vec![
            vec![1e19, 4.0, 1.0],
            vec![1.0, 1e19, 1.0, 0.0, 0.0],
            vec![1.0, -1.0, 1.0, 0.0, 0.0],
            vec![f64::NAN, 4.0, 1.0],
            vec![1.0, f64::NAN, 1.0],
            vec![1.0, 4.5, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0],
            vec![1.0, 2.0, 1.0, 0.0, 0.0, 1.0, 0.0],
            vec![1.0, 4.0, 2.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0],
            vec![1.0, 4.0, 1.0, 0.0, 0.0],
            vec![2.0, 4.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 4.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0],
            vec![0.0],
        ];
        for loops in &bad_loops {
            assert!(surface_face(1, &plane, loops).is_err(), "loops {loops:?}");
            assert!(face_slab(1, &plane, loops, [0.0, 1.0], [0.0, 0.0, 1.0], 1e-6).is_err(), "slab loops {loops:?}");
        }
        let mut trailing = good.clone();
        trailing.push(7.0);
        assert!(surface_face(1, &plane, &trailing).is_err(), "trailing data");
        let mut sheet = flat_sheet();
        for (index, value) in [(0, 1e19), (2, f64::NAN), (3, -4.0), (4, 2.5), (6, 2.0)] {
            let previous = sheet[index];
            sheet[index] = value;
            assert!(surface_face(0, &sheet, &[]).is_err(), "sheet field {index} = {value}");
            sheet[index] = previous;
        }
        let mut multiplicity = flat_sheet();
        let last = multiplicity.len() - 1;
        multiplicity[last] = f64::NAN;
        assert!(surface_face(0, &multiplicity, &[]).is_err());
        assert!(surface_face(2, &[0.0; 9], &[]).is_err() && surface_face(7, &[], &[]).is_err());
        assert!(surface_face(0, &flat_sheet(), &[]).unwrap().is_some(), "the untouched data still builds");
    }

    #[test]
    fn slabs_over_plane_cylinder_cone_and_b_spline_faces_have_the_exact_volume() {
        let tolerance = 1e-6;
        let plane = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let slab = face_slab(1, &plane, &rectangle(0.0, 0.0, 4.0, 3.0), [0.0, 0.5], [0.0, 0.0, 1.0], tolerance).unwrap().unwrap();
        let mass = crate::mass_properties(&slab).unwrap();
        assert!((mass.volume - 6.0).abs() < 1e-7, "plane slab {}", mass.volume);
        let lifted = face_slab(1, &plane, &rectangle(0.0, 0.0, 4.0, 3.0), [1.0, 1.5], [0.0, 0.0, 1.0], tolerance).unwrap().unwrap();
        let top = crate::mass_properties(&lifted).unwrap().centroid[2] - 0.25;
        assert!((top - 1.0).abs() < 1e-7, "lifted slab centroid {top}");
        let down = face_slab(1, &plane, &rectangle(0.0, 0.0, 4.0, 3.0), [0.0, 0.5], [0.0, 0.0, -1.0], tolerance).unwrap().unwrap();
        let bottom = crate::mass_properties(&down).unwrap().centroid[2] - 0.25;
        assert!((bottom + 0.5).abs() < 1e-7, "lifted against the reference direction {bottom}");
        // quarter of a cylinder shell, radius 10 -> 12, height 5
        let cylinder = [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 10.0];
        let arc = std::f64::consts::FRAC_PI_2;
        let expected = 0.5 * arc * (144.0 - 100.0) * 5.0;
        let shell = face_slab(2, &cylinder, &rectangle(0.0, 0.0, arc, 5.0), [0.0, 2.0], [1.0, 0.0, 0.0], tolerance).unwrap().unwrap();
        let volume = crate::mass_properties(&shell).unwrap().volume;
        assert!((volume / expected - 1.0).abs() < 1e-6, "cylinder slab {volume} vs {expected}");
        // the same patch as a rational B-spline sheet
        let nurbs = face_slab(0, &quarter_cylinder_sheet(), &[], [0.0, 2.0], [1.0, 0.0, 0.0], tolerance).unwrap().unwrap();
        let volume = crate::mass_properties(&nurbs).unwrap().volume;
        assert!((volume / expected - 1.0).abs() < 1e-5, "B-spline slab {volume} vs {expected}");
        // full turn: the periodic seam
        let full = std::f64::consts::TAU;
        let ring = face_slab(2, &cylinder, &rectangle(0.0, 0.0, full, 5.0), [0.0, 2.0], [1.0, 0.0, 0.0], tolerance).unwrap().unwrap();
        let volume = crate::mass_properties(&ring).unwrap().volume;
        let expected_ring = std::f64::consts::PI * (144.0 - 100.0) * 5.0;
        assert!((volume / expected_ring - 1.0).abs() < 1e-6, "full tube {volume} vs {expected_ring}");
        // cone: apex at the origin, semi-angle 30 degrees, generators 20 .. 30, a 90-degree sector, lifted by 1
        let half = std::f64::consts::FRAC_PI_6;
        let cone = [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, half];
        let cone_slab = face_slab(3, &cone, &rectangle(0.0, 20.0, arc, 30.0), [0.0, 1.0], [0.0, 1.0, 0.0], tolerance);
        let volume = crate::mass_properties(&cone_slab.unwrap().unwrap()).unwrap().volume;
        let area = 0.5 * arc * half.sin() * (900.0 - 400.0) + 0.5 * half.cos() * arc * 10.0;
        assert!((volume / area - 1.0).abs() < 1e-6, "cone slab {volume} vs exact {area}");
        assert!(crate::analyze(&ring).unwrap().valid, "the full tube is a valid solid");
        assert!(face_slab(1, &plane, &rectangle(0.0, 0.0, 4.0, 3.0), [1.0, 1.0], [0.0, 0.0, 1.0], tolerance).unwrap().is_none());
    }

    /// As ONE multi-span edge per section the loft was exact but OCC's Gauss rule under-integrated its faces (square 6.963 instead of 8, circle
    /// 0.9 % high; the fine tessellations gave 8 and 2 pi). Each knot span of a section is now its own edge.
    #[test]
    fn b_spline_sections_integrate_to_the_exact_volume() {
        let square = |z: f64| -> Vec<f64> {
            let corners = [[1.0, 1.0], [-1.0, 1.0], [-1.0, -1.0], [1.0, -1.0], [1.0, 1.0]];
            let mut data = vec![1.0, 5.0, 5.0, 0.0, 0.0];
            data.extend(corners.iter().flat_map(|corner| [corner[0], corner[1], z]));
            data.extend([0.0, 1.0, 2.0, 3.0, 4.0, 2.0, 1.0, 1.0, 1.0, 2.0]);
            data
        };
        let prism = skinned_solid_bsplines(&[square(0.0), square(2.0)], true).unwrap().unwrap();
        let mass = crate::mass_properties(&prism).unwrap();
        assert!((mass.volume - 8.0).abs() < 1e-9, "square loft volume {}", mass.volume);
        assert!((mass.area - 24.0).abs() < 1e-9, "square loft area {}", mass.area);
        let lumps = crate::analyze(&prism).unwrap().lumps;
        assert!((lumps[0] - 8.0).abs() < 1e-9, "analyze lump volume {}", lumps[0]);
        let circle = |z: f64| -> Vec<f64> {
            let w = std::f64::consts::FRAC_1_SQRT_2;
            let poles = [[1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [-1.0, 1.0], [-1.0, 0.0], [-1.0, -1.0], [0.0, -1.0], [1.0, -1.0], [1.0, 0.0]];
            let mut data = vec![2.0, 9.0, 5.0, 1.0, 0.0];
            data.extend(poles.iter().flat_map(|pole| [pole[0], pole[1], z]));
            data.extend([1.0, w, 1.0, w, 1.0, w, 1.0, w, 1.0]);
            data.extend([0.0, 1.0, 2.0, 3.0, 4.0, 3.0, 2.0, 2.0, 2.0, 3.0]);
            data
        };
        let cylinder = skinned_solid_bsplines(&[circle(0.0), circle(2.0)], true).unwrap().unwrap();
        let mass = crate::mass_properties(&cylinder).unwrap();
        assert!((mass.volume - 2.0 * std::f64::consts::PI).abs() < 1e-7, "rational circle loft volume {}", mass.volume);
    }
}
