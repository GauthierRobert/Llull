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
        fn fillet_profile(shape: &Shape, specs: &[f64]) -> Result<UniquePtr<Shape>>;
        fn profile_reason(shape: &Shape, specs: &[f64]) -> Result<String>;
        fn fillet_setback(shape: &Shape, edges: &[f64], corners: &[f64]) -> Result<UniquePtr<Shape>>;
        fn setback_reason(shape: &Shape, edges: &[f64], corners: &[f64]) -> Result<String>;
        fn fillet_profile_blend(
            shape: &Shape,
            specs: &[f64],
            edges: &[u32],
            laws: &[f64],
            kind: f64,
            param: f64,
        ) -> Result<UniquePtr<Shape>>;
        fn profile_blend_last_reason() -> Result<String>;
        fn shape_notes(shape: &Shape) -> Result<String>;
        fn profile_blend_reason(shape: &Shape, specs: &[f64], edges: &[u32], laws: &[f64], kind: f64, param: f64) -> Result<String>;
        fn fillet_rails(shape: &Shape, edges: &[u32], laws: &[f64], kind: f64, param: f64) -> Result<UniquePtr<Shape>>;
        fn rails_reason(shape: &Shape, edges: &[u32], laws: &[f64], kind: f64, param: f64) -> Result<String>;
        fn face_blend(shape: &Shape, spec: &[f64]) -> Result<UniquePtr<Shape>>;
        fn face_blend_reason(shape: &Shape, spec: &[f64]) -> Result<String>;
        fn full_round(shape: &Shape, spec: &[f64]) -> Result<UniquePtr<Shape>>;
        fn full_round_reason(shape: &Shape, spec: &[f64]) -> Result<String>;
        fn chamfer_sided(shape: &Shape, edges: &[u32], faces: &[u32], first: f64, second: f64, angle: bool) -> Result<UniquePtr<Shape>>;
        fn chamfer_variable(
            shape: &Shape,
            edges: &[u32],
            faces: &[u32],
            first: f64,
            last: f64,
            second: f64,
            second_last: f64,
        ) -> Result<UniquePtr<Shape>>;
        fn chamfer_variable_reason(
            shape: &Shape,
            edges: &[u32],
            faces: &[u32],
            first: f64,
            last: f64,
            second: f64,
            second_last: f64,
        ) -> Result<String>;
        fn blend_union(list: &ShapeList, radius: f64, joints: &[f64]) -> Result<UniquePtr<Shape>>;
        fn blend_union_reason(list: &ShapeList, radius: f64, joints: &[f64]) -> Result<String>;
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
        fn helix_pipe_solid(helix: &[f64], section: &Shape) -> Result<UniquePtr<Shape>>;
        #[allow(clippy::too_many_arguments)]
        fn pipe_shell_solid(
            spine: &[f64],
            section: &Shape,
            mode: i32,
            direction: &[f64],
            law: &[f64],
            transition: i32,
            tolerance: f64,
            probes: &[f64],
            check: f64,
            volume: f64,
        ) -> Result<UniquePtr<Shape>>;
        fn bspline_patch_solid(poles: &[f64], tolerance: f64) -> Result<UniquePtr<Shape>>;

        fn sheet_solid(faces: &[f64], lengths: &[u32], tolerance: f64, caps_expected: i32) -> Result<UniquePtr<Shape>>;

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
        fn move_faces(shape: &Shape, faces: &[u32], mode: i32, a: &[f64], b: &[f64], value: f64, check: bool) -> Result<UniquePtr<Shape>>;
        fn delete_faces(shape: &Shape, faces: &[u32]) -> Result<UniquePtr<Shape>>;
        fn is_valid_shape(shape: &Shape) -> Result<bool>;
        fn unified_shape(shape: &Shape) -> Result<UniquePtr<Shape>>;
    }
}

/// Fillet of the unique edges `edges` (explorer order, `[]` = all); `radius_end` varies the radius linearly along each edge.
/// One radius law per edge (`radii`): `laws` per edge: size, sizeEnd (NaN = constant), mode (0 smooth, 1 straight pieces, 2 monotone C1 cubic), n, then n (t, size) pairs.
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

