//! E57 reader (TECHNICAL_SPEC §5.1) on the `e57` crate (MIT): physical layer checked page by page here (CRC-32C, so the failing page
//! number reaches `SCN_E57_CHECKSUM`), XML and compressed vectors decoded by the crate's raw reader, values decoded here per prototype
//! record (ScaledInteger = raw·scale + offset by the crate), spherical → Cartesian with `libm`, poses applied with the unit-quaternion
//! check, invalid states dropped and counted.

use crate::cloud::{Attributes, Format, Pose, RawCloud, ScanInfo, SourceInfo, Vec3, Warning};
use crate::error::{CloudError, CloudResult};
use crate::read::ImportOptions;
use e57::{E57Reader, PointCloud, RecordDataType, RecordName, RecordValue};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// Checksum policy of the physical layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ChecksumPolicy {
    /// Every page (default).
    #[default]
    All,
    /// Every 16th page plus the first and the last (pages the crate reads are still checked by it).
    Sparse,
    /// No up-front pass (pages the crate reads are still checked by it).
    None,
}

/// CRC-32C (Castagnoli, reflected polynomial 0x82F63B78).
pub fn crc32c(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0x82F6_3B78 } else { crc >> 1 };
        }
    }
    !crc
}

/// Index of the first page whose stored big-endian CRC-32C does not match its payload, if any.
pub fn first_bad_page(path: &Path, policy: ChecksumPolicy) -> CloudResult<Option<u64>> {
    if policy == ChecksumPolicy::None {
        return Ok(None);
    }
    let mut file = File::open(path).map_err(|error| CloudError::io(path, &error))?;
    let length = file.metadata().map_err(|error| CloudError::io(path, &error))?.len();
    let mut header = [0u8; 48];
    file.read_exact(&mut header).map_err(|_| CloudError::new("SCN_E57_STRUCTURE", "the file is shorter than the 48-byte E57 header"))?;
    if &header[0..8] != b"ASTM-E57" {
        return Err(CloudError::new("SCN_E57_STRUCTURE", "the file does not start with the ASTM-E57 signature"));
    }
    let page_size = u64::from_le_bytes([header[40], header[41], header[42], header[43], header[44], header[45], header[46], header[47]]);
    if !(8..=1 << 24).contains(&page_size) || length % page_size != 0 {
        return Err(CloudError::new("SCN_E57_STRUCTURE", format!("page size {page_size} does not divide the file length {length}")));
    }
    let pages = length / page_size;
    let mut buffer = vec![0u8; page_size as usize];
    for page in 0..pages {
        let checked = policy == ChecksumPolicy::All || page % 16 == 0 || page + 1 == pages;
        if !checked {
            continue;
        }
        file.seek(SeekFrom::Start(page * page_size)).map_err(|error| CloudError::io(path, &error))?;
        file.read_exact(&mut buffer).map_err(|error| CloudError::io(path, &error))?;
        let split = buffer.len() - 4;
        let stored = u32::from_be_bytes([buffer[split], buffer[split + 1], buffer[split + 2], buffer[split + 3]]);
        if crc32c(&buffer[..split]) != stored {
            return Ok(Some(page));
        }
    }
    Ok(None)
}

fn structure(error: e57::Error) -> CloudError {
    CloudError::new("SCN_E57_STRUCTURE", error.to_string())
}

/// E57 tag name of a prototype record (extensions keep their own name, e.g. `normalX`, `pointSourceId`).
fn field_name(name: &RecordName) -> String {
    let text = match name {
        RecordName::CartesianX => "cartesianX",
        RecordName::CartesianY => "cartesianY",
        RecordName::CartesianZ => "cartesianZ",
        RecordName::CartesianInvalidState => "cartesianInvalidState",
        RecordName::SphericalRange => "sphericalRange",
        RecordName::SphericalAzimuth => "sphericalAzimuth",
        RecordName::SphericalElevation => "sphericalElevation",
        RecordName::SphericalInvalidState => "sphericalInvalidState",
        RecordName::Intensity => "intensity",
        RecordName::IsIntensityInvalid => "isIntensityInvalid",
        RecordName::ColorRed => "colorRed",
        RecordName::ColorGreen => "colorGreen",
        RecordName::ColorBlue => "colorBlue",
        RecordName::IsColorInvalid => "isColorInvalid",
        RecordName::RowIndex => "rowIndex",
        RecordName::ColumnIndex => "columnIndex",
        RecordName::ReturnCount => "returnCount",
        RecordName::ReturnIndex => "returnIndex",
        RecordName::TimeStamp => "timeStamp",
        RecordName::IsTimeStampInvalid => "isTimeStampInvalid",
        RecordName::Unknown { name, .. } => name,
    };
    text.to_string()
}

