//! Safe methods over the Gmsh C API: every call checks `ierr` and turns a failure into `GmshError` (Gmsh's last logged error), every
//! array Gmsh allocates is copied into a `Vec` and released with `gmshFree`. Gmsh keeps one global model state per process, so a
//! process holds one `Gmsh`.

#![allow(unsafe_code)]

use crate::ffi::Api;
use std::ffi::{CStr, CString};
use std::fmt;
use std::os::raw::{c_char, c_int};
use std::ptr;

/// `(dim, tag)` of a model entity.
pub type DimTag = (i32, i32);

/// A failed Gmsh call: the message Gmsh logged for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GmshError(pub String);

impl fmt::Display for GmshError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for GmshError {}

pub type Result<T> = std::result::Result<T, GmshError>;

/// The loaded Gmsh library.
pub struct Gmsh {
    api: Api,
    /// Path the library was loaded from.
    pub library: String,
}

fn c_string(text: &str) -> Result<CString> {
    CString::new(text).map_err(|_| GmshError(format!("string {text:?} holds a NUL byte")))
}

fn flatten(dim_tags: &[DimTag]) -> Vec<c_int> {
    dim_tags.iter().flat_map(|&(dim, tag)| [dim, tag]).collect()
}

fn pairs(flat: &[c_int]) -> Vec<DimTag> {
    flat.chunks_exact(2).map(|pair| (pair[0], pair[1])).collect()
}

impl Gmsh {
    pub(crate) fn new(api: Api, library: String) -> Self {
        Self { api, library }
    }

    fn call<R>(&self, run: impl FnOnce(*mut c_int) -> R) -> Result<R> {
        let mut ierr: c_int = 0;
        let value = run(&mut ierr);
        if ierr == 0 {
            Ok(value)
        } else {
            Err(GmshError(self.last_error().unwrap_or_else(|| format!("Gmsh call failed (ierr {ierr})"))))
        }
    }

    fn last_error(&self) -> Option<String> {
        let mut text: *mut c_char = ptr::null_mut();
        let mut ierr: c_int = 0;
        // SAFETY: Gmsh allocates `text` (gmshMalloc), released by take_string.
        unsafe { (self.api.logger_get_last_error)(&mut text, &mut ierr) };
        let message = self.take_string(text);
        (ierr == 0 && !message.is_empty()).then_some(message)
    }

    fn take<T: Copy>(&self, data: *mut T, length: usize) -> Vec<T> {
        if data.is_null() {
            return Vec::new();
        }
        // SAFETY: Gmsh returned `length` elements at `data`, allocated with gmshMalloc and owned by the caller from now on.
        let values = unsafe { std::slice::from_raw_parts(data, length) }.to_vec();
        unsafe { (self.api.free)(data.cast()) };
        values
    }

    fn take_string(&self, text: *mut c_char) -> String {
        if text.is_null() {
            return String::new();
        }
        // SAFETY: a NUL-terminated string allocated by Gmsh.
        let value = unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned();
        unsafe { (self.api.free)(text.cast()) };
        value
    }

    /// `gmshInitialize` without reading the user's configuration files.
    pub fn initialize(&self) -> Result<()> {
        self.call(|e| unsafe { (self.api.initialize)(0, ptr::null_mut(), 0, 0, e) })
    }

    pub fn finalize(&self) -> Result<()> {
        self.call(|e| unsafe { (self.api.finalize)(e) })
    }

    pub fn clear(&self) -> Result<()> {
        self.call(|e| unsafe { (self.api.clear)(e) })
    }

    pub fn merge(&self, file: &str) -> Result<()> {
        let file = c_string(file)?;
        self.call(|e| unsafe { (self.api.merge)(file.as_ptr(), e) })
    }

    pub fn set_number(&self, name: &str, value: f64) -> Result<()> {
        let name = c_string(name)?;
        self.call(|e| unsafe { (self.api.option_set_number)(name.as_ptr(), value, e) })
    }

    pub fn set_string(&self, name: &str, value: &str) -> Result<()> {
        let (name, value) = (c_string(name)?, c_string(value)?);
        self.call(|e| unsafe { (self.api.option_set_string)(name.as_ptr(), value.as_ptr(), e) })
    }

    pub fn get_string(&self, name: &str) -> Result<String> {
        let name = c_string(name)?;
        let mut text: *mut c_char = ptr::null_mut();
        self.call(|e| unsafe { (self.api.option_get_string)(name.as_ptr(), &mut text, e) })?;
        Ok(self.take_string(text))
    }

    pub fn model_add(&self, name: &str) -> Result<()> {
        let name = c_string(name)?;
        self.call(|e| unsafe { (self.api.model_add)(name.as_ptr(), e) })
    }

