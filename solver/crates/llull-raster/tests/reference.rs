//! CPU twin vs the TypeScript raster (VC-FEA-29 at crate level): `tests/unit/native/rasterReference.test.ts` writes the per-face stage
//! output and the sha256 of the RGBA / depth buffers `rasterPixels` produced; the twin must hash identically. With the `gpu` feature the
//! wgpu path is also run when an adapter exists (else skipped with the reason), and compared by pixel agreement, not by hash.

use llull_protocol::sha256_hex;
use llull_raster::{Prepared, RasterJob};
use serde_json::Value;

fn numbers(value: &Value) -> Vec<f64> {
    value.as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect()
}

fn cases() -> Vec<(String, Prepared, String, String)> {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/raster.json")).unwrap();
    let all: Value = serde_json::from_str(&text).unwrap();
    all.as_array()
        .unwrap()
        .iter()
        .map(|case| {
            let job: RasterJob = serde_json::from_value(case["job"].clone()).unwrap();
            let prepared = Prepared {
                width: job.width,
                height: job.height,
                samples: job.samples,
                clip: job.clip,
                ghost: job.ghost,
                ghost_triangles: numbers(&case["ghost"]),
                triangles: numbers(&case["triangles"]),
                light: numbers(&case["light"]),
                normals: numbers(&case["normals"]),
                owners: numbers(&case["owners"]),
                caps: numbers(&case["caps"]),
                low: job.low,
                step: job.step,
                palette: job.palette,
                jump: job.jump,
                show_mesh: job.show_mesh,
                crease_cos: job.crease_cos,
            };
            llull_raster::check(&prepared).unwrap();
            let hashes = (case["rgbaSha256"].as_str().unwrap().to_string(), case["depthSha256"].as_str().unwrap().to_string());
            (case["name"].as_str().unwrap().to_string(), prepared, hashes.0, hashes.1)
        })
        .collect()
}

fn depth_bytes(depth: &[f32]) -> Vec<u8> {
    depth.iter().flat_map(|v| v.to_le_bytes()).collect()
}

#[test]
fn cpu_twin_is_bit_identical_to_the_typescript_raster() {
    let all = cases();
    assert_eq!(all.len(), 3);
    for (name, prepared, rgba_sha, depth_sha) in all {
        let (rgba, depth) = llull_raster::cpu::raster_pixels(&prepared);
        assert_eq!(sha256_hex(&rgba), rgba_sha, "{name}: rgba");
        assert_eq!(sha256_hex(&depth_bytes(&depth)), depth_sha, "{name}: depth");
    }
}

#[test]
fn malformed_inputs_are_refused() {
    let (_, mut prepared, _, _) = cases().remove(0);
    prepared.light.pop();
    assert!(llull_raster::check(&prepared).is_err());
    let (_, mut clipped, _, _) = cases().remove(0);
    clipped.clip.right = 1e9;
    assert!(llull_raster::check(&clipped).is_err());
}

#[cfg(feature = "gpu")]
#[test]
fn gpu_path_agrees_with_the_cpu_twin_on_most_pixels() {
    for (name, prepared, _, _) in cases() {
        match llull_raster::gpu::raster_pixels(&prepared) {
            Err(reason) => {
                eprintln!("gpu raster test skipped: {reason}");
                return;
            }
            Ok((rgba, _, adapter)) => {
                let (reference, _) = llull_raster::cpu::raster_pixels(&prepared);
                let differing = rgba.chunks_exact(4).zip(reference.chunks_exact(4)).filter(|(a, b)| a != b).count();
                let share = differing as f64 / (prepared.width * prepared.height) as f64;
                eprintln!("{name} on {adapter}: {:.3} % of pixels differ", share * 100.0);
                assert!(share < 0.05, "{name}: {share}");
            }
        }
    }
}
