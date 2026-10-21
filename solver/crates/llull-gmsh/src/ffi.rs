//! The C entry points of `gmshc.h` that llull-mesh calls, resolved by name from the loaded library. Only this module and the
//! array/string helpers in `lib.rs` touch raw pointers.

use libloading::Library;
use std::os::raw::{c_char, c_double, c_int, c_void};

type Ierr = *mut c_int;

macro_rules! gmsh_api {
    ($($field:ident = $symbol:literal : fn($($arg:ty),*) $(-> $ret:ty)?;)*) => {
        pub(crate) struct Api {
            $(pub(crate) $field: unsafe extern "C" fn($($arg),*) $(-> $ret)?,)*
            _library: Library,
        }

        impl Api {
            /// Resolve every symbol; the library stays loaded for the life of the `Api`.
            #[allow(unsafe_code)]
            pub(crate) fn resolve(library: Library) -> Result<Self, String> {
                // SAFETY: each symbol is declared with the signature of gmshc.h (Gmsh 4.x C API).
                unsafe {
                    Ok(Self {
                        $($field: *library
                            .get::<unsafe extern "C" fn($($arg),*) $(-> $ret)?>(concat!($symbol, "\0").as_bytes())
                            .map_err(|error| format!("{}: {error}", $symbol))?,)*
                        _library: library,
                    })
                }
            }
        }
    };
}

gmsh_api! {
    free = "gmshFree": fn(*mut c_void);
    initialize = "gmshInitialize": fn(c_int, *mut *mut c_char, c_int, c_int, Ierr);
    finalize = "gmshFinalize": fn(Ierr);
    merge = "gmshMerge": fn(*const c_char, Ierr);
    clear = "gmshClear": fn(Ierr);
    option_set_number = "gmshOptionSetNumber": fn(*const c_char, c_double, Ierr);
    option_set_string = "gmshOptionSetString": fn(*const c_char, *const c_char, Ierr);
    option_get_string = "gmshOptionGetString": fn(*const c_char, *mut *mut c_char, Ierr);
    logger_get_last_error = "gmshLoggerGetLastError": fn(*mut *mut c_char, Ierr);
    model_add = "gmshModelAdd": fn(*const c_char, Ierr);
    model_get_entities = "gmshModelGetEntities": fn(*mut *mut c_int, *mut usize, c_int, Ierr);
    model_get_boundary = "gmshModelGetBoundary": fn(*const c_int, usize, *mut *mut c_int, *mut usize, c_int, c_int, c_int, Ierr);
    model_get_bounding_box = "gmshModelGetBoundingBox":
        fn(c_int, c_int, *mut c_double, *mut c_double, *mut c_double, *mut c_double, *mut c_double, *mut c_double, Ierr);
    model_get_type = "gmshModelGetType": fn(c_int, c_int, *mut *mut c_char, Ierr);
    model_get_value = "gmshModelGetValue": fn(c_int, c_int, *const c_double, usize, *mut *mut c_double, *mut usize, Ierr);
    model_get_principal_curvatures = "gmshModelGetPrincipalCurvatures": fn(
        c_int, *const c_double, usize,
        *mut *mut c_double, *mut usize, *mut *mut c_double, *mut usize,
        *mut *mut c_double, *mut usize, *mut *mut c_double, *mut usize, Ierr);
    model_get_parametrization_bounds = "gmshModelGetParametrizationBounds":
        fn(c_int, c_int, *mut *mut c_double, *mut usize, *mut *mut c_double, *mut usize, Ierr);
    model_is_inside = "gmshModelIsInside": fn(c_int, c_int, *const c_double, usize, c_int, Ierr) -> c_int;
    model_get_closest_point = "gmshModelGetClosestPoint":
        fn(c_int, c_int, *const c_double, usize, *mut *mut c_double, *mut usize, *mut *mut c_double, *mut usize, Ierr);
    mesh_generate = "gmshModelMeshGenerate": fn(c_int, Ierr);
    mesh_get_nodes = "gmshModelMeshGetNodes": fn(
        *mut *mut usize, *mut usize, *mut *mut c_double, *mut usize, *mut *mut c_double, *mut usize, c_int, c_int, c_int, c_int, Ierr);
    mesh_get_elements = "gmshModelMeshGetElements": fn(
        *mut *mut c_int, *mut usize,
        *mut *mut *mut usize, *mut *mut usize, *mut usize,
        *mut *mut *mut usize, *mut *mut usize, *mut usize,
        c_int, c_int, Ierr);
    mesh_classify_surfaces = "gmshModelMeshClassifySurfaces": fn(c_double, c_int, c_int, c_double, c_int, Ierr);
    mesh_create_geometry = "gmshModelMeshCreateGeometry": fn(*const c_int, usize, Ierr);
    field_add = "gmshModelMeshFieldAdd": fn(*const c_char, c_int, Ierr) -> c_int;
    field_set_number = "gmshModelMeshFieldSetNumber": fn(c_int, *const c_char, c_double, Ierr);
    field_set_string = "gmshModelMeshFieldSetString": fn(c_int, *const c_char, *const c_char, Ierr);
    field_set_numbers = "gmshModelMeshFieldSetNumbers": fn(c_int, *const c_char, *const c_double, usize, Ierr);
    field_set_as_background_mesh = "gmshModelMeshFieldSetAsBackgroundMesh": fn(c_int, Ierr);
    geo_add_surface_loop = "gmshModelGeoAddSurfaceLoop": fn(*const c_int, usize, c_int, Ierr) -> c_int;
    geo_add_volume = "gmshModelGeoAddVolume": fn(*const c_int, usize, c_int, Ierr) -> c_int;
    geo_synchronize = "gmshModelGeoSynchronize": fn(Ierr);
    occ_add_point = "gmshModelOccAddPoint": fn(c_double, c_double, c_double, c_double, c_int, Ierr) -> c_int;
    occ_add_line = "gmshModelOccAddLine": fn(c_int, c_int, c_int, Ierr) -> c_int;
    occ_add_curve_loop = "gmshModelOccAddCurveLoop": fn(*const c_int, usize, c_int, Ierr) -> c_int;
    occ_add_plane_surface = "gmshModelOccAddPlaneSurface": fn(*const c_int, usize, c_int, Ierr) -> c_int;
    occ_defeature = "gmshModelOccDefeature": fn(*const c_int, usize, *const c_int, usize, *mut *mut c_int, *mut usize, c_int, Ierr);
    occ_fragment = "gmshModelOccFragment": fn(
        *const c_int, usize, *const c_int, usize,
        *mut *mut c_int, *mut usize, *mut *mut *mut c_int, *mut *mut usize, *mut usize,
        c_int, c_int, c_int, Ierr);
    occ_dilate = "gmshModelOccDilate": fn(*const c_int, usize, c_double, c_double, c_double, c_double, c_double, c_double, Ierr);
    occ_import_shapes = "gmshModelOccImportShapes": fn(*const c_char, *mut *mut c_int, *mut usize, c_int, *const c_char, Ierr);
    occ_get_entities = "gmshModelOccGetEntities": fn(*mut *mut c_int, *mut usize, c_int, Ierr);
    occ_get_mass = "gmshModelOccGetMass": fn(c_int, c_int, *mut c_double, Ierr);
    occ_get_center_of_mass = "gmshModelOccGetCenterOfMass": fn(c_int, c_int, *mut c_double, *mut c_double, *mut c_double, Ierr);
    occ_synchronize = "gmshModelOccSynchronize": fn(Ierr);
}
