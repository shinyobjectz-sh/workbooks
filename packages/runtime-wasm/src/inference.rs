//! Candle inference cell dispatcher — runs ML model inference in WASM.
//!
//! Cell language: `CELL_LANGUAGE_CANDLE_INFERENCE`. Spec declares a model
//! reference (from manifest.runtime.modelArtifacts) plus input binding
//! and output spec.
//!
//! Status: P4.1 scaffold. Candle-core + candle-nn link in when the
//! `candle` feature is enabled. The smoke-test path proves the toolchain
//! works — instantiate a tensor, run a basic op, return the result.
//! Full model-loading + inference (using the modelArtifactResolver
//! cache from the JS side) lands incrementally; this scaffold unblocks
//! that work by proving Candle compiles to wasm32 with the rest of the
//! runtime.

use crate::outputs::CellOutput;
use candle_core::{Device, Tensor};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceCellRequest {
    pub spec: serde_json::Value,
    #[serde(default)]
    pub params: serde_json::Value,
}

pub fn run_inference_cell(_req: InferenceCellRequest) -> Result<Vec<CellOutput>, String> {
    Err("candle-inference cell dispatcher: full model pipeline not yet wired (P4.1+)".into())
}

/// Smoke-test entry — proves Candle is alive in the WASM bundle by doing
/// a trivial tensor operation. Returns the result as a stringified vec.
///
/// Used by the future `examples/candle-smoke/` demo and by P4.7 benchmarks
/// to capture the cold-start cost of Candle initialization separately
/// from the cost of actual model loading.
#[wasm_bindgen(js_name = candleSmokeTest)]
pub fn candle_smoke_test() -> Result<JsValue, JsValue> {
    let device = Device::Cpu;
    let a = Tensor::new(&[1.0f32, 2.0, 3.0, 4.0], &device)
        .map_err(|e| JsValue::from_str(&format!("tensor: {e}")))?;
    let b = Tensor::new(&[10.0f32, 20.0, 30.0, 40.0], &device)
        .map_err(|e| JsValue::from_str(&format!("tensor: {e}")))?;
    let sum = (&a + &b).map_err(|e| JsValue::from_str(&format!("add: {e}")))?;
    let values: Vec<f32> = sum
        .to_vec1::<f32>()
        .map_err(|e| JsValue::from_str(&format!("to_vec1: {e}")))?;

    let outputs = vec![CellOutput::Text {
        content: format!("{values:?}"),
        mime_type: Some("text/plain".into()),
    }];
    serde_wasm_bindgen::to_value(&outputs).map_err(Into::into)
}
