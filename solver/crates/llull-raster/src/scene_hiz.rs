//! Hi-Z occlusion culling of the scene fill (plant 09 TR-VIS-24): a conservative occluder pass (the fills with the largest screen
//! boxes) fills a scratch depth buffer, a max-depth pyramid is built from it, and every fill (and every chunk of consecutive fills) whose
//! screen box lies strictly behind the pyramid's farthest occluder depth is skipped. A skipped fill could not pass the depth test at any
//! pixel (final depth is never farther than the occluder depth), and the strict margin removes every tie and float32 rounding case, so the
//! buffers are identical to the unculled fill; the cull is a speed-up, never a change of picture. Deterministic: fixed chunking, area
//! ordering with an index tie-break, no timing input.

use crate::scene::Scene;
use crate::scene_cpu::{depth_plane, fill_loops, fill_record, fill_record_depth, SceneBuffers};
use rayon::prelude::*;

/// Culling policy: `Auto` enables it from `HIZ_MIN_FILLS` fills (measured, TECHNICAL_SPEC 12.28).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hiz {
    Auto,
    Off,
    On,
}

/// Fill count from which `Hiz::Auto` culls (below it the pyramid costs more than it saves).
pub const HIZ_MIN_FILLS: usize = 400_000;
const CHUNK: usize = 64;
const X_LIMIT: f64 = 1_099_511_627_776.0;
const MIN_OCCLUDER_PIXELS: usize = 64;

/// What one fill pass did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HizStats {
    pub enabled: bool,
    pub fills: usize,
    pub occluders: usize,
    pub culled: usize,
}

/// Screen pixel box (inclusive, in buffer pixels) and the depth range of a fill.
#[derive(Debug, Clone, Copy)]
enum Bound {
    /// Writes no pixel (edge-on, off screen, no pixel centre inside).
    Empty,
    /// Not finite: never culled.
    Unbounded,
    Boxed {
        x0: usize,
        x1: usize,
        y0: usize,
        y1: usize,
        zmin: f64,
        zmax: f64,
    },
}

fn bound_of(scene: &Scene, record: &[f64]) -> Bound {
    let (w, h) = scene.buffer_size();
    let loops = fill_loops(scene, record);
    let all: Vec<_> = loops.iter().flatten().copied().collect();
    if all.iter().any(|p| !(p.x.is_finite() && p.y.is_finite() && p.z.is_finite())) {
        return Bound::Unbounded;
    }
    let Some(depth_at) = depth_plane(&all) else { return Bound::Empty };
    let (mut left, mut right, mut top, mut bottom) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    let (mut zmin, mut zmax) = (f64::INFINITY, f64::NEG_INFINITY);
    for p in &all {
        left = left.min(p.x);
        right = right.max(p.x);
        top = top.min(p.y);
        bottom = bottom.max(p.y);
        let z = depth_at(p.x, p.y);
        zmin = zmin.min(z);
        zmax = zmax.max(z);
    }
    if !(zmin.is_finite() && zmax.is_finite()) {
        return Bound::Unbounded;
    }
    if left.abs() > X_LIMIT || right.abs() > X_LIMIT {
        return Bound::Unbounded;
    }
    // Rows are exactly `fill`'s; columns come from interpolated crossings that can round one ulp past a vertex, so pad by one pixel.
    let (x0, x1) = (((left - 0.5).ceil() - 1.0).max(0.0), ((right - 0.5).floor() + 1.0).min(w as f64 - 1.0));
    let (y0, y1) = ((top - 0.5).ceil().max(0.0), (bottom - 0.5).floor().min(h as f64 - 1.0));
    if y0 > y1 {
        return Bound::Empty;
    }
    if x0 > x1 {
        return Bound::Unbounded;
    }
    Bound::Boxed { x0: x0 as usize, x1: x1 as usize, y0: y0 as usize, y1: y1 as usize, zmin, zmax }
}

/// Max-depth pyramid over the scratch depth: level 0 is the buffer, each next level takes the max of 2x2 cells (+inf = nothing drawn).
struct Pyramid {
    levels: Vec<(usize, usize, Vec<f32>)>,
}

impl Pyramid {
    fn build(depth: Vec<f32>, w: usize, h: usize) -> Self {
        let mut levels = vec![(w, h, depth)];
        while levels.last().is_some_and(|(lw, lh, _)| *lw > 1 || *lh > 1) {
            let (lw, lh, below) = levels.last().expect("non-empty");
            let (nw, nh) = (lw.div_ceil(2), lh.div_ceil(2));
            let mut next = vec![0.0f32; nw * nh];
            for y in 0..nh {
                for x in 0..nw {
                    let mut m = f32::NEG_INFINITY;
                    for sy in (y * 2)..(y * 2 + 2).min(*lh) {
                        for sx in (x * 2)..(x * 2 + 2).min(*lw) {
                            m = m.max(below[sy * lw + sx]);
                        }
                    }
                    next[y * nw + x] = m;
                }
            }
            levels.push((nw, nh, next));
        }
        Pyramid { levels }
    }

