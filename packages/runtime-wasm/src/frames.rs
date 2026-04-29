//! Polars cell dispatcher — runs LazyFrame chains against the data layer.
//!
//! Cell language: `CELL_LANGUAGE_POLARS`. Spec can be either:
//! - a JSON-encoded structured plan (preferred for agent-authored cells)
//! - a SQL string evaluated via Polars's SQL frontend (for the smoke-test
//!   path and SQL-style cells)
//!
//! Today (P2.2): SQL-frontend smoke-test path — `runPolarsSql(sql, csv)`
//! parses an inline CSV into a LazyFrame, registers it as `data`, runs the
//! SQL, and returns the result rendered as CSV. Full structured-plan
//! execution lands in P3.2.

use crate::outputs::CellOutput;
use polars::prelude::*;
use polars::sql::SQLContext;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolarsCellRequest {
    pub spec: serde_json::Value,
    #[serde(default)]
    pub params: serde_json::Value,
}

pub fn run_polars_cell(_req: PolarsCellRequest) -> Result<Vec<CellOutput>, String> {
    Err("polars structured-plan dispatcher not yet implemented (P3.2)".into())
}

/// JS-bridge entry — `runPolarsSql(sql, csv)` parses `csv` into a LazyFrame,
/// registers it as table `data`, evaluates the SQL, and returns the resulting
/// frame rendered back to CSV.
///
/// Used by the demo workbook to prove an end-to-end Polars round trip in
/// the browser (P2.5 gate).
#[wasm_bindgen(js_name = runPolarsSql)]
pub fn run_polars_sql(sql: String, csv: String) -> Result<JsValue, JsValue> {
    let outputs = run_polars_sql_inner(sql, csv).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&outputs).map_err(Into::into)
}

fn run_polars_sql_inner(sql: String, csv: String) -> Result<Vec<CellOutput>, String> {
    let lf = CsvReadOptions::default()
        .with_has_header(true)
        .into_reader_with_file_handle(Cursor::new(csv.into_bytes()))
        .finish()
        .map_err(|e| format!("polars csv parse: {e}"))?
        .lazy();

    let mut ctx = SQLContext::new();
    ctx.register("data", lf);

    let result = ctx
        .execute(&sql)
        .map_err(|e| format!("polars sql plan: {e}"))?
        .collect()
        .map_err(|e| format!("polars sql execute: {e}"))?;

    let mut buf = Vec::<u8>::new();
    CsvWriter::new(&mut buf)
        .finish(&mut result.clone())
        .map_err(|e| format!("polars csv encode: {e}"))?;
    let rendered = String::from_utf8(buf).map_err(|e| format!("polars csv utf8: {e}"))?;

    Ok(vec![CellOutput::Text {
        content: rendered,
        mime_type: Some("text/csv".into()),
    }])
}
