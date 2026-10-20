//! Readers (TECHNICAL_SPEC §5.1, §5.2, §6): format detection by signature then extension, proprietary refusal, one entry point.

pub mod ascii;
pub mod e57;
pub mod las;

use crate::cloud::{Format, RawCloud};
use crate::error::{CloudError, CloudResult};
use e57::ChecksumPolicy;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Import options; they are part of the asset key (TR-SCN-01), so every field has a fixed default.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportOptions {
    /// Forces an ASCII flavour (`xyz`, `pts`, `csv`); binary formats are detected from their signature.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<Format>,
    /// Unit of ASCII coordinates (m, mm, cm, ft, in). Binary formats are metres.
    #[serde(default = "metre")]
    pub source_unit: String,
    /// ASCII column order (x y z i r g b, `_` skips).
    #[serde(default = "xyz")]
    pub columns: String,
    /// E57: apply each scan's pose (default true).
    #[serde(default = "yes")]
    pub apply_station_poses: bool,
    /// E57 page CRC policy.
    #[serde(default)]
    pub checksum: ChecksumPolicy,
    /// Octree: most points kept by one node (default 20 000).
    #[serde(default = "max_points_per_node")]
    pub max_points_per_node: u32,
}

fn metre() -> String {
    "m".to_string()
}
fn xyz() -> String {
    "xyz".to_string()
}
fn yes() -> bool {
    true
}
fn max_points_per_node() -> u32 {
    20_000
}

impl Default for ImportOptions {
    fn default() -> ImportOptions {
        ImportOptions {
            format: None,
            source_unit: metre(),
            columns: xyz(),
            apply_station_poses: true,
            checksum: ChecksumPolicy::All,
            max_points_per_node: max_points_per_node(),
        }
    }
}

/// Extensions of closed vendor formats (no public specification): refused with `SCN_FORMAT_PROPRIETARY` (FR-SCN-11).
pub const PROPRIETARY_EXTENSIONS: [&str; 9] = ["rcp", "rcs", "fls", "fws", "lsproj", "ptg", "zfs", "imp", "x3a"];

fn extension(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// The format of `path`: signature first (`ASTM-E57`, `LASF`), then the extension.
/// @failure proprietary extension -> SCN_FORMAT_PROPRIETARY; anything else unknown -> SCN_FORMAT_UNSUPPORTED
pub fn detect(path: &Path, forced: Option<Format>) -> CloudResult<Format> {
    let ext = extension(path);
    if PROPRIETARY_EXTENSIONS.contains(&ext.as_str()) {
        return Err(CloudError::new(
            "SCN_FORMAT_PROPRIETARY",
            format!(".{ext} is a closed vendor format: export E57 (or LAS) from the vendor tool, e.g. ReCap -> Export -> E57"),
        ));
    }
    let mut signature = [0u8; 8];
    let read = File::open(path).and_then(|mut f| f.read(&mut signature)).map_err(|error| CloudError::io(path, &error))?;
    if read >= 8 && &signature == b"ASTM-E57" {
        return Ok(Format::E57);
    }
    if read >= 4 && &signature[..4] == b"LASF" {
        return Ok(if ext == "laz" { Format::Laz } else { Format::Las });
    }
    if let Some(format @ (Format::Xyz | Format::Pts | Format::Csv)) = forced {
        return Ok(format);
    }
    match ext.as_str() {
        "xyz" | "txt" | "asc" => Ok(Format::Xyz),
        "pts" => Ok(Format::Pts),
        "csv" => Ok(Format::Csv),
        "e57" | "las" | "laz" => {
            Err(CloudError::new("SCN_FORMAT_UNSUPPORTED", format!("the .{ext} file does not carry its format signature")))
        }
        _ => Err(CloudError::new("SCN_FORMAT_UNSUPPORTED", format!("unknown point-cloud format '.{ext}': convert to E57, LAS or LAZ"))),
    }
}

/// Reads `path` into memory.
/// @failure format codes of `detect` and the readers; no valid point -> SCN_CLOUD_EMPTY
pub fn read(path: &Path, options: &ImportOptions) -> CloudResult<RawCloud> {
    let format = detect(path, options.format)?;
    let cloud = match format {
        Format::E57 => e57::read(path, options)?,
        Format::Las | Format::Laz => las::read(path, ascii::unit_scale(&options.source_unit)?)?,
        Format::Xyz | Format::Pts | Format::Csv => ascii::read(path, format, &options.columns, &options.source_unit)?,
    };
    if cloud.is_empty() {
        return Err(CloudError::new("SCN_CLOUD_EMPTY", format!("{} holds no valid point ({} scans)", path.display(), cloud.scans.len())));
    }
    Ok(cloud)
}