    /// Entities of dimension `dim` (-1: all) of the current model.
    pub fn entities(&self, dim: i32) -> Result<Vec<DimTag>> {
        let (mut data, mut length) = (ptr::null_mut(), 0usize);
        self.call(|e| unsafe { (self.api.model_get_entities)(&mut data, &mut length, dim, e) })?;
        Ok(pairs(&self.take(data, length)))
    }

    pub fn boundary(&self, dim_tags: &[DimTag], combined: bool, oriented: bool, recursive: bool) -> Result<Vec<DimTag>> {
        let input = flatten(dim_tags);
        let (mut data, mut length) = (ptr::null_mut(), 0usize);
        self.call(|e| unsafe {
            (self.api.model_get_boundary)(
                input.as_ptr(),
                input.len(),
                &mut data,
                &mut length,
                c_int::from(combined),
                c_int::from(oriented),
                c_int::from(recursive),
                e,
            )
        })?;
        Ok(pairs(&self.take(data, length)))
    }

    /// `[xmin, ymin, zmin, xmax, ymax, zmax]` of an entity, or of the whole model with `(-1, -1)`.
    pub fn bounding_box(&self, dim: i32, tag: i32) -> Result<[f64; 6]> {
        let mut b = [0.0f64; 6];
        let [x0, y0, z0, x1, y1, z1] = &mut b;
        self.call(|e| unsafe { (self.api.model_get_bounding_box)(dim, tag, x0, y0, z0, x1, y1, z1, e) })?;
        Ok(b)
    }

    pub fn entity_type(&self, dim: i32, tag: i32) -> Result<String> {
        let mut text: *mut c_char = ptr::null_mut();
        self.call(|e| unsafe { (self.api.model_get_type)(dim, tag, &mut text, e) })?;
        Ok(self.take_string(text))
    }

    pub fn value(&self, dim: i32, tag: i32, parametric: &[f64]) -> Result<Vec<f64>> {
        let (mut data, mut length) = (ptr::null_mut(), 0usize);
        self.call(|e| unsafe { (self.api.model_get_value)(dim, tag, parametric.as_ptr(), parametric.len(), &mut data, &mut length, e) })?;
        Ok(self.take(data, length))
    }

    /// `(curvature max, curvature min)` of surface `tag` at the parametric points.
    pub fn principal_curvatures(&self, tag: i32, parametric: &[f64]) -> Result<(Vec<f64>, Vec<f64>)> {
        let (mut kmax, mut kmax_n, mut kmin, mut kmin_n) = (ptr::null_mut(), 0usize, ptr::null_mut(), 0usize);
        let (mut dmax, mut dmax_n, mut dmin, mut dmin_n) = (ptr::null_mut(), 0usize, ptr::null_mut(), 0usize);
        self.call(|e| unsafe {
            (self.api.model_get_principal_curvatures)(
                tag,
                parametric.as_ptr(),
                parametric.len(),
                &mut kmax,
                &mut kmax_n,
                &mut kmin,
                &mut kmin_n,
                &mut dmax,
                &mut dmax_n,
                &mut dmin,
                &mut dmin_n,
                e,
            )
        })?;
        self.take(dmax, dmax_n);
        self.take(dmin, dmin_n);
        Ok((self.take(kmax, kmax_n), self.take(kmin, kmin_n)))
    }

    pub fn parametrization_bounds(&self, dim: i32, tag: i32) -> Result<(Vec<f64>, Vec<f64>)> {
        let (mut low, mut low_n, mut high, mut high_n) = (ptr::null_mut(), 0usize, ptr::null_mut(), 0usize);
        self.call(|e| unsafe { (self.api.model_get_parametrization_bounds)(dim, tag, &mut low, &mut low_n, &mut high, &mut high_n, e) })?;
        Ok((self.take(low, low_n), self.take(high, high_n)))
    }

    pub fn is_inside(&self, dim: i32, tag: i32, coord: &[f64], parametric: bool) -> Result<i32> {
        self.call(|e| unsafe { (self.api.model_is_inside)(dim, tag, coord.as_ptr(), coord.len(), c_int::from(parametric), e) })
    }

    /// `(closest point, its parametric coordinates)` on the UNTRIMMED entity.
    pub fn closest_point(&self, dim: i32, tag: i32, coord: &[f64]) -> Result<(Vec<f64>, Vec<f64>)> {
        let (mut point, mut point_n, mut uv, mut uv_n) = (ptr::null_mut(), 0usize, ptr::null_mut(), 0usize);
        self.call(|e| unsafe {
            (self.api.model_get_closest_point)(dim, tag, coord.as_ptr(), coord.len(), &mut point, &mut point_n, &mut uv, &mut uv_n, e)
        })?;
        Ok((self.take(point, point_n), self.take(uv, uv_n)))
    }

