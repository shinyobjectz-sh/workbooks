//! Rhai cell dispatcher — orchestrates calls into the WASM runtime.
//!
//! Cell language: `CELL_LANGUAGE_RHAI`. Source is a Rhai script. In the full
//! P3 implementation, the runtime exposes functions (load, run_polars,
//! run_inference, …) that the script binds into the cell's `provides` set.
//!
//! Today: a smoke-test path that evaluates an expression and returns the
//! result. Lets us prove the JS bridge end-to-end before P3 wiring lands.

use crate::outputs::CellOutput;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RhaiCellRequest {
    pub source: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// Evaluate a Rhai script and return the result as a stringified value.
pub fn run_rhai_cell(req: RhaiCellRequest) -> Result<Vec<CellOutput>, String> {
    let engine = rhai::Engine::new();
    let result: rhai::Dynamic = engine
        .eval(&req.source)
        .map_err(|e| format!("rhai eval error: {e}"))?;

    let rendered = stringify_dynamic(&result);
    Ok(vec![CellOutput::Text {
        content: rendered,
        mime_type: Some("text/plain".into()),
    }])
}

fn stringify_dynamic(value: &rhai::Dynamic) -> String {
    if value.is_unit() {
        return "()".into();
    }
    if let Some(b) = value.clone().try_cast::<bool>() {
        return b.to_string();
    }
    if let Some(i) = value.clone().try_cast::<i64>() {
        return i.to_string();
    }
    if let Some(f) = value.clone().try_cast::<f64>() {
        return f.to_string();
    }
    if let Some(s) = value.clone().try_cast::<String>() {
        return s;
    }
    format!("{value:?}")
}

/// JS-bridge entry — `runRhai(source)` returns the cell outputs as a JS array.
#[wasm_bindgen(js_name = runRhai)]
pub fn run_rhai_js(source: String) -> Result<JsValue, JsValue> {
    let req = RhaiCellRequest {
        source,
        params: serde_json::Value::Null,
    };
    let outputs = run_rhai_cell(req).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&outputs).map_err(Into::into)
}
