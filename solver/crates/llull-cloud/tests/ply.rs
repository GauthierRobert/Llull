//! PLY import (ascii, binary little / big endian; xyz, rgb, intensity, normals): exact values, unit scale, skipped elements, the asset
//! round trip and the hostile-input table (every refusal is a stable code, bounded in time, with no allocation from an untrusted count).

mod common;

use common::temp_dir;
use llull_cloud::asset;
use llull_cloud::cloud::Format;
use llull_cloud::read::ply::{MAX_ELEMENTS, MAX_HEADER_BYTES, MAX_HEADER_LINE, MAX_PROPERTIES};
use llull_cloud::read::{read, ImportOptions};
use std::path::PathBuf;
use std::time::Instant;

fn write(name: &str, bytes: &[u8]) -> PathBuf {
    let path = temp_dir(&format!("ply-{name}")).join(format!("{name}.ply"));
    std::fs::write(&path, bytes).unwrap();
    path
}

const POINTS: [[f64; 3]; 4] = [[0.0, 0.0, 0.0], [1.5, -2.25, 3.125], [100.0, 200.0, 300.0], [-0.5, 0.25, -0.125]];

fn ascii_file(extra_header: &str, vertex_header: &str, rows: &[String]) -> Vec<u8> {
    let mut text =
        format!("ply\nformat ascii 1.0\ncomment made by a test\n{extra_header}element vertex {}\n{vertex_header}end_header\n", rows.len());
    for row in rows {
        text.push_str(row);
        text.push('\n');
    }
    text.into_bytes()
}

fn binary_file(big: bool, before: &str, rows: &[Vec<u8>], after: &[u8]) -> Vec<u8> {
    let kind = if big { "binary_big_endian" } else { "binary_little_endian" };
    let mut bytes = format!(
        "ply\nformat {kind} 1.0\n{before}element vertex {}\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty float intensity\nproperty float nx\nproperty float ny\nproperty float nz\nproperty uchar alpha\nend_header\n",
        rows.len()
    )
    .into_bytes();
    for row in rows {
        bytes.extend(row);
    }
    bytes.extend(after);
    bytes
}

fn record(big: bool, p: [f64; 3], rgb: [u8; 3], intensity: f32, normal: [f32; 3]) -> Vec<u8> {
    let bytes = |le: Vec<u8>| -> Vec<u8> {
        if big {
            le.into_iter().rev().collect()
        } else {
            le
        }
    };
    let mut row = Vec::new();
    for v in p {
        row.extend(bytes(v.to_le_bytes().to_vec()));
    }
    row.extend(rgb);
    row.extend(bytes(intensity.to_le_bytes().to_vec()));
    for v in normal {
        row.extend(bytes(v.to_le_bytes().to_vec()));
    }
    row.push(255);
    row
}

fn rows(big: bool) -> Vec<Vec<u8>> {
    POINTS.iter().enumerate().map(|(i, p)| record(big, *p, [i as u8 * 60, 255 - i as u8, 7], i as f32 * 0.5, [0.0, 0.0, 1.0])).collect()
}

#[test]
fn ascii_reads_xyz_rgb_intensity_normals_and_skips_other_properties() {
    let vertex = "property float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\nproperty ushort intensity\nproperty float nx\nproperty float ny\nproperty float nz\nproperty float confidence\n";
    let lines: Vec<String> =
        POINTS.iter().enumerate().map(|(i, p)| format!("{} {} {} {} 10 20 255 {} 0 0 1 0.5", p[0], p[1], p[2], i * 40, i * 1000)).collect();
    // A face element after the vertices (never read) and blank lines between rows are tolerated.
    let mut bytes = ascii_file("", vertex, &lines);
    bytes.extend(b"\n3 0 1 2\n");
    let cloud = read(&write("ascii", &bytes), &ImportOptions::default()).unwrap();
    assert_eq!(cloud.format, Format::Ply);
    assert_eq!(cloud.positions, POINTS.to_vec());
    assert_eq!(cloud.record_index, vec![0, 1, 2, 3]);
    assert_eq!(cloud.attributes.rgb.as_ref().unwrap()[2], [80, 10, 20]);
    assert_eq!(cloud.attributes.intensity.as_ref().unwrap(), &vec![0, 1000, 2000, 3000]);
    assert_eq!(cloud.attributes.normal.as_ref().unwrap()[0], [0.0, 0.0, 1.0]);
    assert_eq!(cloud.scans[0].fields.len(), 12);
    assert!(cloud.warnings.is_empty());
}

