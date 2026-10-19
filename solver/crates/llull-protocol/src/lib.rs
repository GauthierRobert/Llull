//! Job protocol shared by `llull-compute` jobs (RS1 §2).
//!
//! A job runs in a folder prepared by the host: `job.json` in, result files out. Progress, warnings and the final
//! status go to stdout as one JSON object per line (NDJSON), so the host can stream them without parsing a log.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;

/// One NDJSON event on stdout.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event<'a> {
    /// `detail` (optional) adds job-specific fields to the same JSON object, e.g. `it`, `compliance`, `volume`, `change`.
    Progress {
        step: u64,
        total: u64,
        message: &'a str,
        #[serde(flatten, skip_serializing_if = "Option::is_none")]
        detail: Option<serde_json::Map<String, serde_json::Value>>,
    },
    Warning {
        code: &'a str,
        message: &'a str,
    },
    Done {
        ok: bool,
        outputs: Vec<Output>,
    },
    Error {
        code: &'a str,
        message: &'a str,
    },
}

/// A result file with its content hash, so the host can store it content-addressed.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct Output {
    pub path: String,
    pub sha256: String,
}

/// Writes one event as a single JSON line and flushes, so the host sees it immediately.
pub fn emit(out: &mut impl Write, event: &Event<'_>) -> std::io::Result<()> {
    serde_json::to_writer(&mut *out, event)?;
    out.write_all(b"\n")?;
    out.flush()
}

/// Lower-case hex sha256 of a byte slice.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_one_line_per_event() {
        let mut buffer = Vec::new();
        emit(&mut buffer, &Event::Progress { step: 1, total: 2, message: "half", detail: None }).unwrap();
        let mut detail = serde_json::Map::new();
        detail.insert("it".to_string(), serde_json::json!(1));
        emit(&mut buffer, &Event::Progress { step: 1, total: 2, message: "it", detail: Some(detail) }).unwrap();
        emit(&mut buffer, &Event::Done { ok: true, outputs: vec![] }).unwrap();
        let text = String::from_utf8(buffer).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines,
            [
                r#"{"type":"progress","step":1,"total":2,"message":"half"}"#,
                r#"{"type":"progress","step":1,"total":2,"message":"it","it":1}"#,
                r#"{"type":"done","ok":true,"outputs":[]}"#
            ]
        );
    }

    #[test]
    fn sha256_matches_the_known_empty_digest() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
}