    /// Farthest occluder depth over the pixel box (an upper bound of the depth any pixel of it can end with).
    fn max_over(&self, x0: usize, x1: usize, y0: usize, y1: usize) -> f64 {
        let mut level = 0;
        while level + 1 < self.levels.len() && ((x1 >> level) - (x0 >> level) > 3 || (y1 >> level) - (y0 >> level) > 3) {
            level += 1;
        }
        let (lw, _, cells) = &self.levels[level];
        let mut m = f32::NEG_INFINITY;
        for y in (y0 >> level)..=(y1 >> level) {
            for x in (x0 >> level)..=(x1 >> level) {
                m = m.max(cells[y * lw + x]);
            }
        }
        f64::from(m)
    }
}

/// True when every pixel of the box ends nearer than the box's nearest possible depth (strict, with a float32 / rounding margin).
fn hidden(pyramid: &Pyramid, x0: usize, x1: usize, y0: usize, y1: usize, zmin: f64, zmax: f64) -> bool {
    let farthest = pyramid.max_over(x0, x1, y0, y1);
    zmin - 1e-6 * zmin.abs().max(zmax.abs()).max(farthest.abs()) > farthest
}

fn occluder_pass(scene: &Scene, bounds: &[Bound]) -> (Pyramid, usize) {
    let (w, h) = scene.buffer_size();
    let mut candidates: Vec<(usize, usize)> = bounds
        .iter()
        .enumerate()
        .filter_map(|(i, b)| match b {
            Bound::Boxed { x0, x1, y0, y1, .. } if (x1 - x0 + 1) * (y1 - y0 + 1) >= MIN_OCCLUDER_PIXELS => {
                Some(((x1 - x0 + 1) * (y1 - y0 + 1), i))
            }
            _ => None,
        })
        .collect();
    let take = (bounds.len() / 64).clamp(32, 2048).min(candidates.len());
    let order = |a: &(usize, usize), b: &(usize, usize)| b.0.cmp(&a.0).then(a.1.cmp(&b.1));
    if take > 0 && take < candidates.len() {
        candidates.select_nth_unstable_by(take - 1, order);
    }
    candidates.truncate(take);
    candidates.sort_unstable_by(order);
    let mut scratch = vec![f32::INFINITY; w * h];
    for (_, index) in &candidates {
        fill_record_depth(scene, &mut scratch, *index);
    }
    (Pyramid::build(scratch, w, h), candidates.len())
}

fn union_box(bounds: &[Bound]) -> Option<(usize, usize, usize, usize, f64, f64)> {
    let mut union: Option<(usize, usize, usize, usize, f64, f64)> = None;
    for b in bounds {
        match *b {
            Bound::Empty => {}
            Bound::Unbounded => return None,
            Bound::Boxed { x0, x1, y0, y1, zmin, zmax } => {
                union = Some(match union {
                    None => (x0, x1, y0, y1, zmin, zmax),
                    Some((ux0, ux1, uy0, uy1, uz0, uz1)) => {
                        (ux0.min(x0), ux1.max(x1), uy0.min(y0), uy1.max(y1), uz0.min(zmin), uz1.max(zmax))
                    }
                });
            }
        }
    }
    union
}

/// The filled faces of `scene` in draw order, culled by Hi-Z per `mode`; the buffers equal the unculled fill exactly.
pub fn fill_all_with(scene: &Scene, mode: Hiz) -> (SceneBuffers, HizStats) {
    let fills = scene.fills.len() / 3;
    let mut buffers = SceneBuffers::empty(scene);
    let enabled = mode == Hiz::On || (mode == Hiz::Auto && fills >= HIZ_MIN_FILLS);
    if !enabled {
        for index in 0..fills {
            fill_record(scene, &mut buffers, index);
        }
        return (buffers, HizStats { enabled, fills, ..HizStats::default() });
    }
    let bounds: Vec<Bound> = scene.fills.par_chunks_exact(3).map(|record| bound_of(scene, record)).collect();
    let (pyramid, occluders) = occluder_pass(scene, &bounds);
    let mut stats = HizStats { enabled, fills, occluders, culled: 0 };
    for (chunk_index, chunk) in bounds.chunks(CHUNK).enumerate() {
        let first = chunk_index * CHUNK;
        if let Some((x0, x1, y0, y1, zmin, zmax)) = union_box(chunk) {
            if hidden(&pyramid, x0, x1, y0, y1, zmin, zmax) {
                stats.culled += chunk.iter().filter(|b| matches!(b, Bound::Boxed { .. })).count();
                continue;
            }
        }
        for (offset, bound) in chunk.iter().enumerate() {
            match *bound {
                Bound::Empty => {}
                Bound::Boxed { x0, x1, y0, y1, zmin, zmax } if hidden(&pyramid, x0, x1, y0, y1, zmin, zmax) => stats.culled += 1,
                _ => fill_record(scene, &mut buffers, first + offset),
            }
        }
    }
    (buffers, stats)
}
