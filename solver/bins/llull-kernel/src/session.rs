//! One kernel session: the `KernelOps` request vocabulary of `server/src/occtWorkerProtocol.ts`, answered natively.
//!
//! Wire format (one JSON object per line, both directions; `docs/aerospace/01-exact-brep-kernel/TECHNICAL_SPEC.md` §13.D):
//! request `{"id": n, "op": "<op>", "args": [...]}`, reply `{"id": n, "result": <value|null>, "error"?: "<CODE>: <message>"}`.
//! Shapes travel as handles `{"key": "<host recipe key>", "recipe"?: <ShapeRecipe>}`; a key-only handle whose shape is gone answers
//! `shape not cached: <key>` (the host resends the recipe). `tessellate` returns `{"encoding": "base64-le", "positions": <f64[]>,
//! "indices": <u32[]>}`. Error codes: `NATIVE_UNSUPPORTED` (op / recipe node not native yet: the host falls back), `NATIVE_BAD_REQUEST`,
//! `NATIVE_OCC_FAILURE` (OCCT threw; result null), `NATIVE_PANIC`.

use crate::queries::{self, QUERY_CAPABILITIES, QUERY_OPS};
use base64::Engine;
use llull_kernel_occt::lru::Lru;
use llull_kernel_occt::recipe::{EvalError, Evaluator, RECIPE_OPS, SOLID_KINDS};
use llull_kernel_occt::{analyze, export_step, mass_properties, mesh::display_mesh, occt_version, Shape};
use serde_json::{json, Value};
use std::rc::Rc;

pub const UNSUPPORTED: &str = "NATIVE_UNSUPPORTED";
pub const BAD_REQUEST: &str = "NATIVE_BAD_REQUEST";
pub const OCC_FAILURE: &str = "NATIVE_OCC_FAILURE";
pub const PANIC: &str = "NATIVE_PANIC";
/// Same prefix as `SHAPE_NOT_CACHED` in `packages/core/src/geometry/shapeKernel.ts`.
pub const NOT_CACHED: &str = "shape not cached";

/// Operations answered natively besides `queries::QUERY_OPS`; every other op replies `NATIVE_UNSUPPORTED`.
pub const OPS: [&str; 7] = ["info", "evaluate", "tessellate", "massProperties", "analyze", "exportStep", "exportIges"];

/// Every op the session answers (`info().ops`).
pub fn native_ops() -> Vec<&'static str> {
    OPS.iter().chain(QUERY_OPS.iter()).copied().collect()
}

/// Shapes kept alive by recipe (sub-recipes) and by host key (handles).
const CAPACITY: usize = 256;

pub struct Reply {
    pub result: Value,
    pub error: Option<String>,
}

impl Reply {
    pub fn ok(result: Value) -> Self {
        Self { result, error: None }
    }

    pub fn fail(code: &str, message: impl std::fmt::Display) -> Self {
        Self { result: Value::Null, error: Some(format!("{code}: {message}")) }
    }
}

enum HandleState {
    Built(Option<Rc<Shape>>),
    Unsupported(String),
}

pub struct Session {
    evaluator: Evaluator,
    handles: Lru<HandleState>,
}

fn base64_of<T: Copy, const N: usize>(values: &[T], bytes: impl Fn(T) -> [u8; N]) -> String {
    let raw: Vec<u8> = values.iter().flat_map(|value| bytes(*value)).collect();
    base64::engine::general_purpose::STANDARD.encode(raw)
}

fn bounds_json(values: &[f64]) -> Value {
    match values {
        [x0, y0, z0, x1, y1, z1] => json!({ "min": [x0, y0, z0], "max": [x1, y1, z1] }),
        _ => Value::Null,
    }
}

