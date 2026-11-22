//! Hi-Z occlusion culling of the scene fill (plant 09 TR-VIS-24): the culled fill must equal the unculled fill buffer for buffer
//! (depth and face), on scenes with heavy occlusion (a row of equipment behind walls), with none, and with ties and hostile input.
//! `hiz_measurement` (ignored) prints the 1M-triangle timings quoted in the spec: `cargo test --release -- --ignored --nocapture`.

use llull_raster::scene::{Projection, Scene};
use llull_raster::scene_cpu;
use llull_raster::scene_hiz::{fill_all_with, Hiz, HizStats, HIZ_MIN_FILLS};
use std::time::Instant;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) as f64) / f64::from(1u32 << 31)
    }
}

struct Builder(Scene);

impl Builder {
    fn new(width: usize, height: usize, samples: usize) -> Self {
        Builder(Scene {
            width,
            height,
            samples,
            projection: Projection::Orthographic,
            depth_jump: 0.5,
            crease_cos: 0.9,
            faces: Vec::new(),
            fills: Vec::new(),
            loops: Vec::new(),
            points: Vec::new(),
            strokes: Vec::new(),
        })
    }

    fn face(&mut self, owner: f64) -> f64 {
        let id = (self.0.faces.len() / 8) as f64;
        self.0.faces.extend([40.0 + owner % 200.0, 120.0, 200.0 - owner % 150.0, 0.0, 0.0, 1.0, owner, 0.0]);
        id
    }

    fn polygon(&mut self, face: f64, pts: &[[f64; 3]]) {
        let (first_loop, first_point) = (self.0.loops.len() / 2, self.0.points.len() / 3);
        self.0.fills.extend([face, first_loop as f64, 1.0]);
        self.0.loops.extend([first_point as f64, pts.len() as f64]);
        for p in pts {
            self.0.points.extend(p);
        }
    }

    /// `tris` small sloped triangles spread over a square of `size` pixels at depth `z` (z grows away from the viewer).
    fn block(&mut self, face: f64, x: f64, y: f64, size: f64, z: f64, tris: usize) {
        for k in 0..tris {
            let t = k as f64 / tris as f64;
            let (ox, oy) = (x + size * t, y + size * (1.0 - t) * 0.5);
            self.polygon(face, &[[ox, oy, z + t], [ox + size * 0.2, oy, z + t * 0.5], [ox, oy + size * 0.2, z + 1.0 - t]]);
        }
    }
}

fn identical(scene: &Scene) -> HizStats {
    let (plain, off) = fill_all_with(scene, Hiz::Off);
    let (culled, on) = fill_all_with(scene, Hiz::On);
    assert!(!off.enabled && on.enabled);
    let bits = |buffer: &[f32]| buffer.iter().map(|d| d.to_bits()).collect::<Vec<_>>();
    assert_eq!(bits(&plain.depth), bits(&culled.depth));
    assert_eq!(plain.face, culled.face);
    on
}

/// Walls near the viewer across the picture, equipment behind (most hidden, some beside the walls), a few in front.
fn plant_row(blocks: usize, per_block: usize) -> Scene {
    let mut b = Builder::new(320, 240, 2);
    let mut rng = Rng(7);
    let wall = b.face(1.0);
    for k in 0..6 {
        let x = 20.0 + f64::from(k) * 50.0;
        b.polygon(wall, &[[x, 40.0, 1.0], [x + 40.0, 40.0, 1.0], [x + 40.0, 200.0, 1.0], [x, 200.0, 1.0]]);
    }
    for k in 0..blocks {
        let face = b.face(10.0 + k as f64);
        let z = if k % 17 == 0 { 0.5 } else { 5.0 + rng.next() * 20.0 };
        b.block(face, rng.next() * 300.0, rng.next() * 220.0, 6.0 + rng.next() * 30.0, z, per_block);
    }
    b.0
}

#[test]
fn culled_fill_equals_unculled_with_heavy_occlusion() {
    let scene = plant_row(300, 40);
    let stats = identical(&scene);
    assert!(stats.culled * 2 > stats.fills / 2, "much of the equipment is behind the walls: {stats:?}");
    assert!(stats.culled > 0 && stats.occluders > 0);
}

#[test]
fn culled_fill_equals_unculled_without_occlusion() {
    let mut b = Builder::new(200, 150, 2);
    for gy in 0..14 {
        for gx in 0..18 {
            let face = b.face(f64::from(gy * 18 + gx));
            let (x, y) = (f64::from(gx) * 11.0, f64::from(gy) * 10.0);
            b.polygon(face, &[[x, y, 3.0], [x + 9.0, y, 3.0], [x + 9.0, y + 8.0, 3.0]]);
        }
    }
    assert_eq!(identical(&b.0).culled, 0);
}

#[test]
fn ties_far_faces_and_hostile_input_never_change_the_picture() {
    let mut b = Builder::new(100, 80, 1);
    let (near, same, far) = (b.face(1.0), b.face(2.0), b.face(3.0));
    let quad = |z: f64| [[0.0, 0.0, z], [100.0, 0.0, z], [100.0, 80.0, z], [0.0, 80.0, z]];
    b.polygon(near, &quad(2.0));
    b.polygon(same, &quad(2.0));
    b.polygon(far, &quad(4.0));
    b.polygon(far, &[[f64::NAN, 1.0, 1.0], [20.0, 5.0, 1.0], [5.0, 9.0, 1.0]]);
    b.polygon(far, &[[-500.0, -500.0, 9.0], [5000.0, -500.0, 9.0], [5000.0, 5000.0, 9.0]]);
    b.polygon(far, &[[10.0, 10.0, 3.0], [50.0, 10.0, 3.0], [90.0, 10.0, 3.0]]);
    b.polygon(far, &[[200.0, 200.0, 3.0], [210.0, 200.0, 3.0], [200.0, 210.0, 3.0]]);
    let stats = identical(&b.0);
    assert!(stats.culled >= 1);
    let (buffers, _) = fill_all_with(&b.0, Hiz::On);
    assert_eq!(buffers.face[40 * 100 + 50], near as i32, "the first of two equal-depth faces keeps the pixel");
}