/// Positions of the named fields in the prototype.
struct Layout {
    names: Vec<String>,
    types: Vec<RecordDataType>,
}

impl Layout {
    fn of(pc: &PointCloud) -> Layout {
        Layout {
            names: pc.prototype.iter().map(|r| field_name(&r.name)).collect(),
            types: pc.prototype.iter().map(|r| r.data_type.clone()).collect(),
        }
    }

    fn index(&self, name: &str) -> Option<usize> {
        self.names.iter().position(|n| n == name)
    }

    fn triple(&self, a: &str, b: &str, c: &str) -> Option<[usize; 3]> {
        Some([self.index(a)?, self.index(b)?, self.index(c)?])
    }

    /// The numeric range of a field from its data type (for colour / intensity normalisation without limits).
    fn range(&self, index: usize) -> (f64, f64) {
        match &self.types[index] {
            RecordDataType::Single { min, max } => (f64::from(min.unwrap_or(0.0)), f64::from(max.unwrap_or(1.0))),
            RecordDataType::Double { min, max } => (min.unwrap_or(0.0), max.unwrap_or(1.0)),
            RecordDataType::ScaledInteger { min, max, scale, offset } => (*min as f64 * scale + offset, *max as f64 * scale + offset),
            RecordDataType::Integer { min, max } => (*min as f64, *max as f64),
        }
    }
}

fn value_f64(values: &[RecordValue], layout: &Layout, index: usize) -> CloudResult<f64> {
    values[index].to_f64(&layout.types[index]).map_err(structure)
}

fn limit(value: &Option<RecordValue>) -> Option<f64> {
    match value {
        Some(RecordValue::Single(v)) => Some(f64::from(*v)),
        Some(RecordValue::Double(v)) => Some(*v),
        Some(RecordValue::Integer(v)) | Some(RecordValue::ScaledInteger(v)) => Some(*v as f64),
        None => None,
    }
}

/// `value` mapped from [min, max] onto [0, top], rounded and clamped.
fn normalise(value: f64, (min, max): (f64, f64), top: f64) -> f64 {
    if max > min {
        ((value - min) / (max - min) * top).round().clamp(0.0, top)
    } else {
        0.0
    }
}

/// Reads every `data3D` of `path`.
/// @failure bad page CRC -> SCN_E57_CHECKSUM; unparsable header / XML / binary -> SCN_E57_STRUCTURE; non-unit quaternion -> SCN_E57_POSE_INVALID
pub fn read(path: &Path, options: &ImportOptions) -> CloudResult<RawCloud> {
    if let Some(page) = first_bad_page(path, options.checksum)? {
        return Err(CloudError::new("SCN_E57_CHECKSUM", format!("page {page}: CRC-32C mismatch")));
    }
    let file = File::open(path).map_err(|error| CloudError::io(path, &error))?;
    let mut reader = E57Reader::new(BufReader::new(file)).map_err(structure)?;
    let header = reader.header();
    let mut cloud = RawCloud {
        format: Format::E57,
        source: SourceInfo {
            version_major: Some(header.major),
            version_minor: Some(header.minor),
            file_guid: Some(reader.guid().to_string()),
            page_size: Some(header.page_size),
            ..SourceInfo::default()
        },
        positions: Vec::new(),
        codes: None,
        grid: None,
        record_index: Vec::new(),
        attributes: Attributes::default(),
        scans: Vec::new(),
        header_bounds: None,
        crs: reader
            .coordinate_metadata()
            .filter(|text| !text.trim().is_empty())
            .map(|wkt| crate::cloud::Crs { wkt: Some(wkt.to_string()), epsg: None }),
        warnings: Vec::new(),
        dropped: 0,
    };
    let pointclouds = reader.pointclouds();
    let mut wanted = Wanted::default();
    for pc in &pointclouds {
        let layout = Layout::of(pc);
        wanted.merge(&layout);
    }
    let mut columns = Columns::new(&wanted);
    let mut record_base = 0u64;
    for (scan_index, pc) in pointclouds.iter().enumerate() {
        let pose = match &pc.transform {
            Some(t) => Pose {
                rotation_wxyz: [t.rotation.w, t.rotation.x, t.rotation.y, t.rotation.z],
                translation: [t.translation.x, t.translation.y, t.translation.z],
            },
            None => Pose::IDENTITY,
        };
        let [w, x, y, z] = pose.rotation_wxyz;
        let norm = (w * w + x * x + y * y + z * z).sqrt();
        if (norm - 1.0).abs() > 1e-6 && options.apply_station_poses {
            return Err(CloudError::new("SCN_E57_POSE_INVALID", format!("data3D[{scan_index}]: quaternion norm {norm} is not 1")));
        }
        let layout = Layout::of(pc);
        let kept = read_scan(&mut reader, pc, &layout, &pose, options.apply_station_poses, record_base, &mut cloud, &mut columns)?;
        cloud.scans.push(ScanInfo {
            guid: pc.guid.clone(),
            name: pc.name.clone(),
            point_count: kept,
            record_count: pc.records,
            pose,
            station_origin: pc.transform.as_ref().map(|_| pose.translation),
            fields: layout.names.clone(),
        });
        record_base += pc.records;
    }
    cloud.attributes = columns.finish();
    if cloud.dropped > 0 {
        cloud.warnings.push(Warning {
            code: "SCN_E57_INVALID_DROPPED".into(),
            message: format!("{} records without a position were dropped", cloud.dropped),
        });
    }
    Ok(cloud)
}