/// BLD M2 profile blends of straight edges between planar faces: `specs` holds 7 numbers per edge (unique edge index, kind 0 conic / 1 curvature /
/// 2 circular with two legs, rho or shape factor, size, size2 (NaN = size is a radius), side face index or -1, reserved 0).
pub fn fillet_profile(shape: &Shape, specs: &[f64]) -> Built {
    built(ffi::fillet_profile(inner(shape)?, specs))
}

/// BLD M2 profile blend of a fillet node: the prism builder for `specs` (empty when a size varies), corners where edges meet, else the rail builder
/// for `edges` / `laws` (empty when a leg is asymmetric) with the section `kind` / `param`.
pub fn fillet_profile_blend(shape: &Shape, specs: &[f64], edges: &[u32], laws: &[f64], kind: f64, param: f64) -> Built {
    built(ffi::fillet_profile_blend(inner(shape)?, specs, edges, laws, kind, param))
}

/// Why `fillet_profile_blend` fails ("" when it builds).
pub fn profile_blend_reason(shape: &Shape, specs: &[f64], edges: &[u32], laws: &[f64], kind: f64, param: f64) -> OcctResult<String> {
    occt(ffi::profile_blend_reason(inner(shape)?, specs, edges, laws, kind, param))
}

/// What the builder of `shape` reported about how it made it (a JSON object, empty for most shapes).
pub fn shape_notes(shape: &Shape) -> OcctResult<String> {
    occt(ffi::shape_notes(inner(shape)?))
}

/// The reason the last `fillet_profile_blend` of this thread returned `None`.
pub fn profile_blend_last_reason() -> OcctResult<String> {
    occt(ffi::profile_blend_last_reason())
}

/// BLD M2 rail-preserving profile blend: the circular fillet of the unique edges `edges` with `laws` (the `fillet_laws` layout), re-skinned with the
/// section `kind` (0 conic, 1 curvature) and `param` (rho or shape) on curved edges and faces, with any size law.
pub fn fillet_rails(shape: &Shape, edges: &[u32], laws: &[f64], kind: f64, param: f64) -> Built {
    built(ffi::fillet_rails(inner(shape)?, edges, laws, kind, param))
}

/// Why `fillet_rails` fails ("" when it builds).
pub fn rails_reason(shape: &Shape, edges: &[u32], laws: &[f64], kind: f64, param: f64) -> OcctResult<String> {
    occt(ffi::rails_reason(inner(shape)?, edges, laws, kind, param))
}

/// BLD M3 setback corners of straight convex edges between planar faces: `edges` = (unique edge index, radius) pairs, `corners` = per corner
/// x, y, z, n, then n (unique edge index, setback distance) pairs for every edge meeting at the vertex.
pub fn fillet_setback(shape: &Shape, edges: &[f64], corners: &[f64]) -> Built {
    built(ffi::fillet_setback(inner(shape)?, edges, corners))
}

/// Why `fillet_setback` fails ("" when it builds; a leading `[BLD_CODE]` names the stable code).
pub fn setback_reason(shape: &Shape, edges: &[f64], corners: &[f64]) -> OcctResult<String> {
    occt(ffi::setback_reason(inner(shape)?, edges, corners))
}

/// BLD M4 `fillet_faces`: `spec` = unique index of face A, of face B, radius, section kind (0 conic, 1 curvature, 2 circular), rho / shape.
pub fn face_blend(shape: &Shape, spec: &[f64]) -> Built {
    built(ffi::face_blend(inner(shape)?, spec))
}

/// Why `face_blend` fails ("" when it builds; a leading `[BLD_CODE]` names the stable code).
pub fn face_blend_reason(shape: &Shape, spec: &[f64]) -> OcctResult<String> {
    occt(ffi::face_blend_reason(inner(shape)?, spec))
}