    pub fn generate(&self, dim: i32) -> Result<()> {
        self.call(|e| unsafe { (self.api.mesh_generate)(dim, e) })
    }

    /// `(node tags, flat xyz)` of entity `(dim, tag)` (`(-1, -1)`: every node of the model).
    pub fn nodes(&self, dim: i32, tag: i32, include_boundary: bool) -> Result<(Vec<usize>, Vec<f64>)> {
        let (mut tags, mut tags_n, mut xyz, mut xyz_n) = (ptr::null_mut(), 0usize, ptr::null_mut(), 0usize);
        let (mut uv, mut uv_n) = (ptr::null_mut(), 0usize);
        self.call(|e| unsafe {
            (self.api.mesh_get_nodes)(
                &mut tags,
                &mut tags_n,
                &mut xyz,
                &mut xyz_n,
                &mut uv,
                &mut uv_n,
                dim,
                tag,
                c_int::from(include_boundary),
                0,
                e,
            )
        })?;
        self.take(uv, uv_n);
        Ok((self.take(tags, tags_n), self.take(xyz, xyz_n)))
    }

    /// `(element type, flat node tags)` per element type of entity `(dim, tag)`.
    pub fn elements(&self, dim: i32, tag: i32) -> Result<Vec<(i32, Vec<usize>)>> {
        let (mut types, mut types_n) = (ptr::null_mut(), 0usize);
        let (mut element_tags, mut element_tags_n, mut element_tags_nn) = (ptr::null_mut(), ptr::null_mut(), 0usize);
        let (mut node_tags, mut node_tags_n, mut node_tags_nn) = (ptr::null_mut(), ptr::null_mut(), 0usize);
        self.call(|e| unsafe {
            (self.api.mesh_get_elements)(
                &mut types,
                &mut types_n,
                &mut element_tags,
                &mut element_tags_n,
                &mut element_tags_nn,
                &mut node_tags,
                &mut node_tags_n,
                &mut node_tags_nn,
                dim,
                tag,
                e,
            )
        })?;
        let types = self.take(types, types_n);
        let element_lists = self.take(element_tags, element_tags_nn);
        let element_lengths = self.take(element_tags_n, element_tags_nn);
        for (list, length) in element_lists.into_iter().zip(element_lengths) {
            self.take(list, length);
        }
        let node_lists = self.take(node_tags, node_tags_nn);
        let node_lengths = self.take(node_tags_n, node_tags_nn);
        let nodes: Vec<Vec<usize>> = node_lists.into_iter().zip(node_lengths).map(|(list, length)| self.take(list, length)).collect();
        Ok(types.into_iter().zip(nodes).collect())
    }

    /// `classifySurfaces(angle, boundary, forReparametrization, curveAngle)` with discrete export (the Python API default).
    pub fn classify_surfaces(&self, angle: f64, boundary: bool, for_reparametrization: bool, curve_angle: f64) -> Result<()> {
        self.call(|e| unsafe {
            (self.api.mesh_classify_surfaces)(angle, c_int::from(boundary), c_int::from(for_reparametrization), curve_angle, 1, e)
        })
    }

    pub fn create_geometry(&self) -> Result<()> {
        self.call(|e| unsafe { (self.api.mesh_create_geometry)(ptr::null(), 0, e) })
    }

    pub fn field_add(&self, field_type: &str) -> Result<i32> {
        let field_type = c_string(field_type)?;
        self.call(|e| unsafe { (self.api.field_add)(field_type.as_ptr(), -1, e) })
    }

    pub fn field_set_number(&self, tag: i32, option: &str, value: f64) -> Result<()> {
        let option = c_string(option)?;
        self.call(|e| unsafe { (self.api.field_set_number)(tag, option.as_ptr(), value, e) })
    }

    pub fn field_set_string(&self, tag: i32, option: &str, value: &str) -> Result<()> {
        let (option, value) = (c_string(option)?, c_string(value)?);
        self.call(|e| unsafe { (self.api.field_set_string)(tag, option.as_ptr(), value.as_ptr(), e) })
    }

    pub fn field_set_numbers(&self, tag: i32, option: &str, values: &[f64]) -> Result<()> {
        let option = c_string(option)?;
        self.call(|e| unsafe { (self.api.field_set_numbers)(tag, option.as_ptr(), values.as_ptr(), values.len(), e) })
    }

    pub fn field_set_as_background_mesh(&self, tag: i32) -> Result<()> {
        self.call(|e| unsafe { (self.api.field_set_as_background_mesh)(tag, e) })
    }

    pub fn geo_add_surface_loop(&self, surfaces: &[i32]) -> Result<i32> {
        self.call(|e| unsafe { (self.api.geo_add_surface_loop)(surfaces.as_ptr(), surfaces.len(), -1, e) })
    }