/// Columns present in at least one scan (a scan without one fills it with zeros).
#[derive(Default)]
struct Wanted {
    intensity: bool,
    rgb: bool,
    return_number: bool,
    number_of_returns: bool,
    gps_time: bool,
    normal: bool,
}

impl Wanted {
    fn merge(&mut self, layout: &Layout) {
        self.intensity |= layout.index("intensity").is_some();
        self.rgb |= layout.triple("colorRed", "colorGreen", "colorBlue").is_some();
        self.return_number |= layout.index("returnIndex").is_some();
        self.number_of_returns |= layout.index("returnCount").is_some();
        self.gps_time |= layout.index("timeStamp").is_some();
        self.normal |= layout.triple("normalX", "normalY", "normalZ").is_some();
    }
}

struct Columns {
    intensity: Option<Vec<u16>>,
    rgb: Option<Vec<[u8; 3]>>,
    return_number: Option<Vec<u8>>,
    number_of_returns: Option<Vec<u8>>,
    gps_time: Option<Vec<f64>>,
    normal: Option<Vec<[f32; 3]>>,
}

impl Columns {
    fn new(wanted: &Wanted) -> Columns {
        Columns {
            intensity: wanted.intensity.then(Vec::new),
            rgb: wanted.rgb.then(Vec::new),
            return_number: wanted.return_number.then(Vec::new),
            number_of_returns: wanted.number_of_returns.then(Vec::new),
            gps_time: wanted.gps_time.then(Vec::new),
            normal: wanted.normal.then(Vec::new),
        }
    }

    fn finish(self) -> Attributes {
        Attributes {
            intensity: self.intensity,
            rgb: self.rgb,
            classification: None,
            return_number: self.return_number,
            number_of_returns: self.number_of_returns,
            gps_time: self.gps_time,
            normal: self.normal,
        }
    }
}

/// Prototype indices of red, green, blue and their value ranges.
type ColourFields = ([usize; 3], [(f64, f64); 3]);

struct ScanFields {
    cartesian: Option<[usize; 3]>,
    spherical: Option<[usize; 3]>,
    cartesian_invalid: Option<usize>,
    spherical_invalid: Option<usize>,
    intensity: Option<(usize, (f64, f64))>,
    rgb: Option<ColourFields>,
    return_index: Option<usize>,
    return_count: Option<usize>,
    time: Option<usize>,
    normal: Option<[usize; 3]>,
}

impl ScanFields {
    fn of(pc: &PointCloud, layout: &Layout) -> ScanFields {
        let intensity = layout.index("intensity").map(|i| {
            let limits = pc.intensity_limits.as_ref();
            let range = match limits.map(|l| (limit(&l.intensity_min), limit(&l.intensity_max))) {
                Some((Some(min), Some(max))) => (min, max),
                _ => layout.range(i),
            };
            (i, range)
        });
        let rgb = layout.triple("colorRed", "colorGreen", "colorBlue").map(|idx| {
            let limits = pc.color_limits.as_ref();
            let pick = |min: Option<f64>, max: Option<f64>, i: usize| match (min, max) {
                (Some(a), Some(b)) => (a, b),
                _ => layout.range(i),
            };
            let ranges = match limits {
                Some(l) => [
                    pick(limit(&l.red_min), limit(&l.red_max), idx[0]),
                    pick(limit(&l.green_min), limit(&l.green_max), idx[1]),
                    pick(limit(&l.blue_min), limit(&l.blue_max), idx[2]),
                ],
                None => [layout.range(idx[0]), layout.range(idx[1]), layout.range(idx[2])],
            };
            (idx, ranges)
        });
        ScanFields {
            cartesian: layout.triple("cartesianX", "cartesianY", "cartesianZ"),
            spherical: layout.triple("sphericalRange", "sphericalAzimuth", "sphericalElevation"),
            cartesian_invalid: layout.index("cartesianInvalidState"),
            spherical_invalid: layout.index("sphericalInvalidState"),
            intensity,
            rgb,
            return_index: layout.index("returnIndex"),
            return_count: layout.index("returnCount"),
            time: layout.index("timeStamp"),
            normal: layout.triple("normalX", "normalY", "normalZ"),
        }
    }
}