/// BLD M4 `fillet_full_round`: `spec` = unique indices of side 1, center, side 2.
pub fn full_round(shape: &Shape, spec: &[f64]) -> Built {
    built(ffi::full_round(inner(shape)?, spec))
}

/// Why `full_round` fails ("" when it builds).
pub fn full_round_reason(shape: &Shape, spec: &[f64]) -> OcctResult<String> {
    occt(ffi::full_round_reason(inner(shape)?, spec))
}

/// Why `fillet_profile` fails for `specs` ("" when it builds).
pub fn profile_reason(shape: &Shape, specs: &[f64]) -> OcctResult<String> {
    occt(ffi::profile_reason(inner(shape)?, specs))
}

/// Chamfer of the unique edges `edges` with the first leg on the unique face `faces[k]` of edge k: two distances, or with `angle` a distance
/// and an angle in radians measured on that face.
pub fn chamfer_sided(shape: &Shape, edges: &[u32], faces: &[u32], first: f64, second: f64, angle: bool) -> Built {
    built(ffi::chamfer_sided(inner(shape)?, edges, faces, first, second, angle))
}

/// BLD M5 chamfer whose distance runs linearly from `first` at the start of each listed edge to `last` at its end: symmetric when `faces` is empty,
/// else the first leg is on the unique face `faces[k]` of edge k and the other leg runs from `second` to `second_last`. Straight edges between planar
/// faces and curved edges (an arc, a B-spline) are built.
pub fn chamfer_variable(shape: &Shape, edges: &[u32], faces: &[u32], first: f64, last: f64, second: f64, second_last: f64) -> Built {
    built(ffi::chamfer_variable(inner(shape)?, edges, faces, first, last, second, second_last))
}

/// Why [`chamfer_variable`] fails (empty when it builds).
pub fn chamfer_variable_reason(
    shape: &Shape,
    edges: &[u32],
    faces: &[u32],
    first: f64,
    last: f64,
    second: f64,
    second_last: f64,
) -> OcctResult<String> {
    occt(ffi::chamfer_variable_reason(inner(shape)?, edges, faces, first, last, second, second_last))
}

/// The shape list of a blend: one fuse of `shapes`.
fn shape_list(shapes: &[&Shape]) -> Result<cxx::UniquePtr<ffi::ShapeList>, String> {
    let mut list = ffi::new_shape_list();
    for shape in shapes {
        let Some(pinned) = list.as_mut() else { return Err("shape list not created".to_string()) };
        ffi::shape_list_add(pinned, inner(shape)?);
    }
    Ok(list)
}

/// One fuse of `shapes` whose joint (section) edges are filleted by `radius`, except the joints nearest to the picks `joints` (x, y, z, radius per pick).
pub fn blend(shapes: &[&Shape], radius: f64, joints: &[f64]) -> Built {
    let list = shape_list(shapes)?;
    let Some(list) = list.as_ref() else { return Err("shape list not created".to_string()) };
    built(ffi::blend_union(list, radius, joints))
}

/// Why [`blend`] fails (empty when it builds).
pub fn blend_reason(shapes: &[&Shape], radius: f64, joints: &[f64]) -> OcctResult<String> {
    let list = shape_list(shapes)?;
    let Some(list) = list.as_ref() else { return Err("shape list not created".to_string()) };
    occt(ffi::blend_union_reason(list, radius, joints))
}

/// Sealed hollow: the solid minus its inward offset.
pub fn shell_hollow(shape: &Shape, thickness: f64) -> Built {
    built(ffi::shell_hollow(inner(shape)?, thickness))
}

/// Open shell: walls grown inward, the faces nearest to each `open_near` point (xyz triples) removed.
pub fn shell_open(shape: &Shape, thickness: f64, open_near: &[f64]) -> Built {
    built(ffi::shell_open(inner(shape)?, thickness, open_near))
}

/// Planar face bounded by an encoded closed chain (per segment: type code 0 line / 1 arc / 2 Bezier / 3 ellipse quarter [start, centre, end], then its xyz points).
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

