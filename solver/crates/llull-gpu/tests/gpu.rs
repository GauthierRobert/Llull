//! GPU fixed-order dot vs the CPU twin. Runs where an adapter exists (a software one such as lavapipe counts) and skips with
//! the logged reason otherwise (RS1 §2 rule 6).
#![cfg(feature = "wgpu")]

use llull_gpu::buffers::storage_f32;
use llull_gpu::device::acquire;
use llull_gpu::dot::FixedOrderDot;
use llull_gpu::reduce;

#[test]
fn gpu_dot_matches_the_cpu_twin_and_repeats_bit_for_bit() {
    let gpu = match acquire("llull-gpu test") {
        Ok(gpu) => gpu,
        Err(reason) => {
            eprintln!("skipped: GPU unavailable ({reason})");
            return;
        }
    };
    eprintln!("adapter: {}", gpu.adapter);
    for n in [1usize, 255, 4096, 4097, 100_003] {
        let a: Vec<f32> = (0..n).map(|i| ((i * 37) % 101) as f32 / 101.0 - 0.3).collect();
        let b: Vec<f32> = (0..n).map(|i| ((i * 11) % 53) as f32 / 53.0 + 0.1).collect();
        let (ga, gb) = (storage_f32(&gpu, "a", &a), storage_f32(&gpu, "b", &b));
        let dot = FixedOrderDot::new(&gpu, n);
        let first = dot.dot(&gpu, &ga, &gb).unwrap();
        let second = dot.dot(&gpu, &ga, &gb).unwrap();
        assert_eq!(first.to_bits(), second.to_bits(), "n = {n}: the GPU dot is not reproducible");
        let a64: Vec<f64> = a.iter().map(|&v| f64::from(v)).collect();
        let b64: Vec<f64> = b.iter().map(|&v| f64::from(v)).collect();
        let cpu = reduce::dot(&a64, &b64);
        let scale: f64 = a64.iter().zip(&b64).map(|(p, q)| (p * q).abs()).sum::<f64>().max(1e-30);
        assert!((first - cpu).abs() / scale < 1e-6, "n = {n}: gpu {first} vs cpu {cpu}");
    }
}