fn info() -> Value {
    let capabilities: Vec<&str> = ["analyze", "massProperties", "exportStep", "exportIges"].into_iter().chain(QUERY_CAPABILITIES).collect();
    json!({
        "occtVersion": occt_version(),
        "build": format!("llull-kernel@{}", env!("CARGO_PKG_VERSION")),
        "capabilities": capabilities,
        "ops": native_ops(),
        "recipeOps": RECIPE_OPS,
        "solidKinds": SOLID_KINDS,
    })
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Self {
        Self { evaluator: Evaluator::new(CAPACITY), handles: Lru::new(CAPACITY) }
    }

    /// Answers one request line; the reply always carries the request id (null when unreadable).
    pub fn handle_line(&mut self, line: &str) -> Value {
        let request: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => return reply_json(Value::Null, Reply::fail(BAD_REQUEST, format!("unreadable request: {error}"))),
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let op = request.get("op").and_then(Value::as_str).unwrap_or("").to_string();
        let args = request.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.dispatch(&op, &args)));
        let reply = outcome.unwrap_or_else(|_| Reply::fail(PANIC, format!("{op} panicked")));
        reply_json(id, reply)
    }

    fn dispatch(&mut self, op: &str, args: &[Value]) -> Reply {
        let first = args.first().unwrap_or(&Value::Null);
        match op {
            "info" => Reply::ok(info()),
            "evaluate" => self.with_shape(first, |_| Ok(json!({ "key": first.get("key") }))),
            "tessellate" => self.with_shape(first, |shape| {
                Ok(display_mesh(shape)?.map_or(Value::Null, |mesh| {
                    json!({
                        "encoding": "base64-le",
                        "positions": base64_of(&mesh.positions, f64::to_le_bytes),
                        "indices": base64_of(&mesh.indices, u32::to_le_bytes),
                    })
                }))
            }),
            "massProperties" => self.with_shape(first, |shape| {
                let mass = mass_properties(shape)?;
                let finite = [mass.volume, mass.area].iter().chain(&mass.centroid).chain(&mass.inertia).all(|value| value.is_finite());
                if !finite || mass.volume <= 0.0 {
                    return Ok(Value::Null);
                }
                let mut result = json!({
                    "volume": mass.volume,
                    "area": mass.area,
                    "centroid": mass.centroid,
                    "inertiaAtCentroid": mass.inertia,
                    "bounds": bounds_json(&mass.bounds),
                });
                if mass.rel_error.is_finite() && mass.rel_error >= 0.0 {
                    result["relError"] = json!(mass.rel_error);
                }
                Ok(result)
            }),
            "analyze" => self.with_shape(first, |shape| {
                let report = analyze(shape)?;
                let lumps: Vec<Value> = report
                    .lumps
                    .chunks_exact(8)
                    .map(|lump| json!({ "volume": lump[0], "area": lump[1], "bounds": bounds_json(&lump[2..]) }))
                    .collect();
                let volume: f64 = report.lumps.chunks_exact(8).map(|lump| lump[0]).sum();
                Ok(json!({
                    "valid": report.valid,
                    "status": if report.valid { "valid" } else { "BRepCheck_Analyzer reports an invalid shape" },
                    "closed": report.valid && report.solids > 0 && report.free_faces == 0 && report.free_edges == 0,
                    "volume": volume,
                    "area": report.area,
                    "lumps": lumps,
                    "freeFaces": report.free_faces,
                }))
            }),
            "exportStep" => self.export_with(first, "exportStep", export_step),
            "exportIges" => self.export_with(first, "exportIges", llull_kernel_occt::features::export_iges),
            other => queries::dispatch(self, other, args).unwrap_or_else(|| Reply::fail(UNSUPPORTED, format!("op '{other}'"))),
        }
    }

    /// `exportStep` / `exportIges`: the exchange text of the resolved handles, null when one is refused or the writer refuses.
    fn export_with(&mut self, handles: &Value, op: &str, write: fn(&[&Shape]) -> Result<Option<String>, String>) -> Reply {
        let Some(list) = handles.as_array() else { return Reply::fail(BAD_REQUEST, format!("{op} expects [handles]")) };
        let mut shapes = Vec::with_capacity(list.len());
        for handle in list {
            match self.resolve(handle) {
                Ok(Some(shape)) => shapes.push(shape),
                Ok(None) => return Reply::ok(Value::Null),
                Err(reply) => return reply,
            }
        }
        let borrowed: Vec<&Shape> = shapes.iter().map(Rc::as_ref).collect();
        match write(&borrowed) {
            Ok(text) => Reply::ok(text.map_or(Value::Null, Value::String)),
            Err(error) => Reply::fail(OCC_FAILURE, error),
        }
    }

    /// Keeps a document blob for `brep` leaves and forgets refused handles (one may have been "blob missing"); false on a hash mismatch.
    pub fn load_blob(&mut self, sha256: &str, text: &str) -> bool {
        let loaded = self.evaluator.load_blob(sha256, text);
        if loaded {
            self.handles.retain(|state| !matches!(state, HandleState::Built(None)));
        }
        loaded
    }

    /// Runs `query` on the handle's shape; a refused shape answers null, an OCCT throw `NATIVE_OCC_FAILURE`.
    pub fn with_shape(&mut self, handle: &Value, query: impl FnOnce(&Shape) -> Result<Value, String>) -> Reply {
        match self.resolve(handle) {
            Ok(Some(shape)) => match query(&shape) {
                Ok(result) => Reply::ok(result),
                Err(error) => Reply::fail(OCC_FAILURE, error),
            },
            Ok(None) => Reply::ok(Value::Null),
            Err(reply) => reply,
        }
    }

    pub fn resolve(&mut self, handle: &Value) -> Result<Option<Rc<Shape>>, Reply> {
        let Some(key) = handle.get("key").and_then(Value::as_str).map(str::to_string) else {
            return Err(Reply::fail(BAD_REQUEST, "a shape handle needs a string key"));
        };
        let Some(recipe) = handle.get("recipe") else {
            return match self.handles.get(&key) {
                None => Err(Reply::fail(NOT_CACHED, &key)),
                Some(HandleState::Unsupported(reason)) => Err(Reply::fail(UNSUPPORTED, reason)),
                Some(HandleState::Built(shape)) => Ok(shape.clone()),
            };
        };
        match self.evaluator.evaluate(recipe) {
            Ok(shape) => {
                self.handles.insert(key, HandleState::Built(shape.clone()));
                Ok(shape)
            }
            Err(EvalError::Unsupported(reason)) => {
                self.handles.insert(key, HandleState::Unsupported(reason.clone()));
                Err(Reply::fail(UNSUPPORTED, reason))
            }
            Err(EvalError::Failure(error)) => {
                self.handles.insert(key, HandleState::Built(None));
                Err(Reply::fail(OCC_FAILURE, error))
            }
        }
    }
}

