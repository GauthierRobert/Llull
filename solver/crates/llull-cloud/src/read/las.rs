//! LAS 1.0–1.4 / LAZ reader (TECHNICAL_SPEC §5.2) on the `las` crate (MIT) with the `laz` feature (laz-rs, Apache-2.0). The raw record
//! integers are kept as the asset codes (x = X·scale + offset, the crate's own formula), so a LAS / LAZ source is stored losslessly. The
//! bounds are recomputed from the decoded records; a header that disagrees by more than one quantum warns `SCN_LAS_HEADER_BOUNDS`.

use crate::cloud::{Attributes, Bounds, Crs, Format, Pose, RawCloud, ScanInfo, SourceGrid, SourceInfo, Warning};
use crate::error::{CloudError, CloudResult};
use las::Reader;
use std::path::Path;

fn header_error(error: las::Error) -> CloudError {
    CloudError::new("SCN_LAS_HEADER", error.to_string())
}

/// LAS dimensions present in point format `format` (the names laspy uses).
fn dimension_names(format: &las::point::Format) -> Vec<String> {
    let mut names: Vec<&str> = vec!["X", "Y", "Z", "intensity", "return_number", "number_of_returns"];
    if format.is_extended {
        names.push("scanner_channel");
    }
    names.extend(["scan_direction_flag", "edge_of_flight_line", "classification", "synthetic", "key_point", "withheld"]);
    if format.is_extended {
        names.push("overlap");
    }
    names.extend(["scan_angle", "user_data", "point_source_id"]);
    if format.has_gps_time {
        names.push("gps_time");
    }
    if format.has_color {
        names.extend(["red", "green", "blue"]);
    }
    if format.has_nir {
        names.push("nir");
    }
    if format.has_waveform {
        names.push("waveform");
    }
    names.into_iter().map(String::from).collect()
}

fn crs_of(header: &las::Header) -> Option<Crs> {
    if let Some(bytes) = header.get_wkt_crs_bytes() {
        let wkt = String::from_utf8_lossy(bytes).trim_end_matches('\0').trim().to_string();
        if !wkt.is_empty() {
            return Some(Crs { wkt: Some(wkt), epsg: None });
        }
    }
    let geotiff = header.get_geotiff_crs().ok().flatten()?;
    let epsg = geotiff.get_projected_crs_geo_key_value().or_else(|| geotiff.get_geodetic_crs_geo_key_value())?;
    Some(Crs { wkt: None, epsg: Some(u32::from(epsg)) })
}

