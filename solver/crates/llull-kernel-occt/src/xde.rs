//! XDE exchange of the native kernel (`cpp/xde.hxx`, XCH 04 M2..M4): AP242 / AP214 / AP203 writer with product structure, names, colours,
//! layers, materials and geometric validation properties; the matching STEP product-tree reader; IGES read / write. Shapes arrive as
//! the host's opaque handles; reads answer the JSON the `GeometryKernel` ports describe (`@core/geometry/kernelExchange`).

use crate::queries::ImportOptions;
use crate::{inner, occt, OcctResult, Shape};
use serde_json::Value;

// Fourth cxx bridge of the crate (generated unsafe glue only, as in queries.rs); it reuses lib.rs's opaque `Shape`.
#[allow(unsafe_code)]
#[cxx::bridge(namespace = "llull")]
mod ffi {
    unsafe extern "C++" {
        include!("llull-kernel-occt/cpp/xde.hxx");

        type Shape = crate::ffi::Shape;
        type XdeDoc;

        fn new_xde_doc() -> UniquePtr<XdeDoc>;
        fn xde_product(doc: Pin<&mut XdeDoc>, name: &str, description: &str, color: &str, layer: &str, material: &str, density: f64)
            -> i32;
        fn xde_product_solid(doc: Pin<&mut XdeDoc>, product: i32, shape: &Shape, name: &str, color: &str) -> Result<()>;
        fn xde_product_validation(doc: Pin<&mut XdeDoc>, product: i32, values: &[f64]) -> Result<()>;
        fn xde_product_pmi_datum(doc: Pin<&mut XdeDoc>, product: i32, label: &str, faces: &[i32]) -> Result<()>;
        fn xde_product_pmi_tolerance(
            doc: Pin<&mut XdeDoc>,
            product: i32,
            characteristic: &str,
            value: f64,
            diameter_zone: bool,
            faces: &[i32],
            datums: &str,
        ) -> Result<()>;
        #[allow(clippy::too_many_arguments)]
        fn xde_product_pmi_dimension(
            doc: Pin<&mut XdeDoc>,
            product: i32,
            kind: &str,
            value: f64,
            has_tolerance: bool,
            plus: f64,
            minus: f64,
            faces: &[i32],
            faces_second: &[i32],
        ) -> Result<()>;
        fn xde_use(doc: Pin<&mut XdeDoc>, parent: i32, product: i32, name: &str, rotation: &[f64], position: &[f64]) -> Result<()>;
        #[allow(clippy::too_many_arguments)]
        fn xde_write(
            doc: Pin<&mut XdeDoc>,
            schema: i32,
            unit: &str,
            file_name: &str,
            timestamp: &str,
            originating_system: &str,
            root_name: &str,
            root_validation: &[f64],
        ) -> Result<String>;
        fn xde_import_json(text: &str, precision: f64, max_tolerance: f64, heal: bool, sew: bool) -> Result<String>;

        fn iges_available() -> bool;
        fn iges_import_json(text: &str, precision: f64, max_tolerance: f64, heal: bool, sew: bool, file_resolution: f64) -> Result<String>;
        fn iges_write(doc: Pin<&mut XdeDoc>, brep_mode: bool, unit: &str) -> Result<String>;
    }
}

/// One solid of a product (its own name and `#rrggbb` colour; empty = none).
pub struct ExchangeSolid<'a> {
    pub shape: &'a Shape,
    pub name: String,
    pub color: String,
}

/// A STEP product: its solids and the attributes written with it. `density` below zero = no material; `validation` = volume, area and the
/// centroid in the document unit.
/// Semantic PMI of one product (faces: 0-based indices over the product's shape, `TopExp::MapShapes` order); written in AP242 only.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExchangePmi {
    /// `(label, faces)`
    pub datums: Vec<(String, Vec<i32>)>,
    pub tolerances: Vec<PmiTolerance>,
    pub dimensions: Vec<PmiDimension>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PmiTolerance {
    pub characteristic: String,
    pub value: f64,
    pub diameter_zone: bool,
    pub faces: Vec<i32>,
    /// Datum labels in reference order, primary first.
    pub datums: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PmiDimension {
    pub kind: String,
    pub value: f64,
    /// `(plus, minus)` tolerance values when toleranced.
    pub tolerance: Option<(f64, f64)>,
    pub faces: Vec<i32>,
    pub faces_second: Vec<i32>,
}

pub struct ExchangeProduct<'a> {
    pub pmi: ExchangePmi,
    pub name: String,
    pub description: String,
    pub color: String,
    pub layer: String,
    pub material: String,
    pub density: f64,
    pub solids: Vec<ExchangeSolid<'a>>,
    pub validation: Option<[f64; 5]>,
}

/// One placed use of a product inside `parent` (an index into the products, -1 = the root assembly); `rotation` radians then `position`.
pub struct ExchangeUse {
    pub parent: i32,
    pub product: usize,
    pub name: String,
    pub rotation: [f64; 3],
    pub position: [f64; 3],
}

/// What `writeExchange` receives, minus the shapes (inside the products).
pub struct WriteRequest<'a> {
    pub products: Vec<ExchangeProduct<'a>>,
    pub uses: Vec<ExchangeUse>,
    /// DESTEP schema code: 3 = AP203, 4 = AP214, 5 = AP242.
    pub schema: i32,
    pub unit: &'a str,
    pub file_name: &'a str,
    pub timestamp: &'a str,
    pub originating_system: &'a str,
    pub root_name: &'a str,
    pub root_validation: Option<[f64; 5]>,
}