fn reply_json(id: Value, reply: Reply) -> Value {
    let mut out = json!({ "id": id, "result": reply.result });
    if let Some(error) = reply.error {
        out["error"] = Value::String(error);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_recipe(size: f64) -> Value {
        json!({ "op": "solid", "entity": { "id": "b", "kind": "box", "position": [0, 0, 0], "rotation": [0, 0, 0], "size": [size, size, size] } })
    }

    fn call(session: &mut Session, op: &str, args: Value) -> Value {
        session.handle_line(&json!({ "id": 7, "op": op, "args": args }).to_string())
    }

    #[test]
    fn evaluates_then_answers_key_only_handles() {
        let mut session = Session::new();
        let evaluated = call(&mut session, "evaluate", json!([{ "key": "k1", "recipe": box_recipe(2.0) }]));
        assert_eq!(evaluated, json!({ "id": 7, "result": { "key": "k1" } }));
        let mass = call(&mut session, "massProperties", json!([{ "key": "k1" }]));
        assert!((mass["result"]["volume"].as_f64().unwrap() - 8.0).abs() < 1e-9);
        let mesh = call(&mut session, "tessellate", json!([{ "key": "k1" }]));
        let indices = base64::engine::general_purpose::STANDARD.decode(mesh["result"]["indices"].as_str().unwrap()).unwrap();
        assert_eq!(indices.len(), 36 * 4);
    }

    #[test]
    fn a_forgotten_key_asks_for_the_recipe() {
        let mut session = Session::new();
        let reply = call(&mut session, "tessellate", json!([{ "key": "missing" }]));
        assert_eq!(reply["error"], json!("shape not cached: missing"));
        assert_eq!(reply["result"], Value::Null);
    }

    #[test]
    fn unsupported_ops_and_recipes_name_the_gap() {
        let mut session = Session::new();
        assert_eq!(call(&mut session, "frobnicate", json!([]))["error"], json!("NATIVE_UNSUPPORTED: op 'frobnicate'"));
        let feature = json!({ "op": "feature", "source": box_recipe(1.0) });
        let reply = call(&mut session, "evaluate", json!([{ "key": "f", "recipe": feature }]));
        assert_eq!(reply["error"], json!("NATIVE_UNSUPPORTED: recipe op 'feature'"));
        assert_eq!(call(&mut session, "tessellate", json!([{ "key": "f" }]))["error"], reply["error"]);
    }

    #[test]
    fn reports_bad_requests_and_info() {
        let mut session = Session::new();
        assert!(session.handle_line("not json")["error"].as_str().unwrap().starts_with(BAD_REQUEST));
        assert!(call(&mut session, "evaluate", json!([{}]))["error"].as_str().unwrap().starts_with(BAD_REQUEST));
        let described = call(&mut session, "info", json!([]));
        assert_eq!(described["result"]["occtVersion"], json!("7.9.2"));
        assert_eq!(described["result"]["ops"], json!(native_ops()));
    }

    #[test]
    fn analyzes_and_writes_step() {
        let mut session = Session::new();
        let report = call(&mut session, "analyze", json!([{ "key": "a", "recipe": box_recipe(1.0) }]));
        assert_eq!(report["result"]["closed"], json!(true));
        assert_eq!(report["result"]["lumps"].as_array().map(Vec::len), Some(1));
        let step = call(&mut session, "exportStep", json!([[{ "key": "a" }]]));
        assert!(step["result"].as_str().unwrap().starts_with("ISO-10303-21;"));
    }
}
