//! VC-SCN-06..08: the 10 LAS / LAZ files of the pack against `las_reference.json` (laspy 2.7.0 + lazrs, own header reader).

mod common;

use common::{close, data, json, vec3};
use llull_cloud::cloud::{Bounds, Format};
use llull_cloud::read::{read, ImportOptions};

#[test]
fn vc_scn_06_inventory_and_decoded_values_match_laspy() {
    let reference = json("las_reference.json");
    for file in reference["files"].as_array().unwrap() {
        let name = file["file"].as_str().unwrap();
        let cloud = read(&data(name), &ImportOptions::default()).unwrap_or_else(|e| panic!("{name}: {e}"));
        let source = &cloud.source;
        assert_eq!(source.version_major, Some(file["versionMajor"].as_u64().unwrap() as u32), "{name}");
        assert_eq!(source.version_minor, Some(file["versionMinor"].as_u64().unwrap() as u32), "{name}");
        assert_eq!(source.point_format, Some(file["pointFormat"].as_u64().unwrap() as u8), "{name}");
        assert_eq!(cloud.format == Format::Laz, file["compressed"].as_bool().unwrap(), "{name}");
        assert_eq!(source.point_record_length, Some(file["pointRecordLength"].as_u64().unwrap() as u16), "{name}");
        assert_eq!(source.vlr_count, Some(file["numberOfVlrs"].as_u64().unwrap() as u32), "{name}");
        assert_eq!(source.evlr_count, Some(file["numberOfEvlrs"].as_u64().unwrap_or(0) as u32), "{name}");
        assert_eq!(cloud.len() as u64, file["pointCount"].as_u64().unwrap(), "{name}");
        assert_eq!(cloud.len() as u64, file["decodedPoints"].as_u64().unwrap(), "{name}");
        // Scale and offset bit for bit.
        let bits = |v: [f64; 3]| v.map(f64::to_bits);
        assert_eq!(source.scale.map(bits), Some(bits(vec3(&file["scale"]))), "{name}: scale");
        assert_eq!(source.offset.map(bits), Some(bits(vec3(&file["offset"]))), "{name}: offset");
        // Decoded bounds equal laspy's min / max exactly; centroid to the printed precision.
        let bounds = Bounds::of(&cloud.positions).unwrap();
        assert_eq!(bounds.min.map(f64::to_bits), vec3(&file["dataMin"]).map(f64::to_bits), "{name}: min");
        assert_eq!(bounds.max.map(f64::to_bits), vec3(&file["dataMax"]).map(f64::to_bits), "{name}: max");
        assert!(close(cloud.centroid().unwrap(), vec3(&file["centroid"]), 1e-6), "{name}: centroid");
        // Return and class histograms.
        let returns = cloud.attributes.return_number.as_ref().unwrap();
        for (number, expected) in file["returnNumberHistogram"].as_array().unwrap().iter().enumerate() {
            let count = returns.iter().filter(|&&r| usize::from(r) == number).count() as u64;
            assert_eq!(count, expected.as_u64().unwrap(), "{name}: return {number}");
        }
        let classes = cloud.attributes.classification.as_ref().unwrap();
        for (class, expected) in file["classificationHistogram"].as_object().unwrap() {
            let class: u8 = class.parse().unwrap();
            assert_eq!(classes.iter().filter(|&&c| c == class).count() as u64, expected.as_u64().unwrap(), "{name}: class {class}");
        }
        let warned = cloud.warnings.iter().any(|w| w.code == "SCN_LAS_HEADER_BOUNDS");
        assert_eq!(warned, !file["headerBoundsMatchData"].as_bool().unwrap(), "{name}: header bounds warning");
    }
}

#[test]
fn vc_scn_07_laz_equals_its_las_twin_on_every_dimension() {
    for (las_name, laz_name, dimensions) in [("las/simple.las", "las/simple.laz", 19), ("las/1_4_w_evlr.las", "las/1_4_w_evlr.laz", 18)] {
        let mut las = las::Reader::from_path(data(las_name)).unwrap();
        let mut laz = las::Reader::from_path(data(laz_name)).unwrap();
        let (a, b) = (las.read_all().unwrap(), laz.read_all().unwrap());
        assert_eq!(a.len(), b.len());
        for (p, q) in a.points().zip(b.points()) {
            assert_eq!(p.unwrap(), q.unwrap(), "{las_name}");
        }
        let (ours_las, ours_laz) =
            (read(&data(las_name), &ImportOptions::default()).unwrap(), read(&data(laz_name), &ImportOptions::default()).unwrap());
        assert_eq!(ours_las.scans[0].fields.len(), dimensions, "{las_name}");
        assert_eq!(ours_las.scans[0].fields, ours_laz.scans[0].fields);
        assert_eq!(ours_las.codes, ours_laz.codes);
        assert_eq!(
            ours_las.positions.iter().flatten().map(|v| v.to_bits()).collect::<Vec<_>>(),
            ours_laz.positions.iter().flatten().map(|v| v.to_bits()).collect::<Vec<_>>()
        );
        assert_eq!(ours_las.attributes, ours_laz.attributes);
    }
}