#[test]
fn binary_little_and_big_endian_give_the_same_cloud() {
    let little = read(&write("le", &binary_file(false, "", &rows(false), b"")), &ImportOptions::default()).unwrap();
    let big = read(&write("be", &binary_file(true, "", &rows(true), b"")), &ImportOptions::default()).unwrap();
    assert_eq!(little.positions, POINTS.to_vec());
    assert_eq!(little.positions, big.positions);
    assert_eq!(little.attributes, big.attributes);
    assert_eq!(little.attributes.rgb.as_ref().unwrap()[1], [60, 254, 7]);
    // A float intensity is scaled from its observed range to 16 bits (0 .. 1.5 -> 0 .. 65535).
    assert_eq!(little.attributes.intensity.as_ref().unwrap(), &vec![0, 21845, 43690, 65535]);
}

#[test]
fn elements_before_the_vertices_are_skipped_including_lists_and_fixed_rows() {
    let before = String::from(
        "element face 3\nproperty list uchar int vertex_indices\nproperty uchar flag\nelement edge 2\nproperty int a\nproperty int b\n",
    );
    let mut data = Vec::new();
    for items in [3u8, 4, 0] {
        data.push(items);
        data.extend(vec![0u8; items as usize * 4]);
        data.push(9);
    }
    data.extend(vec![0u8; 16]);
    // The vertex element is declared after face and edge: their bytes come first.
    let mut bytes = format!("ply\nformat binary_little_endian 1.0\n{before}element vertex 4\nproperty double x\nproperty double y\nproperty double z\nend_header\n").into_bytes();
    bytes.extend(&data);
    for p in POINTS {
        for v in p {
            bytes.extend(v.to_le_bytes());
        }
    }
    let cloud = read(&write("faces-first", &bytes), &ImportOptions::default()).unwrap();
    assert_eq!(cloud.positions, POINTS.to_vec());
    assert!(cloud.attributes.rgb.is_none() && cloud.attributes.normal.is_none());
}

#[test]
fn units_headers_with_crlf_and_every_type_are_read() {
    let types = [
        "char", "uchar", "short", "ushort", "int", "uint", "float", "double", "int8", "uint8", "int16", "uint16", "int32", "uint32",
        "float32", "float64",
    ];
    let mut header = String::from("ply\r\nformat ascii 1.0\r\nelement vertex 1\r\n");
    for (i, ty) in types.iter().enumerate() {
        header.push_str(&format!("property {ty} {}\r\n", if i < 3 { ["x", "y", "z"][i].to_string() } else { format!("p{i}") }));
    }
    header.push_str("end_header\r\n");
    header.push_str(&format!("{}\r\n", (0..types.len()).map(|i| format!("{}", i + 1)).collect::<Vec<_>>().join(" ")));
    let cloud = read(&write("crlf", header.as_bytes()), &ImportOptions { source_unit: "mm".into(), ..ImportOptions::default() }).unwrap();
    assert_eq!(cloud.positions, vec![[0.001, 0.002, 0.003]]);
    assert_eq!(
        read(&write("crlf-bad-unit", header.as_bytes()), &ImportOptions { source_unit: "yd".into(), ..ImportOptions::default() })
            .unwrap_err()
            .code,
        "NATIVE_JOB_INPUT"
    );
}

#[test]
fn float_and_sixteen_bit_colours_are_scaled_and_other_names_are_found() {
    let bytes = ascii_file(
        "",
        "property double x\nproperty double y\nproperty double z\nproperty float r\nproperty float g\nproperty float b\nproperty ushort scalar_intensity\n",
        &["0 0 0 1 0.5 0 65535".to_string(), "1 0 0 0 0 0.2 1".to_string()],
    );
    let cloud = read(&write("float-rgb", &bytes), &ImportOptions::default()).unwrap();
    assert_eq!(cloud.attributes.rgb.as_ref().unwrap(), &vec![[255, 128, 0], [0, 0, 51]]);
    assert_eq!(cloud.attributes.intensity.as_ref().unwrap(), &vec![65535, 1]);
}

#[test]
fn detection_is_by_signature_not_by_extension() {
    let bytes = ascii_file("", "property float x\nproperty float y\nproperty float z\n", &["1 2 3".to_string()]);
    let path = temp_dir("ply-detect").join("scan.xyz");
    std::fs::write(&path, &bytes).unwrap();
    assert_eq!(read(&path, &ImportOptions::default()).unwrap().format, Format::Ply);
    let bare = write("not-ply", b"1 2 3\n4 5 6\n");
    assert_eq!(read(&bare, &ImportOptions::default()).unwrap_err().code, "SCN_FORMAT_UNSUPPORTED");
}