const NOT_CREATED: &str = "exchange document not created";

fn build(products: &[ExchangeProduct<'_>], uses: &[ExchangeUse]) -> OcctResult<cxx::UniquePtr<ffi::XdeDoc>> {
    let mut doc = ffi::new_xde_doc();
    for product in products {
        let Some(pinned) = doc.as_mut() else { return Err(NOT_CREATED.to_string()) };
        let index = ffi::xde_product(
            pinned,
            &product.name,
            &product.description,
            &product.color,
            &product.layer,
            &product.material,
            product.density,
        );
        for solid in &product.solids {
            let Some(pinned) = doc.as_mut() else { return Err(NOT_CREATED.to_string()) };
            occt(ffi::xde_product_solid(pinned, index, inner(solid.shape)?, &solid.name, &solid.color))?;
        }
        for (label, faces) in &product.pmi.datums {
            let Some(pinned) = doc.as_mut() else { return Err(NOT_CREATED.to_string()) };
            occt(ffi::xde_product_pmi_datum(pinned, index, label, faces))?;
        }
        for tolerance in &product.pmi.tolerances {
            let Some(pinned) = doc.as_mut() else { return Err(NOT_CREATED.to_string()) };
            let datums = tolerance.datums.join("|");
            occt(ffi::xde_product_pmi_tolerance(
                pinned,
                index,
                &tolerance.characteristic,
                tolerance.value,
                tolerance.diameter_zone,
                &tolerance.faces,
                &datums,
            ))?;
        }
        for dimension in &product.pmi.dimensions {
            let Some(pinned) = doc.as_mut() else { return Err(NOT_CREATED.to_string()) };
            let (plus, minus) = dimension.tolerance.unwrap_or((0.0, 0.0));
            occt(ffi::xde_product_pmi_dimension(
                pinned,
                index,
                &dimension.kind,
                dimension.value,
                dimension.tolerance.is_some(),
                plus,
                minus,
                &dimension.faces,
                &dimension.faces_second,
            ))?;
        }
        if let Some(values) = product.validation {
            let Some(pinned) = doc.as_mut() else { return Err(NOT_CREATED.to_string()) };
            occt(ffi::xde_product_validation(pinned, index, &values))?;
        }
    }
    for item in uses {
        let Some(pinned) = doc.as_mut() else { return Err(NOT_CREATED.to_string()) };
        let product = i32::try_from(item.product).map_err(|_| "use: product index out of range".to_string())?;
        occt(ffi::xde_use(pinned, item.parent, product, &item.name, &item.rotation, &item.position))?;
    }
    Ok(doc)
}

/// Part 21 text of the product tree (`writeExchange`); `None` when OCCT refuses the transfer.
pub fn write_exchange(request: &WriteRequest<'_>) -> OcctResult<Option<String>> {
    let mut doc = build(&request.products, &request.uses)?;
    let Some(pinned) = doc.as_mut() else { return Err(NOT_CREATED.to_string()) };
    let validation = request.root_validation.map(|values| values.to_vec()).unwrap_or_default();
    let text = occt(ffi::xde_write(
        pinned,
        request.schema,
        request.unit,
        request.file_name,
        request.timestamp,
        request.originating_system,
        request.root_name,
        &validation,
    ))?;
    Ok((!text.is_empty()).then_some(text))
}

fn parsed(text: Result<String, cxx::Exception>) -> OcctResult<Value> {
    let text = occt(text)?;
    serde_json::from_str(&text).map_err(|error| format!("exchange facade answered unreadable JSON: {error}"))
}

/// `importExchange`: the STEP product tree (products, occurrences, healed solids with names and colours) or `{ error, detail }`.
pub fn import_exchange(text: &str, options: ImportOptions) -> OcctResult<Value> {
    parsed(ffi::xde_import_json(text, options.precision, options.max_tolerance, options.heal, options.sew))
}

/// Whether this build holds the IGES translator (TKDEIGES).
pub fn iges_available() -> bool {
    ffi::iges_available()
}

/// `importShapes('iges', …)`: IGES read, sewing at max(`file_resolution`, 1e-6 * diagonal), healing; same shape as the STEP import answer.
pub fn import_iges(text: &str, options: ImportOptions, file_resolution: f64) -> OcctResult<Value> {
    parsed(ffi::iges_import_json(text, options.precision, options.max_tolerance, options.heal, options.sew, file_resolution))
}

/// IGES 5.3 text of every solid of `products` (world space, document `unit`); `None` when nothing could be written.
pub fn export_iges(products: &[ExchangeProduct<'_>], brep_mode: bool, unit: &str) -> OcctResult<Option<String>> {
    let mut doc = build(products, &[])?;
    let Some(pinned) = doc.as_mut() else { return Err(NOT_CREATED.to_string()) };
    let text = occt(ffi::iges_write(pinned, brep_mode, unit))?;
    Ok((!text.is_empty()).then_some(text))
}

#[cfg(test)]
#[path = "xde_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "xde_pmi_tests.rs"]
mod pmi_tests;