/// Local position of one record, or None when it has none (invalid state 1 = direction only, 2 = no data).
fn position(values: &[RecordValue], layout: &Layout, fields: &ScanFields) -> CloudResult<Option<Vec3>> {
    let state = |index: Option<usize>| -> CloudResult<i64> {
        match index {
            Some(i) => values[i].to_i64(&layout.types[i]).map_err(structure),
            None => Ok(0),
        }
    };
    if let Some(idx) = fields.cartesian {
        if state(fields.cartesian_invalid)? != 0 {
            return Ok(None);
        }
        return Ok(Some([value_f64(values, layout, idx[0])?, value_f64(values, layout, idx[1])?, value_f64(values, layout, idx[2])?]));
    }
    if let Some(idx) = fields.spherical {
        if state(fields.spherical_invalid)? != 0 {
            return Ok(None);
        }
        let (r, az, el) = (value_f64(values, layout, idx[0])?, value_f64(values, layout, idx[1])?, value_f64(values, layout, idx[2])?);
        let (ce, se) = (libm::cos(el), libm::sin(el));
        return Ok(Some([r * ce * libm::cos(az), r * ce * libm::sin(az), r * se]));
    }
    Err(CloudError::new("SCN_E57_STRUCTURE", "a data3D has neither Cartesian nor spherical coordinates"))
}

#[allow(clippy::too_many_arguments)]
fn read_scan(
    reader: &mut E57Reader<BufReader<File>>,
    pc: &PointCloud,
    layout: &Layout,
    pose: &Pose,
    apply_pose: bool,
    record_base: u64,
    cloud: &mut RawCloud,
    columns: &mut Columns,
) -> CloudResult<u64> {
    let fields = ScanFields::of(pc, layout);
    let matrix = pose.matrix();
    let transform = apply_pose && !pose.is_identity();
    let mut kept = 0u64;
    let iterator = reader.pointcloud_raw(pc).map_err(structure)?;
    for (record, values) in iterator.enumerate() {
        let values = values.map_err(structure)?;
        let Some(local) = position(&values, layout, &fields)? else {
            cloud.dropped += 1;
            continue;
        };
        cloud.positions.push(if transform { pose.apply(&matrix, &local) } else { local });
        cloud.record_index.push(record_base + record as u64);
        kept += 1;
        if let Some(column) = columns.intensity.as_mut() {
            column.push(match fields.intensity {
                Some((i, range)) => normalise(value_f64(&values, layout, i)?, range, 65535.0) as u16,
                None => 0,
            });
        }
        if let Some(column) = columns.rgb.as_mut() {
            column.push(match &fields.rgb {
                Some((idx, ranges)) => {
                    let channel =
                        |c: usize| -> CloudResult<u8> { Ok(normalise(value_f64(&values, layout, idx[c])?, ranges[c], 255.0) as u8) };
                    [channel(0)?, channel(1)?, channel(2)?]
                }
                None => [0, 0, 0],
            });
        }
        let small = |index: Option<usize>| -> CloudResult<u8> {
            Ok(match index {
                Some(i) => value_f64(&values, layout, i)?.clamp(0.0, 255.0) as u8,
                None => 0,
            })
        };
        if let Some(column) = columns.return_number.as_mut() {
            // E57 returnIndex is 0-based; LAS return numbers are 1-based.
            column.push(small(fields.return_index)?.saturating_add(u8::from(fields.return_index.is_some())));
        }
        if let Some(column) = columns.number_of_returns.as_mut() {
            column.push(small(fields.return_count)?);
        }
        if let Some(column) = columns.gps_time.as_mut() {
            column.push(match fields.time {
                Some(i) => value_f64(&values, layout, i)?,
                None => 0.0,
            });
        }
        if let Some(column) = columns.normal.as_mut() {
            column.push(match fields.normal {
                Some(idx) => {
                    let n = [value_f64(&values, layout, idx[0])?, value_f64(&values, layout, idx[1])?, value_f64(&values, layout, idx[2])?];
                    let r = if transform { rotate(&matrix, &n) } else { n };
                    [r[0] as f32, r[1] as f32, r[2] as f32]
                }
                None => [0.0; 3],
            });
        }
    }
    Ok(kept)
}

fn rotate(m: &[[f64; 3]; 3], v: &Vec3) -> Vec3 {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

#[cfg(test)]
mod tests {
    use super::crc32c;

    #[test]
    fn crc32c_matches_the_rfc3720_check_value() {
        assert_eq!(crc32c(b"123456789"), 0xE306_9283);
    }
}
