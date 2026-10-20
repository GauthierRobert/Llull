//! Exchange ops of the session (XCH 04 M2..M4): `writeExchange` (STEP AP242 / AP214 / AP203 product tree through XDE, or IGES) and
//! `importExchange` (STEP product tree, IGES). Arguments and results are the `ExchangeWriteRequest` / `ImportExchangeResult` of
//! `@core/geometry/kernelExchange`; shape handles were rewritten by `server/src/native/kernelProtocol.ts` like every other op.

use crate::session::{Reply, Session, BAD_REQUEST, OCC_FAILURE};
use llull_kernel_occt::queries::ImportOptions;
use llull_kernel_occt::xde::{self, ExchangeProduct, ExchangeSolid, ExchangeUse, WriteRequest};
use llull_kernel_occt::Shape;
use serde_json::Value;
use std::collections::HashMap;
use std::rc::Rc;

/// Ops this module answers.
pub const EXCHANGE_OPS: [&str; 2] = ["writeExchange", "importExchange"];

/// `KernelInfo.capabilities` these ops add (`igesExchange` only when the build holds TKDEIGES).
pub fn capabilities() -> Vec<&'static str> {
    let mut capabilities = vec!["writeExchange", "importExchange"];
    if xde::iges_available() {
        capabilities.push("igesExchange");
    }
    capabilities
}

fn bad(message: impl std::fmt::Display) -> Reply {
    Reply::fail(BAD_REQUEST, message)
}

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or("")
}

fn triple(value: Option<&Value>) -> Option<[f64; 3]> {
    match value?.as_array()?.as_slice() {
        [x, y, z] => Some([x.as_f64()?, y.as_f64()?, z.as_f64()?]),
        _ => None,
    }
}

/// `{ volume, area, centroid }` as the five numbers the writer takes.
fn validation(value: Option<&Value>) -> Option<[f64; 5]> {
    let value = value?;
    let centroid = triple(value.get("centroid"))?;
    Some([value.get("volume")?.as_f64()?, value.get("area")?.as_f64()?, centroid[0], centroid[1], centroid[2]])
}

/// Answers `op` when it is an exchange op, else `None`.
pub fn dispatch(session: &mut Session, op: &str, args: &[Value]) -> Option<Reply> {
    let first = args.first().unwrap_or(&Value::Null);
    match op {
        "writeExchange" => Some(write_exchange(session, first)),
        "importExchange" => Some(import_exchange(args)),
        _ => None,
    }
}

fn schema_code(name: &str) -> Option<i32> {
    match name {
        "ap203" => Some(3),
        "ap214" => Some(4),
        "" | "ap242" => Some(5),
        _ => None,
    }
}

