//! VC-SCN-09 (lossless large coordinates), VC-SCN-10 (octree / LOD invariants, identical asset bytes), VC-SCN-12 (nearest point).

mod common;

use common::{data, temp_dir};
use llull_cloud::asset;
use llull_cloud::read::{read, ImportOptions};
use llull_cloud::store::Asset;
use std::path::Path;

const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
const SHA: &str = "00000000000000000000000000000000000000000000000000000000000000aa";

fn import(source: &Path, dir: &Path, options: &ImportOptions) -> Asset {
    let cloud = read(source, options).unwrap();
    let built = asset::build(&cloud, KEY, SHA, "test", options).unwrap();
    asset::write(&built, dir).unwrap();
    Asset::open(dir, Some(KEY)).unwrap()
}

#[test]
fn vc_scn_09_large_las_coordinates_survive_the_asset_exactly() {
    let source = data("las/test1_4.las");
    let dir = temp_dir("vc09");
    let opened = import(&source, &dir, &ImportOptions::default());
    let mut reader = las::Reader::from_path(&source).unwrap();
    let truth: Vec<las::Point> = reader.read_all().unwrap().points().map(Result::unwrap).collect();
    let points = opened.all_points().unwrap();
    assert_eq!(points.positions.len(), truth.len());
    let scale = opened.manifest.quantum;
    for (p, r) in points.positions.iter().zip(&points.record_index) {
        let t = &truth[*r as usize];
        let error = [(p[0] - t.x).abs(), (p[1] - t.y).abs(), (p[2] - t.z).abs()];
        assert!((0..3).all(|a| error[a] <= 0.5 * scale[a]), "record {r}: error {error:?}");
        assert_eq!(
            [p[0].to_bits(), p[1].to_bits(), p[2].to_bits()],
            [t.x.to_bits(), t.y.to_bits(), t.z.to_bits()],
            "LAS is stored losslessly"
        );
    }
    assert!(truth[0].x > 1.69e6);
    // The documented counter-example: absolute float32 loses centimetres at this magnitude.
    let worst32 = truth.iter().map(|t| (f64::from(t.x as f32) - t.x).abs()).fold(0.0, f64::max);
    assert!(worst32 > 0.01, "float32 error {worst32}");
}

#[test]
fn vc_scn_10_octree_invariants_and_reproducible_bytes_on_autzen() {
    let source = data("las/autzen_trim.laz");
    let options = ImportOptions::default();
    let opened = import(&source, &temp_dir("vc10"), &options);
    let m = &opened.manifest;
    assert_eq!(m.point_count, 110_000);
    let total: u64 = opened.nodes.iter().map(|n| u64::from(n.point_count)).sum();
    assert_eq!(total, 110_000, "node points sum to the cloud");
    assert!(opened.nodes.iter().all(|n| n.point_count <= m.octree.max_points_per_node));
    assert!(opened.nodes.len() > 1);
    // Every non-root node's parent exists one level up (spacing halves per level: rootSpacing / 2^level).
    for (i, node) in opened.nodes.iter().enumerate().skip(1) {
        let parent = opened.nodes.iter().position(|p| p.level + 1 == node.level && p.key.map(|k| k * 2) == node.key.map(|k| k & !1));
        assert!(parent.is_some_and(|p| opened.children(p).contains(&i)), "node {i} has a parent listing it");
    }
    let centre = m.centroid;
    for budget in [1_000u64, 20_000, 50_000, 200_000] {
        let selected = opened.lod_budget(&centre, budget, None);
        let count: u64 = selected.iter().map(|&i| u64::from(opened.nodes[i].point_count)).sum();
        assert!(count <= budget, "budget {budget}: {count}");
        for &i in &selected {
            if i != 0 {
                let parent = (0..opened.nodes.len()).find(|&p| opened.children(p).contains(&i)).unwrap();
                assert!(selected.contains(&parent), "budget {budget}: node {i} selected without its parent");
            }
        }
    }
    assert_eq!(opened.lod_budget(&centre, 200_000, None).len(), opened.nodes.len());
    // Same bytes on two runs and for any thread count.
    let cloud = read(&source, &options).unwrap();
    let a = asset::build(&cloud, KEY, SHA, "test", &options).unwrap();
    let b = rayon::ThreadPoolBuilder::new()
        .num_threads(1)
        .build()
        .unwrap()
        .install(|| asset::build(&cloud, KEY, SHA, "test", &options).unwrap());
    assert_eq!(a.nodes, b.nodes);
    assert_eq!(a.hierarchy, b.hierarchy);
    assert_eq!(a.manifest.canonical_json(), b.manifest.canonical_json());
}

#[test]
fn vc_scn_12_nearest_point_on_the_coloured_cube() {
    let opened = import(&data("e57/ColouredCubeFloat.e57"), &temp_dir("vc12"), &ImportOptions::default());
    let (record, position, distance, second) = opened.nearest(&[0.6, 0.6, 0.6], 1.0).unwrap().unwrap();
    assert_eq!(record, 6606);
    assert!(
        (position[0] - 0.4936402).abs() < 1e-6 && (position[1] - 0.4993396).abs() < 1e-6 && (position[2] - 0.5).abs() < 1e-6,
        "{position:?}"
    );
    assert!((distance - 0.1773272).abs() < 1e-6, "{distance}");
    assert!(second - distance > 0.01, "second nearest {second}");
    assert!(opened.nearest(&[0.6, 0.6, 0.6], 0.1).unwrap().is_none());
}

#[test]
fn float_sources_are_stored_within_half_a_quantum_and_corruption_is_detected() {
    let dir = temp_dir("bunny");
    let source = data("e57/bunnyDouble.e57");
    let cloud = read(&source, &ImportOptions::default()).unwrap();
    let opened = import(&source, &dir, &ImportOptions { max_points_per_node: 5000, ..ImportOptions::default() });
    let q = opened.manifest.quantum[0];
    assert_eq!(q, 1e-7);
    let points = opened.all_points().unwrap();
    for (p, r) in points.positions.iter().zip(&points.record_index) {
        let t = cloud.positions[*r as usize];
        assert!((0..3).all(|a| (p[a] - t[a]).abs() <= 0.5 * q + 1e-15), "record {r}");
    }
    let mut bytes = std::fs::read(dir.join("nodes.bin")).unwrap();
    bytes[0] ^= 0xFF;
    std::fs::write(dir.join("nodes.bin"), bytes).unwrap();
    assert_eq!(opened.read_node(0).unwrap_err().code, "SCN_ASSET_MISSING");
    assert_eq!(Asset::open(&dir, Some(SHA)).err().unwrap().code, "SCN_ASSET_MISSING");
}