/// BRepOffsetAPI_MakePipe of `section` along the exact helix edge (`helixEdge`): origin, axis, x direction, radius, end radius, turns, pitch,
/// left-hand flag, start angle (15 numbers, see `cpp/features.hxx`).
pub fn helix_pipe_solid(helix: &[f64], section: &Shape) -> Built {
    built(ffi::helix_pipe_solid(helix, inner(section)?))
}

/// Settings of the MakePipeShell fast path (`cpp/features.hxx`).
pub struct PipeShell<'a> {
    /// 0 corrected Frenet, 1 Frenet, 2 fixed trihedron, 3 binormal, 4 discrete.
    pub mode: i32,
    pub direction: [f64; 3],
    /// (fraction, scale) pairs of a homothetic law, empty for a constant section.
    pub law: &'a [f64],
    /// 0 transformed, 1 right corner, 2 round corner.
    pub transition: i32,
    pub tolerance: f64,
    /// Points of the exact evaluator the result must pass within `check`.
    pub probes: &'a [f64],
    pub check: f64,
    /// Volume the result must match within a relative 1e-4 (0 = unchecked).
    pub volume: f64,
}

/// MakePipeShell of the section's outer wire along the encoded spine, accepted only when every probe lies within `check` of the result; `None` otherwise.
pub fn pipe_shell_solid(spine: &[f64], section: &Shape, shell: &PipeShell) -> Built {
    built(ffi::pipe_shell_solid(
        spine,
        inner(section)?,
        shell.mode,
        &shell.direction,
        shell.law,
        shell.transition,
        shell.tolerance,
        shell.probes,
        shell.check,
        shell.volume,
    ))
}

/// Sewn solid of bicubic B-spline patches (16 xyz poles each); `None` when any patch or the sewing fails.
pub fn bspline_patch_solid(poles: &[f64], tolerance: f64) -> Built {
    built(ffi::bspline_patch_solid(poles, tolerance))
}

/// Solid closed from fitted B-spline lateral faces (encoded as for [`surface_face`] kind 0): sewn shell, two planar caps, `None` when OCC refuses;
/// `Err` when the sewing leaves free edges (`SWG_KERNEL_SEW_OPEN`).
pub fn sheet_solid(faces: &[Vec<f64>], tolerance: f64) -> Built {
    sheet_solid_capped(faces, tolerance, 2)
}

/// [`sheet_solid`] with `caps` closed free boundaries expected: 2 (the first and last section), 1 (a loft closed to a point at one end), 0 (a closed loft).
pub fn sheet_solid_capped(faces: &[Vec<f64>], tolerance: f64, caps: i32) -> Built {
    let lengths: Option<Vec<u32>> = faces.iter().map(|face| u32::try_from(face.len()).ok()).collect();
    let Some(lengths) = lengths else { return Err("sheet solid: face too long".to_string()) };
    built(ffi::sheet_solid(&faces.concat(), &lengths, tolerance, caps))
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

/// Move `faces` (04 DIR M6): `mode` 0 offset by `value`, 1 translate by `a`, 2 rotate about the axis (`a` origin, `b` direction) by `value` radians.
/// `check` false (a dry run for a ghost) lets the prism route of a planar offset skip the BRepCheck and the volume test; every committed move passes true.
pub fn move_faces(shape: &Shape, faces: &[u32], mode: i32, a: &[f64], b: &[f64], value: f64, check: bool) -> Built {
    built(ffi::move_faces(inner(shape)?, faces, mode, a, b, value, check))
}

/// Delete `faces` by defeaturing (the neighbours extend to close the gap).
pub fn delete_faces(shape: &Shape, faces: &[u32]) -> Built {
    built(ffi::delete_faces(inner(shape)?, faces))
}

pub fn is_valid(shape: &Shape) -> OcctResult<bool> {
    occt(ffi::is_valid_shape(inner(shape)?))
}

/// ShapeUpgrade_UnifySameDomain of a cut result (the shape itself when OCC fails).
pub fn unified(shape: &Shape) -> Built {
    built(ffi::unified_shape(inner(shape)?))
}