#[test]
fn vc_scn_08_inconsistent_header_bounds_are_recomputed_with_a_warning() {
    let cloud = read(&data("las/simple1_3.las"), &ImportOptions::default()).unwrap();
    let warning = cloud.warnings.iter().find(|w| w.code == "SCN_LAS_HEADER_BOUNDS").expect("warning");
    assert!(warning.message.contains("recomputed"));
    let header = cloud.header_bounds.expect("header bounds kept");
    assert!(header.min[0] < -2.0e8, "the header stores record units: {}", header.min[0]);
    let bounds = Bounds::of(&cloud.positions).unwrap();
    assert!((bounds.min[0] - -235434.519).abs() < 1e-6 && (bounds.max[0] - -234935.841).abs() < 1e-6, "{bounds:?}");
}

#[test]
fn a_feet_crs_warns_and_source_unit_ft_scales_the_grid_exactly() {
    let metres = read(&data("las/autzen_trim.laz"), &ImportOptions::default()).unwrap();
    assert!(metres.warnings.iter().any(|w| w.code == "SCN_LAS_UNIT_FEET"));
    let feet = read(&data("las/autzen_trim.laz"), &ImportOptions { source_unit: "ft".into(), ..ImportOptions::default() }).unwrap();
    assert!(feet.warnings.iter().all(|w| w.code != "SCN_LAS_UNIT_FEET"));
    assert_eq!(feet.codes, metres.codes, "the integer codes do not change");
    let grid = feet.grid.unwrap();
    assert_eq!(grid.quantum, [0.01 * 0.3048; 3]);
    for (f, m) in feet.positions.iter().zip(&metres.positions) {
        assert!((0..3).all(|a| (f[a] - m[a] * 0.3048).abs() < 1e-6));
    }
}

#[test]
fn a_file_that_is_not_las_is_refused_with_the_header_code() {
    let dir = common::temp_dir("badlas");
    let path = dir.join("broken.las");
    let mut bytes = b"LASF".to_vec();
    bytes.extend([0u8; 40]);
    std::fs::write(&path, bytes).unwrap();
    assert_eq!(read(&path, &ImportOptions::default()).unwrap_err().code, "SCN_LAS_HEADER");
}

#[test]
fn ascii_clouds_honour_columns_units_and_pts_counts() {
    let dir = common::temp_dir("ascii");
    let xyz = dir.join("a.xyz");
    std::fs::write(&xyz, "1000 2000 3000 10\n1500 2500 3500 30\n").unwrap();
    let cloud = read(&xyz, &ImportOptions { source_unit: "mm".into(), columns: "xyzi".into(), ..ImportOptions::default() }).unwrap();
    assert_eq!(cloud.positions, vec![[1.0, 2.0, 3.0], [1.5, 2.5, 3.5]]);
    assert_eq!(cloud.attributes.intensity, Some(vec![0, 65535]));
    let pts = dir.join("b.pts");
    std::fs::write(&pts, "2\n0 0 0\n1 1 1\n").unwrap();
    assert_eq!(read(&pts, &ImportOptions::default()).unwrap().len(), 2);
    std::fs::write(&pts, "3\n0 0 0\n1 1 1\n").unwrap();
    assert_eq!(read(&pts, &ImportOptions::default()).unwrap_err().code, "SCN_ASCII_PARSE");
    let csv = read(&data("synthetic/cyl-a.csv"), &ImportOptions::default()).unwrap();
    assert_eq!(csv.len(), 4000);
    assert_eq!(csv.positions[0], [2.127412, 2.797947, 3.042827]);
    let bad = dir.join("c.csv");
    std::fs::write(&bad, "x,y,z\n1,2\n").unwrap();
    assert_eq!(read(&bad, &ImportOptions::default()).unwrap_err().code, "SCN_ASCII_PARSE");
    assert_eq!(read(&bad, &ImportOptions { source_unit: "yd".into(), ..ImportOptions::default() }).unwrap_err().code, "NATIVE_JOB_INPUT");
}
