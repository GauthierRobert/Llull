//! Job folder IO: little-endian f64 / u32 files and the error type (contract of `llull-geomq`).

use llull_protocol::{sha256_hex, Output};
use std::fs;
use std::path::Path;

/// A job failure: stable code + message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

pub fn input_error(message: impl Into<String>) -> JobError {
    JobError { code: "NATIVE_JOB_INPUT", message: message.into() }
}

fn read_bytes(folder: &Path, name: &str) -> Result<Vec<u8>, JobError> {
    let path = folder.join(name);
    fs::read(&path).map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })
}

pub fn read_f64(folder: &Path, name: &str) -> Result<Vec<f64>, JobError> {
    let bytes = read_bytes(folder, name)?;
    if !bytes.len().is_multiple_of(8) {
        return Err(input_error(format!("{name}: {} bytes is not a whole number of f64", bytes.len())));
    }
    Ok(bytes.chunks_exact(8).map(|b| f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])).collect())
}

pub fn read_u32(folder: &Path, name: &str) -> Result<Vec<u32>, JobError> {
    let bytes = read_bytes(folder, name)?;
    if !bytes.len().is_multiple_of(4) {
        return Err(input_error(format!("{name}: {} bytes is not a whole number of u32", bytes.len())));
    }
    Ok(bytes.chunks_exact(4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

pub fn write_file(folder: &Path, name: &str, bytes: &[u8]) -> Result<Output, JobError> {
    let path = folder.join(name);
    fs::write(&path, bytes).map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })?;
    Ok(Output { path: name.to_string(), sha256: sha256_hex(bytes) })
}

pub fn f64_bytes(values: &[f64]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

pub fn u32_bytes(values: &[u32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_rejects_ragged_files() {
        let dir = std::env::temp_dir().join(format!("llull-field-files-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        write_file(&dir, "a.f64", &f64_bytes(&[1.5, -2.0])).unwrap();
        write_file(&dir, "b.u32", &u32_bytes(&[7, 9])).unwrap();
        write_file(&dir, "ragged.f64", &[1, 2, 3]).unwrap();
        write_file(&dir, "ragged.u32", &[1, 2, 3]).unwrap();
        assert_eq!(read_f64(&dir, "a.f64").unwrap(), vec![1.5, -2.0]);
        assert_eq!(read_u32(&dir, "b.u32").unwrap(), vec![7, 9]);
        assert_eq!(read_f64(&dir, "ragged.f64").unwrap_err().code, "NATIVE_JOB_INPUT");
        assert_eq!(read_u32(&dir, "ragged.u32").unwrap_err().code, "NATIVE_JOB_INPUT");
        assert_eq!(read_f64(&dir, "missing.f64").unwrap_err().code, "NATIVE_JOB_IO");
        fs::remove_dir_all(&dir).unwrap();
    }
}
