//! PLY reader (FR-SCN-03, TECHNICAL_SPEC §6 / §13.8): `ascii`, `binary_little_endian` and `binary_big_endian` 1.0 files from photogrammetry and
//! CloudCompare. Vertex properties `x y z` (any numeric type) and the optional `red green blue` (also `r g b`, `diffuse_*`), `intensity` and
//! `nx ny nz`; every other property or element (faces, edges, vendor extensions) is skipped. Untrusted input: every size is checked against
//! the file length BEFORE anything is allocated, so a header that announces 4 billion vertices in a 100 byte file is refused, not honoured.
//!
//! Limits (named, tested in `tests/ply.rs`): header 64 KiB / 1 024 lines / 4 KiB per line, 64 elements, 64 properties per element, ASCII rows 64 KiB,
//! coordinates within 1e7 m of the origin after the unit scale (others are dropped and counted, with the warning `SCN_PLY_DROPPED`).

use super::ascii::unit_scale;
use crate::cloud::{Attributes, Format, Pose, RawCloud, ScanInfo, Warning};
use crate::error::{CloudError, CloudResult};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

pub const MAX_HEADER_BYTES: usize = 64 * 1024;
pub const MAX_HEADER_LINES: usize = 1024;
pub const MAX_HEADER_LINE: usize = 4096;
pub const MAX_ELEMENTS: usize = 64;
pub const MAX_PROPERTIES: usize = 64;
pub const MAX_ASCII_ROW: usize = 64 * 1024;
/// Largest coordinate kept, metres after the unit scale (10 000 km).
pub const MAX_COORDINATE_M: f64 = 1.0e7;
/// Records per binary read.
const CHUNK_RECORDS: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ty {
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    F32,
    F64,
}

impl Ty {
    fn parse(name: &str) -> Option<Ty> {
        Some(match name {
            "char" | "int8" => Ty::I8,
            "uchar" | "uint8" => Ty::U8,
            "short" | "int16" => Ty::I16,
            "ushort" | "uint16" => Ty::U16,
            "int" | "int32" => Ty::I32,
            "uint" | "uint32" => Ty::U32,
            "float" | "float32" => Ty::F32,
            "double" | "float64" => Ty::F64,
            _ => return None,
        })
    }

    fn size(self) -> usize {
        match self {
            Ty::I8 | Ty::U8 => 1,
            Ty::I16 | Ty::U16 => 2,
            Ty::I32 | Ty::U32 | Ty::F32 => 4,
            Ty::F64 => 8,
        }
    }