    pub fn geo_add_volume(&self, shells: &[i32]) -> Result<i32> {
        self.call(|e| unsafe { (self.api.geo_add_volume)(shells.as_ptr(), shells.len(), -1, e) })
    }

    pub fn geo_synchronize(&self) -> Result<()> {
        self.call(|e| unsafe { (self.api.geo_synchronize)(e) })
    }

    pub fn occ_add_point(&self, x: f64, y: f64, z: f64) -> Result<i32> {
        self.call(|e| unsafe { (self.api.occ_add_point)(x, y, z, 0.0, -1, e) })
    }

    pub fn occ_add_line(&self, start: i32, end: i32) -> Result<i32> {
        self.call(|e| unsafe { (self.api.occ_add_line)(start, end, -1, e) })
    }

    pub fn occ_add_curve_loop(&self, curves: &[i32]) -> Result<i32> {
        self.call(|e| unsafe { (self.api.occ_add_curve_loop)(curves.as_ptr(), curves.len(), -1, e) })
    }

    pub fn occ_add_plane_surface(&self, wires: &[i32]) -> Result<i32> {
        self.call(|e| unsafe { (self.api.occ_add_plane_surface)(wires.as_ptr(), wires.len(), -1, e) })
    }

    /// Remove `surfaces` from `volumes` (the defeatured volumes replace them).
    pub fn occ_defeature(&self, volumes: &[i32], surfaces: &[i32]) -> Result<Vec<DimTag>> {
        let (mut data, mut length) = (ptr::null_mut(), 0usize);
        self.call(|e| unsafe {
            (self.api.occ_defeature)(volumes.as_ptr(), volumes.len(), surfaces.as_ptr(), surfaces.len(), &mut data, &mut length, 1, e)
        })?;
        Ok(pairs(&self.take(data, length)))
    }

    /// Boolean fragment of `objects` (no tools): `(result entities, per input entity the entities it became)`.
    pub fn occ_fragment(&self, objects: &[DimTag]) -> Result<(Vec<DimTag>, Vec<Vec<DimTag>>)> {
        let input = flatten(objects);
        let (mut data, mut length) = (ptr::null_mut(), 0usize);
        let (mut map, mut map_n, mut map_nn) = (ptr::null_mut(), ptr::null_mut(), 0usize);
        self.call(|e| unsafe {
            (self.api.occ_fragment)(
                input.as_ptr(),
                input.len(),
                ptr::null(),
                0,
                &mut data,
                &mut length,
                &mut map,
                &mut map_n,
                &mut map_nn,
                -1,
                1,
                1,
                e,
            )
        })?;
        let result = pairs(&self.take(data, length));
        let lists = self.take(map, map_nn);
        let lengths = self.take(map_n, map_nn);
        let mapping = lists.into_iter().zip(lengths).map(|(list, length)| pairs(&self.take(list, length))).collect();
        Ok((result, mapping))
    }

    pub fn occ_dilate(&self, dim_tags: &[DimTag], scale: f64) -> Result<()> {
        let input = flatten(dim_tags);
        self.call(|e| unsafe { (self.api.occ_dilate)(input.as_ptr(), input.len(), 0.0, 0.0, 0.0, scale, scale, scale, e) })
    }

    /// Import a CAD file (format from the extension), highest dimension only.
    pub fn occ_import_shapes(&self, file: &str) -> Result<Vec<DimTag>> {
        let (file, format) = (c_string(file)?, c_string("")?);
        let (mut data, mut length) = (ptr::null_mut(), 0usize);
        self.call(|e| unsafe { (self.api.occ_import_shapes)(file.as_ptr(), &mut data, &mut length, 1, format.as_ptr(), e) })?;
        Ok(pairs(&self.take(data, length)))
    }

    pub fn occ_entities(&self, dim: i32) -> Result<Vec<DimTag>> {
        let (mut data, mut length) = (ptr::null_mut(), 0usize);
        self.call(|e| unsafe { (self.api.occ_get_entities)(&mut data, &mut length, dim, e) })?;
        Ok(pairs(&self.take(data, length)))
    }

    pub fn occ_mass(&self, dim: i32, tag: i32) -> Result<f64> {
        let mut mass = 0.0;
        self.call(|e| unsafe { (self.api.occ_get_mass)(dim, tag, &mut mass, e) })?;
        Ok(mass)
    }

    pub fn occ_center_of_mass(&self, dim: i32, tag: i32) -> Result<[f64; 3]> {
        let mut c = [0.0f64; 3];
        let [x, y, z] = &mut c;
        self.call(|e| unsafe { (self.api.occ_get_center_of_mass)(dim, tag, x, y, z, e) })?;
        Ok(c)
    }

    pub fn occ_synchronize(&self) -> Result<()> {
        self.call(|e| unsafe { (self.api.occ_synchronize)(e) })
    }
}
