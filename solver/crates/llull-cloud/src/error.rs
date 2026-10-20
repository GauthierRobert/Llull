//! Stable failure codes of `llull-cloud` (plant 10 TECHNICAL_SPEC §7.2) plus the generic job codes of `llull-protocol`.

use std::fmt;
use std::path::Path;

/// A failure: stable code + one-line message. The host maps it to the agent-facing outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudError {
    pub code: &'static str,
    pub message: String,
}

impl CloudError {
    pub fn new(code: &'static str, message: impl Into<String>) -> CloudError {
        CloudError { code, message: message.into() }
    }

    pub fn input(message: impl Into<String>) -> CloudError {
        CloudError::new("NATIVE_JOB_INPUT", message)
    }

    pub fn io(path: &Path, error: &std::io::Error) -> CloudError {
        CloudError::new("NATIVE_JOB_IO", format!("{}: {error}", path.display()))
    }
}

impl fmt::Display for CloudError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

pub type CloudResult<T> = Result<T, CloudError>;