    fn read(self, bytes: &[u8], big: bool) -> f64 {
        fn array<const N: usize>(bytes: &[u8], big: bool) -> [u8; N] {
            let mut a = [0u8; N];
            a.copy_from_slice(&bytes[..N]);
            if big {
                a.reverse();
            }
            a
        }
        match self {
            Ty::I8 => f64::from(bytes[0] as i8),
            Ty::U8 => f64::from(bytes[0]),
            Ty::I16 => f64::from(i16::from_le_bytes(array(bytes, big))),
            Ty::U16 => f64::from(u16::from_le_bytes(array(bytes, big))),
            Ty::I32 => f64::from(i32::from_le_bytes(array(bytes, big))),
            Ty::U32 => f64::from(u32::from_le_bytes(array(bytes, big))),
            Ty::F32 => f64::from(f32::from_le_bytes(array(bytes, big))),
            Ty::F64 => f64::from_le_bytes(array(bytes, big)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Encoding {
    Ascii,
    Little,
    Big,
}

#[derive(Debug, Clone)]
struct Property {
    name: String,
    ty: Ty,
    /// Count type of a list property.
    list: Option<Ty>,
}

#[derive(Debug, Clone)]
struct Element {
    name: String,
    count: u64,
    properties: Vec<Property>,
}

struct Header {
    encoding: Encoding,
    elements: Vec<Element>,
    /// Bytes of the header including the `end_header` line.
    length: u64,
}

fn header_error(message: impl Into<String>) -> CloudError {
    CloudError::new("SCN_PLY_HEADER", message)
}

fn truncated(element: &str) -> CloudError {
    CloudError::new("SCN_PLY_TRUNCATED", format!("the file ends inside the '{element}' element: fewer records than the header declares"))
}

/// One header line (without its terminator), refused above `MAX_HEADER_LINE`; None at the end of the file.
fn header_line(reader: &mut impl BufRead, consumed: &mut usize) -> CloudResult<Option<String>> {
    let mut bytes = Vec::new();
    let read = reader.by_ref().take(MAX_HEADER_LINE as u64 + 1).read_until(b'\n', &mut bytes).map_err(|e| header_error(e.to_string()))?;
    if read == 0 {
        return Ok(None);
    }
    *consumed += read;
    if bytes.len() > MAX_HEADER_LINE || *consumed > MAX_HEADER_BYTES {
        return Err(header_error(format!("the header exceeds {MAX_HEADER_BYTES} bytes or a line exceeds {MAX_HEADER_LINE} bytes")));
    }
    Ok(Some(String::from_utf8_lossy(&bytes).trim_end_matches(['\n', '\r']).to_string()))
}

fn parse_header(reader: &mut impl BufRead) -> CloudResult<Header> {
    let mut consumed = 0usize;
    let mut next = |consumed: &mut usize| header_line(reader, consumed);
    if next(&mut consumed)?.as_deref().map(str::trim) != Some("ply") {
        return Err(header_error("the file does not start with a 'ply' line"));
    }
    let (mut encoding, mut elements) = (None, Vec::<Element>::new());
    for _ in 0..MAX_HEADER_LINES {
        let line = next(&mut consumed)?.ok_or_else(|| header_error("the file ends before end_header"))?;
        let words: Vec<&str> = line.split_whitespace().collect();
        match words.as_slice() {
            [] | ["comment", ..] | ["obj_info", ..] => {}
            ["format", kind, version] => {
                if *version != "1.0" {
                    return Err(header_error(format!("PLY version '{version}' is not 1.0")));
                }
                encoding = Some(match *kind {
                    "ascii" => Encoding::Ascii,
                    "binary_little_endian" => Encoding::Little,
                    "binary_big_endian" => Encoding::Big,
                    other => return Err(header_error(format!("format '{other}' is not ascii, binary_little_endian or binary_big_endian"))),
                });
            }
            ["element", name, count] => {
                if elements.len() >= MAX_ELEMENTS {
                    return Err(header_error(format!("more than {MAX_ELEMENTS} elements")));
                }
                let count: u64 = count.parse().map_err(|_| header_error(format!("element '{name}': '{count}' is not a count")))?;
                elements.push(Element { name: (*name).to_string(), count, properties: Vec::new() });
            }
            ["property", "list", count, item, name] => {
                let (Some(count), Some(item)) = (Ty::parse(count), Ty::parse(item)) else {
                    return Err(header_error(format!("property '{name}': unknown list type")));
                };
                push_property(&mut elements, Property { name: (*name).to_string(), ty: item, list: Some(count) })?;
            }
            ["property", ty, name] => {
                let ty = Ty::parse(ty).ok_or_else(|| header_error(format!("property '{name}': unknown type '{ty}'")))?;
                push_property(&mut elements, Property { name: (*name).to_string(), ty, list: None })?;
            }
            ["end_header"] => {
                let encoding = encoding.ok_or_else(|| header_error("no format line before end_header"))?;
                return Ok(Header { encoding, elements, length: consumed as u64 });
            }
            _ => return Err(header_error(format!("cannot read the header line '{}'", line.chars().take(80).collect::<String>()))),
        }
    }
    Err(header_error(format!("no end_header within {MAX_HEADER_LINES} lines")))
}

fn push_property(elements: &mut [Element], property: Property) -> CloudResult<()> {
    let element = elements.last_mut().ok_or_else(|| header_error("a property before any element"))?;
    if element.properties.len() >= MAX_PROPERTIES {
        return Err(header_error(format!("more than {MAX_PROPERTIES} properties in element '{}'", element.name)));
    }
    element.properties.push(property);
    Ok(())
}

/// Offsets (binary) / indices (ASCII) of the wanted vertex properties.
struct Layout {
    x: usize,
    y: usize,
    z: usize,
    rgb: Option<[usize; 3]>,
    intensity: Option<usize>,
    normal: Option<[usize; 3]>,
}

fn layout_of(vertex: &Element) -> CloudResult<Layout> {
    if vertex.properties.iter().any(|p| p.list.is_some()) {
        return Err(header_error("a list property in the vertex element is not supported"));
    }
    let find = |name: &str| vertex.properties.iter().position(|p| p.name == name);
    let triple = |names: [&str; 3]| Some([find(names[0])?, find(names[1])?, find(names[2])?]);
    let (Some(x), Some(y), Some(z)) = (find("x"), find("y"), find("z")) else {
        return Err(header_error("the vertex element has no x, y, z properties"));
    };
    Ok(Layout {
        x,
        y,
        z,
        rgb: triple(["red", "green", "blue"])
            .or_else(|| triple(["r", "g", "b"]))
            .or_else(|| triple(["diffuse_red", "diffuse_green", "diffuse_blue"])),
        intensity: find("intensity").or_else(|| find("scalar_intensity")),
        normal: triple(["nx", "ny", "nz"]),
    })
}

/// Colour channel 0..255 from a value of type `ty` (floats are 0..1, 16 bit is scaled down, other integers are taken as 0..255).
fn colour(value: f64, ty: Ty) -> u8 {
    let scaled = match ty {
        Ty::F32 | Ty::F64 => value * 255.0,
        Ty::U16 => value / 257.0,
        _ => value,
    };
    scaled.round().clamp(0.0, 255.0) as u8
}

#[derive(Default)]
struct Columns {
    positions: Vec<[f64; 3]>,
    record_index: Vec<u64>,
    rgb: Vec<[u8; 3]>,
    intensity: Vec<f64>,
    normal: Vec<[f32; 3]>,
    dropped: u64,
}

impl Columns {
    fn push(&mut self, index: u64, layout: &Layout, scale: f64, value: &dyn Fn(usize) -> f64, types: &[Property]) {
        let p = [value(layout.x) * scale, value(layout.y) * scale, value(layout.z) * scale];
        if !p.iter().all(|v| v.is_finite() && v.abs() <= MAX_COORDINATE_M) {
            self.dropped += 1;
            return;
        }
        self.positions.push(p);
        self.record_index.push(index);
        if let Some(c) = layout.rgb {
            self.rgb.push([0, 1, 2].map(|k| colour(value(c[k]), types[c[k]].ty)));
        }
        if let Some(i) = layout.intensity {
            self.intensity.push(value(i));
        }
        if let Some(n) = layout.normal {
            self.normal.push([0, 1, 2].map(|k| value(n[k]) as f32));
        }
    }
}

fn skip(reader: &mut impl BufRead, bytes: u64, remaining: &mut u64, element: &str) -> CloudResult<()> {
    if bytes > *remaining {
        return Err(truncated(element));
    }
    *remaining -= bytes;
    std::io::copy(&mut reader.by_ref().take(bytes), &mut std::io::sink()).map_err(|e| header_error(e.to_string()))?;
    Ok(())
}

/// Skips a non-vertex element (binary): fixed-size rows in one step, rows with lists one by one (each row consumes at least its count).
fn skip_binary(reader: &mut impl BufRead, element: &Element, big: bool, remaining: &mut u64) -> CloudResult<()> {
    if element.properties.iter().all(|p| p.list.is_none()) {
        let row: u64 = element.properties.iter().map(|p| p.ty.size() as u64).sum();
        return skip(reader, row.checked_mul(element.count).ok_or_else(|| truncated(&element.name))?, remaining, &element.name);
    }
    for _ in 0..element.count {
        for property in &element.properties {
            match property.list {
                None => skip(reader, property.ty.size() as u64, remaining, &element.name)?,
                Some(count_ty) => {
                    let mut bytes = [0u8; 8];
                    let size = count_ty.size();
                    if size as u64 > *remaining {
                        return Err(truncated(&element.name));
                    }
                    reader.read_exact(&mut bytes[..size]).map_err(|_| truncated(&element.name))?;
                    *remaining -= size as u64;
                    let items = count_ty.read(&bytes, big).max(0.0) as u64;
                    skip(reader, items.saturating_mul(property.ty.size() as u64), remaining, &element.name)?;
                }
            }
        }
    }
    Ok(())
}

fn ascii_row(reader: &mut impl BufRead, element: &str, row: u64) -> CloudResult<Option<String>> {
    loop {
        let mut bytes = Vec::new();
        let read = reader
            .by_ref()
            .take(MAX_ASCII_ROW as u64 + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|e| CloudError::new("SCN_PLY_PARSE", e.to_string()))?;
        if read == 0 {
            return Err(truncated(element));
        }
        if bytes.len() > MAX_ASCII_ROW {
            return Err(CloudError::new("SCN_PLY_PARSE", format!("{element} row {row}: a line is longer than {MAX_ASCII_ROW} bytes")));
        }
        let text = String::from_utf8_lossy(&bytes).trim().to_string();
        if !text.is_empty() {
            return Ok(Some(text));
        }
    }
}

fn read_ascii_vertices(reader: &mut impl BufRead, vertex: &Element, layout: &Layout, scale: f64, columns: &mut Columns) -> CloudResult<()> {
    for row in 0..vertex.count {
        let text = ascii_row(reader, &vertex.name, row)?.unwrap_or_default();
        let tokens: Vec<&str> = text.split_whitespace().collect();
        if tokens.len() < vertex.properties.len() {
            return Err(CloudError::new(
                "SCN_PLY_PARSE",
                format!("vertex {row}: {} values, the header declares {}", tokens.len(), vertex.properties.len()),
            ));
        }
        let mut values = Vec::with_capacity(tokens.len());
        for token in &tokens[..vertex.properties.len()] {
            values.push(
                token.parse::<f64>().map_err(|_| CloudError::new("SCN_PLY_PARSE", format!("vertex {row}: '{token}' is not a number")))?,
            );
        }
        columns.push(row, layout, scale, &|k| values[k], &vertex.properties);
    }
    Ok(())
}

fn skip_ascii(reader: &mut impl BufRead, element: &Element) -> CloudResult<()> {
    for row in 0..element.count {
        ascii_row(reader, &element.name, row)?;
    }
    Ok(())
}

fn read_binary_vertices(
    reader: &mut impl BufRead,
    vertex: &Element,
    layout: &Layout,
    (scale, big): (f64, bool),
    remaining: &mut u64,
    columns: &mut Columns,
) -> CloudResult<()> {
    let offsets: Vec<usize> = vertex
        .properties
        .iter()
        .scan(0usize, |at, p| {
            let here = *at;
            *at += p.ty.size();
            Some(here)
        })
        .collect();
    let row: usize = vertex.properties.iter().map(|p| p.ty.size()).sum();
    let total = (row as u64).checked_mul(vertex.count).filter(|t| t <= remaining).ok_or_else(|| truncated(&vertex.name))?;
    *remaining -= total;
    let mut buffer = vec![0u8; row * CHUNK_RECORDS.min(vertex.count as usize)];
    let mut index = 0u64;
    while index < vertex.count {
        let n = ((vertex.count - index) as usize).min(CHUNK_RECORDS);
        reader.read_exact(&mut buffer[..row * n]).map_err(|_| truncated(&vertex.name))?;
        for record in buffer[..row * n].chunks_exact(row) {
            let value = |k: usize| vertex.properties[k].ty.read(&record[offsets[k]..], big);
            columns.push(index, layout, scale, &value, &vertex.properties);
            index += 1;
        }
    }
    Ok(())
}

/// Reads a PLY file.
/// @failure bad header / unknown type / over a limit -> SCN_PLY_HEADER; fewer records than declared -> SCN_PLY_TRUNCATED; ASCII garbage -> SCN_PLY_PARSE;
///   more than 2^32 vertices -> SCN_IMPORT_TOO_LARGE; bad unit -> NATIVE_JOB_INPUT
pub fn read(path: &Path, unit: &str) -> CloudResult<RawCloud> {
    let scale = unit_scale(unit)?;
    let file = File::open(path).map_err(|error| CloudError::io(path, &error))?;
    let length = file.metadata().map_err(|error| CloudError::io(path, &error))?.len();
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let header = parse_header(&mut reader)?;
    let mut remaining = length.saturating_sub(header.length);
    let mut columns = Columns::default();
    let mut found = false;
    for element in &header.elements {
        if element.name == "vertex" && !found {
            found = true;
            if element.count > u64::from(u32::MAX) {
                return Err(CloudError::new("SCN_IMPORT_TOO_LARGE", format!("{} vertices: more than 2^32 records", element.count)));
            }
            let layout = layout_of(element)?;
            // Every ASCII row holds at least its newline, every binary row its declared bytes: never trust the count for an allocation.
            if header.encoding == Encoding::Ascii && element.count > remaining {
                return Err(truncated(&element.name));
            }
            let capacity = (element.count as usize).min(1 << 20);
            columns.positions.reserve(capacity);
            columns.record_index.reserve(capacity);
            match header.encoding {
                Encoding::Ascii => read_ascii_vertices(&mut reader, element, &layout, scale, &mut columns)?,
                enc => read_binary_vertices(&mut reader, element, &layout, (scale, enc == Encoding::Big), &mut remaining, &mut columns)?,
            }
            break;
        }
        match header.encoding {
            Encoding::Ascii => skip_ascii(&mut reader, element)?,
            enc => skip_binary(&mut reader, element, enc == Encoding::Big, &mut remaining)?,
        }
    }
    if !found {
        return Err(header_error("the file has no vertex element"));
    }
    let vertex = header
        .elements
        .iter()
        .find(|e| e.name == "vertex")
        .map(|e| (e.count, e.properties.iter().map(|p| p.name.clone()).collect::<Vec<_>>()));
    let (declared, fields) = vertex.unwrap_or_default();
    let layout_rgb = !columns.rgb.is_empty();
    let intensity =
        (!columns.intensity.is_empty()).then(|| scale_intensity(&columns.intensity, header.elements.iter().find(|e| e.name == "vertex")));
    let count = columns.positions.len() as u64;
    let mut warnings = Vec::new();
    if columns.dropped > 0 {
        warnings.push(Warning {
            code: "SCN_PLY_DROPPED".to_string(),
            message: format!("{} vertices with a non-finite coordinate or beyond {MAX_COORDINATE_M} m were dropped", columns.dropped),
        });
    }
    Ok(RawCloud {
        format: Format::Ply,
        source: crate::cloud::SourceInfo::default(),
        record_index: columns.record_index,
        positions: columns.positions,
        codes: None,
        grid: None,
        attributes: Attributes {
            intensity,
            rgb: layout_rgb.then_some(columns.rgb),
            normal: (!columns.normal.is_empty()).then_some(columns.normal),
            ..Attributes::default()
        },
        scans: vec![ScanInfo {
            guid: None,
            name: None,
            point_count: count,
            record_count: declared,
            pose: Pose::IDENTITY,
            station_origin: None,
            fields,
        }],
        header_bounds: None,
        crs: None,
        warnings,
        dropped: columns.dropped,
    })
}

/// 16-bit intensity: uchar x 257, ushort as is, any other type scaled from its observed range (as the ASCII reader does).
fn scale_intensity(values: &[f64], vertex: Option<&Element>) -> Vec<u16> {
    let ty = vertex.and_then(|v| v.properties.iter().find(|p| p.name == "intensity" || p.name == "scalar_intensity")).map(|p| p.ty);
    match ty {
        Some(Ty::U8) => values.iter().map(|v| (v * 257.0) as u16).collect(),
        Some(Ty::U16) => values.iter().map(|v| *v as u16).collect(),
        _ => {
            let (low, high) = values.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &v| (a.min(v), b.max(v)));
            values.iter().map(|&v| if high > low { ((v - low) / (high - low) * 65535.0).round() as u16 } else { 0 }).collect()
        }
    }
}
