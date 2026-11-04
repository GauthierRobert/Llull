//! Build time of the instance BVH on seeded boxes: `cargo run --release -p llull-bvh --example build_bench -- 1000000`.
use llull_bvh::instance::InstanceBvh;
use std::time::Instant;

fn main() {
    let count: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(1_000_000);
    let mut state: u64 = 12345;
    let mut next = move || {
        state = (state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407)) >> 11;
        state as f64 / (1_u64 << 53) as f64
    };
    let mut boxes = Vec::with_capacity(count * 6);
    for _ in 0..count {
        let min = [next() * 2000.0 - 1000.0, next() * 2000.0 - 1000.0, next() * 400.0];
        boxes.extend([min[0], min[1], min[2], min[0] + next() * 3.0, min[1] + next() * 3.0, min[2] + next() * 3.0]);
    }
    for run in 0..3 {
        let start = Instant::now();
        let bvh = InstanceBvh::build(&boxes);
        println!("run {run}: build {count} boxes in {:.0} ms, {} nodes", start.elapsed().as_secs_f64() * 1000.0, bvh.node_start.len());
    }
}