fn write_exchange(session: &mut Session, request: &Value) -> Reply {
    let (Some(products), Some(unit)) = (request.get("products").and_then(Value::as_array), request.get("unit").and_then(Value::as_str))
    else {
        return bad("writeExchange expects { products, occurrences, unit, header }");
    };
    let format = text(request, "format");
    let Some(schema) = schema_code(text(request, "schema")) else { return bad("schema must be 'ap242', 'ap214' or 'ap203'") };
    // every solid's shape first: the products borrow them
    let mut held: Vec<Vec<Rc<Shape>>> = Vec::with_capacity(products.len());
    for product in products {
        let Some(solids) = product.get("solids").and_then(Value::as_array) else { return bad("a product needs solids") };
        let mut shapes = Vec::with_capacity(solids.len());
        for solid in solids {
            match session.resolve(solid.get("shape").unwrap_or(&Value::Null)) {
                Ok(Some(shape)) => shapes.push(shape),
                Ok(None) => return Reply::ok(Value::Null),
                Err(reply) => return reply,
            }
        }
        held.push(shapes);
    }
    let mut index_of: HashMap<&str, usize> = HashMap::new();
    let mut listed: Vec<ExchangeProduct<'_>> = Vec::with_capacity(products.len());
    for (index, (product, shapes)) in products.iter().zip(&held).enumerate() {
        let key = text(product, "key");
        index_of.insert(key, index);
        let solids = product.get("solids").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        let material = product.get("material");
        listed.push(ExchangeProduct {
            name: text(product, "name").to_string(),
            description: text(product, "description").to_string(),
            color: text(product, "color").to_string(),
            layer: text(product, "layer").to_string(),
            material: material.map_or(String::new(), |value| text(value, "name").to_string()),
            density: material.and_then(|value| value.get("density")).and_then(Value::as_f64).unwrap_or(-1.0),
            solids: solids
                .iter()
                .zip(shapes)
                .map(|(solid, shape)| ExchangeSolid {
                    shape,
                    name: text(solid, "name").to_string(),
                    color: text(solid, "color").to_string(),
                })
                .collect(),
            validation: validation(product.get("validation")),
        });
    }
    let mut uses = Vec::new();
    for occurrence in request.get("occurrences").and_then(Value::as_array).map_or(&[][..], Vec::as_slice) {
        let parent = match occurrence.get("parent") {
            None | Some(Value::Null) => -1,
            Some(Value::String(key)) => match index_of.get(key.as_str()) {
                Some(index) => *index as i32,
                None => return bad(format!("occurrence parent '{key}' is not a product")),
            },
            Some(_) => return bad("an occurrence parent is a product key or null"),
        };
        let Some(product) = index_of.get(text(occurrence, "product")) else { return bad("an occurrence needs a known product key") };
        let (Some(position), Some(rotation)) = (triple(occurrence.get("position")), triple(occurrence.get("rotation"))) else {
            return bad("an occurrence needs position and rotation");
        };
        uses.push(ExchangeUse { parent, product: *product, name: text(occurrence, "name").to_string(), rotation, position });
    }
    let header = request.get("header").unwrap_or(&Value::Null);
    let answer = if format == "iges" {
        xde::export_iges(&listed, text(request, "igesMode") != "faces", unit)
    } else {
        xde::write_exchange(&WriteRequest {
            products: listed,
            uses,
            schema,
            unit,
            file_name: text(header, "fileName"),
            timestamp: text(header, "timestamp"),
            originating_system: text(header, "originatingSystem"),
            root_name: if text(request, "rootName").is_empty() { "Assembly" } else { text(request, "rootName") },
            root_validation: validation(request.get("rootValidation")),
        })
    };
    match answer {
        Ok(text) => Reply::ok(text.map_or(Value::Null, Value::String)),
        Err(error) => Reply::fail(OCC_FAILURE, error),
    }
}

fn import_exchange(args: &[Value]) -> Reply {
    let format = args.first().and_then(Value::as_str).unwrap_or("");
    let Some(content) = args.get(1).and_then(Value::as_str) else { return bad("importExchange expects (format, text, options)") };
    let options = args.get(2).unwrap_or(&Value::Null);
    let number = |field: &str| options.get(field).and_then(Value::as_f64);
    let flag = |field: &str| options.get(field).and_then(Value::as_bool);
    let (Some(precision), Some(max_tolerance), Some(heal), Some(sew)) =
        (number("precision"), number("maxTolerance"), flag("heal"), flag("sew"))
    else {
        return bad("importExchange expects { precision, maxTolerance, heal, sew }");
    };
    let import = ImportOptions { precision, max_tolerance, heal, sew };
    let answer = match format {
        "step" => xde::import_exchange(content, import),
        "iges" => xde::import_iges(content, import, number("fileResolutionMm").unwrap_or(0.0)),
        _ => return Reply::ok(Value::Null),
    };
    match answer {
        Ok(value) => Reply::ok(value),
        Err(error) => Reply::fail(OCC_FAILURE, error),
    }
}

#[cfg(test)]
#[path = "exchange_tests.rs"]
mod tests;