#[test]
fn the_asset_keeps_the_ply_attributes_and_the_import_job_reports_the_format() {
    let big = write("job", &binary_file(false, "", &rows(false), b""));
    let dir = big.parent().unwrap().to_path_buf();
    let cloud = read(&big, &ImportOptions::default()).unwrap();
    let key = "d".repeat(64);
    let built = asset::build(&cloud, &key, &"e".repeat(64), "job.ply", &ImportOptions::default()).unwrap();
    assert_eq!(built.manifest.format, Format::Ply);
    assert_eq!(built.manifest.attributes, vec!["intensity", "rgb", "normal"]);
    assert_eq!(built.manifest.point_count, 4);
    let out = dir.join("asset");
    asset::write(&built, &out).unwrap();
    let opened = llull_cloud::store::Asset::open(&out, Some(&key)).unwrap();
    let all = opened.points_in_box(&opened.manifest.bounds.min, &opened.manifest.bounds.max).unwrap();
    assert_eq!(all.positions.len(), 4);
    // Through `cloud import` (the host path).
    let job_dir = dir.join("job-folder");
    std::fs::create_dir_all(&job_dir).unwrap();
    let job = serde_json::json!({ "version": 1, "source": big, "sourceName": "job.ply", "sourceSha256": "e".repeat(64), "assetKey": "f".repeat(64), "output": dir.join("job-out"), "options": {} });
    std::fs::write(job_dir.join("job.json"), job.to_string()).unwrap();
    llull_cloud::job::run("import", &job_dir, &mut Vec::new()).unwrap();
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("job-out").join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["format"], "ply");
}