#[test]
fn auto_culls_only_from_the_size_threshold() {
    let small = plant_row(10, 5);
    assert!(!fill_all_with(&small, Hiz::Auto).1.enabled);
    let large = plant_row(HIZ_MIN_FILLS / 40 + 50, 40);
    let (_, stats) = fill_all_with(&large, Hiz::Auto);
    assert!(stats.enabled && stats.culled > 0);
    let (mut buffers, _) = fill_all_with(&large, Hiz::Off);
    scene_cpu::draw_strokes(&large, &mut buffers);
    assert_eq!(scene_cpu::raster_pixels(&large), scene_cpu::resolve(&large, &buffers));
}

#[test]
fn empty_scene_is_fine() {
    let scene = Builder::new(10, 10, 1).0;
    assert_eq!(identical(&scene).fills, 0);
}

#[test]
#[ignore = "measurement: prints timings"]
fn hiz_measurement() {
    for (label, blocks, per) in [
        ("2k", 20, 100),
        ("5k", 50, 100),
        ("10k", 100, 100),
        ("20k", 200, 100),
        ("50k", 500, 100),
        ("100k", 1000, 100),
        ("200k", 2000, 100),
        ("300k", 3000, 100),
        ("500k", 5000, 100),
        ("1M", 1000, 1000),
        ("1M dense", 5000, 200),
    ] {
        let mut b = Builder::new(1600, 1200, 2);
        let mut rng = Rng(11);
        let wall = b.face(1.0);
        for k in 0..16 {
            for j in 0..10 {
                let (x, y) = (50.0 + f64::from(k) * 95.0, 40.0 + f64::from(j) * 110.0);
                b.polygon(wall, &[[x, y, 1.0], [x + 85.0, y, 1.0], [x + 85.0, y + 100.0, 1.0], [x, y + 100.0, 1.0]]);
            }
        }
        for k in 0..blocks {
            let face = b.face(10.0 + k as f64);
            let z = if k % 20 == 0 { 0.5 } else { 5.0 + rng.next() * 20.0 };
            b.block(face, rng.next() * 1500.0, rng.next() * 1100.0, 20.0 + rng.next() * 60.0, z, per);
        }
        let scene = b.0;
        let time = |mode| {
            let start = Instant::now();
            let (_, stats) = fill_all_with(&scene, mode);
            (start.elapsed().as_secs_f64() * 1000.0, stats)
        };
        let (off, _) = time(Hiz::Off);
        let (on, stats) = time(Hiz::On);
        let share = 100.0 * stats.culled as f64 / stats.fills as f64;
        println!(
            "{label}: fills {} off {off:.0} ms on {on:.0} ms culled {} ({share:.1}%) occluders {}",
            stats.fills, stats.culled, stats.occluders
        );
        identical(&scene);
    }
}

/// Reviewer's case: `fill` computes a span end as p.x + t * (q.x - p.x), which can round one ulp past the vertex and write a column the
/// vertex box does not cover.
#[test]
fn span_end_rounding_past_the_vertex_box_is_not_culled() {
    let mut b = Builder::new(64, 32, 1);
    let (occluder, target) = (b.face(1.0), b.face(2.0));
    b.polygon(occluder, &[[0.0, 0.0, 1.0], [48.4, 0.0, 1.0], [48.4, 32.0, 1.0], [0.0, 32.0, 1.0]]);
    b.polygon(
        target,
        &[
            [6.043520814290471, 5.385920643446412, 5.0],
            [48.49999999999999, 14.500000000000002, 5.0],
            [6.043520814290471, 14.500000000000002, 5.0],
        ],
    );
    identical(&b.0);
}

fn near_boundary(rng: &mut Rng, limit: u32) -> f64 {
    let centre = f64::from((rng.next() * f64::from(limit)) as u32) + 0.5;
    match (rng.next() * 4.0) as u32 {
        0 => centre.next_down(),
        1 => centre.next_up(),
        2 => centre,
        _ => centre + (rng.next() - 0.5) * 1e-9,
    }
}

#[test]
fn float_boundary_geometry_fuzz_is_bit_identical() {
    let mut rng = Rng(99);
    for _ in 0..600 {
        let mut b = Builder::new(64, 32, 1);
        let face = b.face(1.0);
        for _ in 0..3 {
            let (x, y) = (near_boundary(&mut rng, 64), near_boundary(&mut rng, 32));
            let (w, h) = (20.0 + rng.next() * 44.0, 10.0 + rng.next() * 22.0);
            b.polygon(
                face,
                &[[x, y, 1.0 + rng.next()], [x + w, y, 1.0 + rng.next()], [x + w, y + h, 1.0 + rng.next()], [x, y + h, 1.0 + rng.next()]],
            );
        }
        for _ in 0..40 {
            let pts: Vec<[f64; 3]> =
                (0..3).map(|_| [near_boundary(&mut rng, 64), near_boundary(&mut rng, 32), 3.0 + rng.next() * 6.0]).collect();
            b.polygon(face, &pts);
        }
        identical(&b.0);
    }
}
