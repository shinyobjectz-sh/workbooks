//! SQLite cell dispatcher — small structured state via rusqlite (bundled).
//!
//! Cell language: `CELL_LANGUAGE_SQLITE`. Source is a SQLite SQL string.
//! Use for small lookups, workbook config, key-value, structured state.
//! For analytical queries on real datasets reach for `polars` (lazy +
//! SQL frontend) or, when truly needed, opt-in `duckdb`.
//!
//! TODO P2.5+: wire rusqlite, accept Cell + params, return Arrow IPC.

use crate::outputs::CellOutput;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqliteCellRequest {
    pub source: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

pub fn run_sqlite_cell(_req: SqliteCellRequest) -> Result<Vec<CellOutput>, String> {
    Err("sqlite cell dispatcher not yet implemented (P2.5+)".into())
}
