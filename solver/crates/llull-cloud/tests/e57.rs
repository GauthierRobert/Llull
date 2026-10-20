//! VC-SCN-01..05: the 10 E57 files of the pack against `e57_reference.json` (pye57 / libE57Format / own reader).

mod common;

use common::{close, data, json, vec3};
use llull_cloud::read::{read, ImportOptions};

#[test]
fn vc_scn_01_inventory_matches_the_reference() {
    let reference = json("e57_reference.json");
    for file in reference["files"].as_array().unwrap() {
        let name = file["file"].as_str().unwrap();
        let path = data(name);
        let result = read(&path, &ImportOptions::default());
        if !file["allPageCrcOk"].as_bool().unwrap() {
            let error = result.unwrap_err();
            assert_eq!(error.code, "SCN_E57_CHECKSUM", "{name}");
            assert!(error.message.contains("page 0"), "{name}: {}", error.message);
            continue;
        }
        let scans = file["scans"].as_array().unwrap();
        let total: u64 = scans.iter().map(|s| s["pointCount"].as_u64().unwrap()).sum();
        if total == 0 {
            assert_eq!(result.unwrap_err().code, "SCN_CLOUD_EMPTY", "{name}");
            continue;
        }
        let cloud = result.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(cloud.source.version_major, Some(1), "{name}");
        assert_eq!(cloud.source.version_minor, Some(0), "{name}");
        assert_eq!(cloud.source.page_size, file["pageSize"].as_u64(), "{name}");
        assert_eq!(cloud.source.file_guid.as_deref(), file["fileGuid"].as_str(), "{name}");
        assert_eq!(cloud.scans.len(), file["data3DCount"].as_u64().unwrap() as usize, "{name}");
        for (scan, expected) in cloud.scans.iter().zip(scans) {
            assert_eq!(scan.record_count, expected["pointCount"].as_u64().unwrap(), "{name}");
            let fields: Vec<&str> = expected["fields"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();
            assert_eq!(scan.fields, fields, "{name}");
            assert_eq!(scan.pose.translation, vec3(&expected["translation"]), "{name}");
        }
        assert_eq!(cloud.len() as u64, total, "{name}: every record has a position");
        // Local bounds and centroid (all reference files have identity rotation; the pose translation is undone).
        let t = cloud.scans[0].pose.translation;
        let local: Vec<[f64; 3]> = cloud.positions.iter().map(|p| [p[0] - t[0], p[1] - t[1], p[2] - t[2]]).collect();
        let bounds = llull_cloud::cloud::Bounds::of(&local).unwrap();
        assert!(close(bounds.min, vec3(&scans[0]["localMin"]), 1e-6), "{name}: min {:?}", bounds.min);
        assert!(close(bounds.max, vec3(&scans[0]["localMax"]), 1e-6), "{name}: max {:?}", bounds.max);
        let centroid = cloud.centroid().unwrap();
        assert!(close(centroid, vec3(&scans[0]["fileFrameCentroid"]), 1e-6), "{name}: centroid {centroid:?}");
    }
}

#[test]
fn vc_scn_02_a_corrupt_page_is_refused() {
    let error = read(&data("e57/bad-crc.e57"), &ImportOptions::default()).unwrap_err();
    assert_eq!(error.code, "SCN_E57_CHECKSUM");
    assert_eq!(error.message, "page 0: CRC-32C mismatch");
}

#[test]
fn vc_scn_03_empty_files_are_refused() {
    for name in ["e57/empty.e57", "e57/ZeroPoints.e57"] {
        assert_eq!(read(&data(name), &ImportOptions::default()).unwrap_err().code, "SCN_CLOUD_EMPTY", "{name}");
    }
}

#[test]
fn vc_scn_04_scaled_integer_and_double_decode_to_the_same_bunny() {
    let int32 = read(&data("e57/bunnyInt32.e57"), &ImportOptions::default()).unwrap();
    let double = read(&data("e57/bunnyDouble.e57"), &ImportOptions::default()).unwrap();
    assert_eq!(int32.len(), 30_571);
    assert_eq!(double.len(), 30_571);
    let worst =
        int32.positions.iter().zip(&double.positions).flat_map(|(a, b)| (0..3).map(move |i| (a[i] - b[i]).abs())).fold(0.0, f64::max);
    assert!(worst <= 5e-7, "max point difference {worst}");
    for cloud in [&int32, &double] {
        let bounds = llull_cloud::cloud::Bounds::of(&cloud.positions).unwrap();
        assert!(close(bounds.min, [-0.094689, 0.040011, -0.061873], 1e-6), "{:?}", bounds.min);
        assert!(close(bounds.max, [0.061009, 0.187321, 0.058799], 1e-6), "{:?}", bounds.max);
        assert!(close(cloud.centroid().unwrap(), [-0.027513, 0.103078, 0.008644], 1e-6));
    }
}

#[test]
fn vc_scn_05_pose_translation_and_attribute_fields() {
    let moved = read(&data("e57/translationWithoutRotation.e57"), &ImportOptions::default()).unwrap();
    assert!(close(moved.centroid().unwrap(), [4.5, 5.5, 6.0], 1e-9));
    assert_eq!(moved.scans[0].station_origin, Some([4.0, 5.0, 6.0]));
    let local =
        read(&data("e57/translationWithoutRotation.e57"), &ImportOptions { apply_station_poses: false, ..ImportOptions::default() })
            .unwrap();
    assert!(close(local.centroid().unwrap(), [0.5, 0.5, 0.0], 1e-9));

    let colour = read(&data("e57/ColourRepresentation.e57"), &ImportOptions::default()).unwrap();
    assert_eq!(colour.len(), 153);
    for field in ["returnIndex", "returnCount", "pointSourceId", "colorRed", "colorGreen", "colorBlue"] {
        assert!(colour.scans[0].fields.iter().any(|f| f == field), "{field}");
    }
    assert_eq!(colour.attributes.names(), ["rgb", "returnNumber", "numberOfReturns"]);

    let normals = read(&data("e57/testWithNormals.e57"), &ImportOptions::default()).unwrap();
    assert_eq!(normals.attributes.names(), ["normal"]);
}

#[test]
fn unknown_and_proprietary_formats_are_refused() {
    let dir = common::temp_dir("formats");
    for (name, code) in
        [("scan.rcp", "SCN_FORMAT_PROPRIETARY"), ("scan.FLS", "SCN_FORMAT_PROPRIETARY"), ("scan.ply", "SCN_FORMAT_UNSUPPORTED")]
    {
        let path = dir.join(name);
        std::fs::write(&path, b"not a cloud").unwrap();
        assert_eq!(read(&path, &ImportOptions::default()).unwrap_err().code, code, "{name}");
    }
    let fake = dir.join("fake.e57");
    std::fs::write(&fake, b"0123456789").unwrap();
    assert_eq!(read(&fake, &ImportOptions::default()).unwrap_err().code, "SCN_FORMAT_UNSUPPORTED");
}
