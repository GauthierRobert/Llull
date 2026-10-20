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

        fn feature_revol_cut(source: &Shape, profile: &[f64], origin: &[f64], normal: &[f64]) -> Result<UniquePtr<Shape>>;
        fn feature_prism_cut(
            source: &Shape,
            chain: &[f64],
            origin: &[f64],
            normal: &[f64],
            probes: &[f64],
            length: f64,
        ) -> Result<UniquePtr<Shape>>;
        fn is_valid_shape(shape: &Shape) -> Result<bool>;
        fn unified_shape(shape: &Shape) -> Result<UniquePtr<Shape>>;
    }
}

/// Fillet of the unique edges `edges` (explorer order, `[]` = all); `radius_end` varies the radius linearly along each edge.
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

pub fn feature_revol_cut(source: &Shape, profile: &[f64], origin: [f64; 3], normal: [f64; 3]) -> Built {
    built(ffi::feature_revol_cut(inner(source)?, profile, &origin, &normal))
}

pub fn feature_prism_cut(source: &Shape, chain: &[f64], origin: [f64; 3], normal: [f64; 3], probes: &[f64], length: f64) -> Built {
    built(ffi::feature_prism_cut(inner(source)?, chain, &origin, &normal, probes, length))
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