/// Reads a LAS or LAZ file (the crate detects compression from the point format bit 7).
/// @failure not LAS 1.0–1.4 / bad record length -> SCN_LAS_HEADER; decoding failure -> SCN_LAS_HEADER with the crate's message
/// `metres_per_unit` converts a non-metric CRS (e.g. 0.3048 for feet): the grid becomes (scale·f, offset·f), so the codes stay exact; at
/// 1.0 the positions are the crate's own X·scale + offset, bit for bit.
pub fn read(path: &Path, metres_per_unit: f64) -> CloudResult<RawCloud> {
    let mut reader = Reader::from_path(path).map_err(header_error)?;
    let header = reader.header().clone();
    let compressed = header.point_format().is_compressed;
    let transforms = *header.transforms();
    let file_scale = [transforms.x.scale, transforms.y.scale, transforms.z.scale];
    let file_offset = [transforms.x.offset, transforms.y.offset, transforms.z.offset];
    let f = metres_per_unit;
    let quantum = file_scale.map(|s| s * f);
    let offset = file_offset.map(|o| o * f);
    let data = reader.read_all().map_err(header_error)?;
    let count = data.len();
    if count as u64 != header.number_of_points() {
        return Err(CloudError::new(
            "SCN_LAS_HEADER",
            format!("the header announces {} points, the file holds {count}", header.number_of_points()),
        ));
    }
    let codes: Vec<[i64; 3]> =
        data.x_raw().zip(data.y_raw()).zip(data.z_raw()).map(|((x, y), z)| [i64::from(x), i64::from(y), i64::from(z)]).collect();
    let positions: Vec<[f64; 3]> = if f == 1.0 {
        codes
            .iter()
            .map(|c| [transforms.x.direct(c[0] as i32), transforms.y.direct(c[1] as i32), transforms.z.direct(c[2] as i32)])
            .collect()
    } else {
        codes.iter().map(|c| std::array::from_fn(|a| c[a] as f64 * quantum[a] + offset[a])).collect()
    };
    let format = header.point_format();
    let mut intensity = Vec::with_capacity(count);
    let mut classification = Vec::with_capacity(count);
    let mut return_number = Vec::with_capacity(count);
    let mut number_of_returns = Vec::with_capacity(count);
    let mut gps_time = Vec::with_capacity(if format.has_gps_time { count } else { 0 });
    let mut rgb16 = Vec::with_capacity(if format.has_color { count } else { 0 });
    for point in data.points() {
        let point = point.map_err(header_error)?;
        intensity.push(point.intensity);
        classification.push(u8::from(point.classification));
        return_number.push(point.return_number);
        number_of_returns.push(point.number_of_returns);
        if format.has_gps_time {
            gps_time.push(point.gps_time.unwrap_or(0.0));
        }
        if format.has_color {
            let c = point.color.unwrap_or_default();
            rgb16.push([c.red, c.green, c.blue]);
        }
    }
    // 16-bit colours are scaled down by 8 bits unless every channel already fits in 8 bits (common 0–255 writers).
    let eight_bit = rgb16.iter().all(|c| c.iter().all(|&v| v <= 255));
    let rgb = format.has_color.then(|| rgb16.iter().map(|c| c.map(|v| if eight_bit { v as u8 } else { (v >> 8) as u8 })).collect());
    let mut warnings = Vec::new();
    let header_bounds = header.bounds();
    let header_bounds = Bounds {
        min: [header_bounds.min.x * f, header_bounds.min.y * f, header_bounds.min.z * f],
        max: [header_bounds.max.x * f, header_bounds.max.y * f, header_bounds.max.z * f],
    };
    let crs = crs_of(&header);
    let wkt = crs.as_ref().and_then(|c| c.wkt.as_deref()).unwrap_or("").to_ascii_lowercase();
    if f == 1.0 && (wkt.contains("unit[\"foot") || wkt.contains("unit[\"us survey foot")) {
        warnings.push(Warning {
            code: "SCN_LAS_UNIT_FEET".into(),
            message: "the CRS declares feet but the cloud was imported as metres; re-import with sourceUnit=ft".into(),
        });
    }
    let data_bounds = Bounds::of(&positions);
    let disagrees = data_bounds.is_some_and(|b| {
        (0..3).any(|a| (b.min[a] - header_bounds.min[a]).abs() > quantum[a] || (b.max[a] - header_bounds.max[a]).abs() > quantum[a])
    });
    if disagrees {
        warnings.push(Warning {
            code: "SCN_LAS_HEADER_BOUNDS".into(),
            message: format!(
                "header bounds {:?}..{:?} disagree with the data; the bounds were recomputed",
                header_bounds.min, header_bounds.max
            ),
        });
    }
    let version = header.version();
    let source = SourceInfo {
        version_major: Some(u32::from(version.major)),
        version_minor: Some(u32::from(version.minor)),
        file_guid: Some(header.guid().to_string()),
        page_size: None,
        point_format: format.to_u8().ok(),
        point_record_length: Some(format.len()),
        vlr_count: Some(header.vlrs().len() as u32),
        evlr_count: Some(header.evlrs().len() as u32),
        scale: Some(file_scale),
        offset: Some(file_offset),
        generating_software: Some(header.generating_software().to_string()),
    };
    Ok(RawCloud {
        format: if compressed { Format::Laz } else { Format::Las },
        source,
        record_index: (0..count as u64).collect(),
        scans: vec![ScanInfo {
            guid: Some(header.guid().to_string()),
            name: Some(format!("LAS {}.{} PDRF {}", version.major, version.minor, format.to_u8().unwrap_or(0))),
            point_count: count as u64,
            record_count: count as u64,
            pose: Pose::IDENTITY,
            station_origin: None,
            fields: dimension_names(format),
        }],
        positions,
        codes: Some(codes),
        grid: Some(SourceGrid { quantum, offset }),
        attributes: Attributes {
            intensity: Some(intensity),
            rgb,
            classification: Some(classification),
            return_number: Some(return_number),
            number_of_returns: Some(number_of_returns),
            gps_time: format.has_gps_time.then_some(gps_time),
            normal: None,
        },
        header_bounds: disagrees.then_some(header_bounds),
        crs,
        warnings,
        dropped: 0,
    })
}