/// (name, file bytes, expected code)
fn hostile() -> Vec<(String, Vec<u8>, &'static str)> {
    let mut cases: Vec<(String, Vec<u8>, &'static str)> = Vec::new();
    let mut add = |name: &str, bytes: Vec<u8>, code: &'static str| cases.push((name.to_string(), bytes, code));
    let xyz = "property float x\nproperty float y\nproperty float z\n";
    add("only the magic line", b"ply\n".to_vec(), "SCN_PLY_HEADER");
    add("no end_header", b"ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\n".to_vec(), "SCN_PLY_HEADER");
    add(
        "no format line",
        b"ply\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n1 2 3\n".to_vec(),
        "SCN_PLY_HEADER",
    );
    add("unknown format", b"ply\nformat utf16 1.0\nend_header\n".to_vec(), "SCN_PLY_HEADER");
    add("version 2", b"ply\nformat ascii 2.0\nend_header\n".to_vec(), "SCN_PLY_HEADER");
    add("unknown property type", b"ply\nformat ascii 1.0\nelement vertex 1\nproperty quad x\nend_header\n1\n".to_vec(), "SCN_PLY_HEADER");
    add(
        "unknown list type",
        b"ply\nformat ascii 1.0\nelement face 1\nproperty list quad int i\nend_header\n1\n".to_vec(),
        "SCN_PLY_HEADER",
    );
    add("property before any element", b"ply\nformat ascii 1.0\nproperty float x\nend_header\n".to_vec(), "SCN_PLY_HEADER");
    add("element count is not a number", b"ply\nformat ascii 1.0\nelement vertex many\nend_header\n".to_vec(), "SCN_PLY_HEADER");
    add("negative element count", b"ply\nformat ascii 1.0\nelement vertex -3\nend_header\n".to_vec(), "SCN_PLY_HEADER");
    add("garbage header line", b"ply\nformat ascii 1.0\nthis is not a header line\nend_header\n".to_vec(), "SCN_PLY_HEADER");
    add("no vertex element", b"ply\nformat ascii 1.0\nelement face 0\nend_header\n".to_vec(), "SCN_PLY_HEADER");
    add(
        "vertex without z",
        b"ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nend_header\n1 2\n".to_vec(),
        "SCN_PLY_HEADER",
    );
    add(
        "list property in the vertex element",
        format!("ply\nformat ascii 1.0\nelement vertex 1\n{xyz}property list uchar int l\nend_header\n1 2 3 0\n").into_bytes(),
        "SCN_PLY_HEADER",
    );
    add("header above the byte cap", [b"ply\nformat ascii 1.0\n".to_vec(), vec![b'#'; MAX_HEADER_BYTES + 10]].concat(), "SCN_PLY_HEADER");
    add(
        "a header line above the line cap",
        [b"ply\nformat ascii 1.0\ncomment ".to_vec(), vec![b'x'; MAX_HEADER_LINE + 10], b"\nend_header\n".to_vec()].concat(),
        "SCN_PLY_HEADER",
    );
    add("endless comment lines", [b"ply\nformat ascii 1.0\n".to_vec(), b"comment x\n".repeat(3000)].concat(), "SCN_PLY_HEADER");
    add(
        "too many elements",
        [b"ply\nformat ascii 1.0\n".to_vec(), "element e 0\n".repeat(MAX_ELEMENTS + 1).into_bytes(), b"end_header\n".to_vec()].concat(),
        "SCN_PLY_HEADER",
    );
    add(
        "too many properties",
        [
            b"ply\nformat ascii 1.0\nelement vertex 1\n".to_vec(),
            "property float p\n".repeat(MAX_PROPERTIES + 1).into_bytes(),
            b"end_header\n".to_vec(),
        ]
        .concat(),
        "SCN_PLY_HEADER",
    );
    add(
        "billions of binary vertices in a tiny file",
        format!("ply\nformat binary_little_endian 1.0\nelement vertex 4000000000\n{xyz}end_header\n").into_bytes(),
        "SCN_PLY_TRUNCATED",
    );
    add(
        "billions of ascii vertices in a tiny file",
        format!("ply\nformat ascii 1.0\nelement vertex 4000000000\n{xyz}end_header\n1 2 3\n").into_bytes(),
        "SCN_PLY_TRUNCATED",
    );
    add(
        "a count above 2^32",
        format!("ply\nformat binary_little_endian 1.0\nelement vertex 99999999999999\n{xyz}end_header\n").into_bytes(),
        "SCN_IMPORT_TOO_LARGE",
    );
    add(
        "a count that overflows u64",
        format!("ply\nformat binary_little_endian 1.0\nelement vertex 99999999999999999999999\n{xyz}end_header\n").into_bytes(),
        "SCN_PLY_HEADER",
    );
    add(
        "binary cut inside a record",
        [format!("ply\nformat binary_little_endian 1.0\nelement vertex 3\n{xyz}end_header\n").into_bytes(), vec![0u8; 30]].concat(),
        "SCN_PLY_TRUNCATED",
    );
    add(
        "ascii with fewer rows than declared",
        format!("ply\nformat ascii 1.0\nelement vertex 3\n{xyz}end_header\n1 2 3\n4 5 6\n").into_bytes(),
        "SCN_PLY_TRUNCATED",
    );
    add(
        "ascii garbage token",
        format!("ply\nformat ascii 1.0\nelement vertex 1\n{xyz}end_header\n1 two 3\n").into_bytes(),
        "SCN_PLY_PARSE",
    );
    add(
        "ascii row with too few values",
        format!("ply\nformat ascii 1.0\nelement vertex 1\n{xyz}end_header\n1 2\n").into_bytes(),
        "SCN_PLY_PARSE",
    );
    add(
        "ascii row above the row cap",
        [format!("ply\nformat ascii 1.0\nelement vertex 1\n{xyz}end_header\n").into_bytes(), vec![b'9'; 70_000]].concat(),
        "SCN_PLY_PARSE",
    );
    add("a list whose count claims billions of items", [b"ply\nformat binary_little_endian 1.0\nelement face 1\nproperty list uint int i\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n".to_vec(), u32::MAX.to_le_bytes().to_vec(), vec![0u8; 12]].concat(), "SCN_PLY_TRUNCATED");
    add(
        "every coordinate is NaN, infinite or astronomical",
        format!("ply\nformat ascii 1.0\nelement vertex 3\n{xyz}end_header\nnan 0 0\ninf 0 0\n1e300 0 0\n").into_bytes(),
        "SCN_CLOUD_EMPTY",
    );
    add(
        "binary NaN coordinates",
        [
            format!("ply\nformat binary_little_endian 1.0\nelement vertex 1\n{xyz}end_header\n").into_bytes(),
            f32::NAN.to_le_bytes().to_vec(),
            0f32.to_le_bytes().to_vec(),
            0f32.to_le_bytes().to_vec(),
        ]
        .concat(),
        "SCN_CLOUD_EMPTY",
    );
    cases
}

#[test]
fn hostile_inputs_are_refused_with_stable_codes_in_bounded_time() {
    let cases = hostile();
    assert!(cases.len() >= 30);
    for (name, bytes, code) in cases {
        let path = write(&format!("hostile-{}", name.len() % 7), &bytes);
        let started = Instant::now();
        let outcome = read(&path, &ImportOptions::default());
        assert!(started.elapsed().as_secs_f64() < 2.0, "{name}: took {:?}", started.elapsed());
        match outcome {
            Err(error) => assert_eq!(error.code, code, "{name}: {error}"),
            Ok(cloud) => panic!("{name}: read {} points instead of {code}", cloud.len()),
        }
    }
}

#[test]
fn bad_points_among_good_ones_are_dropped_and_counted() {
    let lines: Vec<String> = ["0 0 0", "nan 1 1", "2 2 2", "1e30 0 0", "3 3 3"].iter().map(|s| (*s).to_string()).collect();
    let bytes = ascii_file("", "property float x\nproperty float y\nproperty float z\n", &lines);
    let cloud = read(&write("dropped", &bytes), &ImportOptions::default()).unwrap();
    assert_eq!(cloud.len(), 3);
    assert_eq!(cloud.dropped, 2);
    assert_eq!(cloud.record_index, vec![0, 2, 4]);
    assert_eq!(cloud.warnings[0].code, "SCN_PLY_DROPPED");
    assert_eq!(cloud.scans[0].record_count, 5);
}
