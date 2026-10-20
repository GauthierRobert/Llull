//! ASCII XYZ / PTS / CSV reader (FR-SCN-03): a declared column order (`columns`, letters x y z i r g b, `_` skips a column) and a declared
//! source unit. Separators: comma, semicolon, tab or spaces. A first line that is not numeric is a header (CSV). PTS: the first line is
//! the point count and must match the records that follow (several `count` blocks, as Leica writes them, are accepted).

use crate::cloud::{Attributes, Format, Pose, RawCloud, ScanInfo};
use crate::error::{CloudError, CloudResult};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

/// Metres per source unit.
pub fn unit_scale(unit: &str) -> CloudResult<f64> {
    Ok(match unit {
        "m" => 1.0,
        "mm" => 0.001,
        "cm" => 0.01,
        "ft" => 0.3048,
        "in" => 0.0254,
        other => return Err(CloudError::input(format!("sourceUnit '{other}' is not one of m, mm, cm, ft, in"))),
    })
}

fn parse_error(line: usize, message: impl std::fmt::Display) -> CloudError {
    CloudError::new("SCN_ASCII_PARSE", format!("line {line}: {message}"))
}

fn fields(text: &str) -> Vec<&str> {
    text.split(|c: char| c == ',' || c == ';' || c.is_whitespace()).filter(|t| !t.is_empty()).collect()
}

/// Reads an ASCII cloud. `columns` like "xyz", "xyzi", "xyzrgb", "xyzirgb"; `i` is scaled to 16 bits from its observed range.
/// @failure unreadable number / too few columns / PTS count mismatch -> SCN_ASCII_PARSE; bad columns / unit -> NATIVE_JOB_INPUT
pub fn read(path: &Path, format: Format, columns: &str, unit: &str) -> CloudResult<RawCloud> {
    let scale = unit_scale(unit)?;
    let letters: Vec<char> = columns.chars().collect();
    let find = |c: char| letters.iter().position(|&l| l == c);
    let (Some(ix), Some(iy), Some(iz)) = (find('x'), find('y'), find('z')) else {
        return Err(CloudError::input(format!("columns '{columns}' must name x, y and z")));
    };
    if letters.iter().any(|c| !"xyzirgb_".contains(*c)) {
        return Err(CloudError::input(format!("columns '{columns}' may only use x y z i r g b _")));
    }
    let intensity_column = find('i');
    let rgb_columns = match (find('r'), find('g'), find('b')) {
        (Some(r), Some(g), Some(b)) => Some([r, g, b]),
        _ => None,
    };
    let file = File::open(path).map_err(|error| CloudError::io(path, &error))?;
    let mut positions = Vec::new();
    let mut raw_intensity = Vec::new();
    let mut rgb = Vec::new();
    let mut expected_in_block: Option<u64> = None;
    let mut in_block = 0u64;
    for (number, line) in BufReader::new(file).lines().enumerate() {
        let line_number = number + 1;
        let text = line.map_err(|error| CloudError::io(path, &error))?;
        let parts = fields(&text);
        if parts.is_empty() {
            continue;
        }
        if format == Format::Pts && parts.len() == 1 {
            if let Some(expected) = expected_in_block {
                if expected != in_block {
                    return Err(parse_error(line_number, format!("the PTS block announced {expected} points, {in_block} followed")));
                }
            }
            expected_in_block = Some(parts[0].parse().map_err(|_| parse_error(line_number, "a PTS count line must be an integer"))?);
            in_block = 0;
            continue;
        }
        let values: Result<Vec<f64>, _> = parts.iter().map(|p| p.parse::<f64>()).collect();
        let Ok(values) = values else {
            if positions.is_empty() && number == 0 {
                continue; // header line
            }
            return Err(parse_error(line_number, format!("'{}' is not a list of numbers", text.trim())));
        };
        if values.len() < letters.len() {
            return Err(parse_error(line_number, format!("{} values, columns '{columns}' need {}", values.len(), letters.len())));
        }
        let p = [values[ix] * scale, values[iy] * scale, values[iz] * scale];
        if !p.iter().all(|v| v.is_finite()) {
            return Err(parse_error(line_number, "a coordinate is not finite"));
        }
        positions.push(p);
        if let Some(i) = intensity_column {
            raw_intensity.push(values[i]);
        }
        if let Some([r, g, b]) = rgb_columns {
            rgb.push([values[r], values[g], values[b]].map(|v| v.round().clamp(0.0, 255.0) as u8));
        }
        in_block += 1;
    }
    if let Some(expected) = expected_in_block {
        if expected != in_block {
            return Err(CloudError::new("SCN_ASCII_PARSE", format!("the PTS block announced {expected} points, {in_block} followed")));
        }
    }
    let intensity = intensity_column.map(|_| {
        let (low, high) = raw_intensity.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &v| (a.min(v), b.max(v)));
        raw_intensity.iter().map(|&v| if high > low { ((v - low) / (high - low) * 65535.0).round() as u16 } else { 0 }).collect()
    });
    let count = positions.len() as u64;
    let field_names = letters.iter().map(|c| c.to_string()).collect();
    Ok(RawCloud {
        format,
        source: crate::cloud::SourceInfo::default(),
        record_index: (0..count).collect(),
        positions,
        codes: None,
        grid: None,
        attributes: Attributes { intensity, rgb: rgb_columns.map(|_| rgb), ..Attributes::default() },
        scans: vec![ScanInfo {
            guid: None,
            name: None,
            point_count: count,
            record_count: count,
            pose: Pose::IDENTITY,
            station_origin: None,
            fields: field_names,
        }],
        header_bounds: None,
        crs: None,
        warnings: Vec::new(),
        dropped: 0,
    })
}
