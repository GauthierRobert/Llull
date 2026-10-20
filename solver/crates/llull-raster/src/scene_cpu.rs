//! CPU twin of `rasterScenePixels` (`packages/core/src/commands/render/raster.ts`): the same even-odd scanline fill with an affine depth
//! plane, float32 depth buffer, depth-tested strokes, outline rule and supersample resolve, in the same operation order, so the RGBA is
//! bit-identical to the TypeScript reference. Fills and strokes run in draw order (single thread: later draws depend on earlier depths);
//! outline and resolve rows run in parallel.

use crate::scene::{Projection, Scene};
use llull_jsmath::{hypot, round};
use rayon::prelude::*;

#[derive(Debug, Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
    z: f64,
}

/// Supersampled z-buffer: nearest z (float32, +inf empty) and the face index drawn (-1 empty). The GPU path fills the same buffers.
pub struct SceneBuffers {
    pub depth: Vec<f32>,
    pub face: Vec<i32>,
}

impl SceneBuffers {
    pub fn empty(scene: &Scene) -> Self {
        let (w, h) = scene.buffer_size();
        SceneBuffers { depth: vec![f32::INFINITY; w * h], face: vec![-1; w * h] }
    }
}

/// `depthPlane`: z as an affine function of the screen position from the best-conditioned corner triple, or None (edge-on face).
fn depth_plane(points: &[Point]) -> Option<impl Fn(f64, f64) -> f64> {
    let a = *points.first()?;
    let mut best: Option<(f64, Point, Point)> = None;
    for i in 1..points.len() {
        for j in i + 1..points.len() {
            let (b, c) = (points[i], points[j]);
            let det = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
            if best.is_none_or(|(best_det, _, _)| det.abs() > best_det.abs()) {
                best = Some((det, b, c));
            }
            if points.len() > 8 && best.is_some_and(|(best_det, _, _)| best_det.abs() > 1.0) {
                break;
            }
        }
    }
    let (det, b, c) = best?;
    if det.abs() < 1e-9 {
        return None;
    }
    let dzdx = ((b.z - a.z) * (c.y - a.y) - (c.z - a.z) * (b.y - a.y)) / det;
    let dzdy = ((c.z - a.z) * (b.x - a.x) - (b.z - a.z) * (c.x - a.x)) / det;
    Some(move |x: f64, y: f64| a.z + dzdx * (x - a.x) + dzdy * (y - a.y))
}

/// Even-odd scanline fill of `loops` with a depth test (strictly nearer wins).
fn fill(buffers: &mut SceneBuffers, w: usize, h: usize, loops: &[Vec<Point>], face: i32) {
    let all: Vec<Point> = loops.iter().flatten().copied().collect();
    let Some(depth_at) = depth_plane(&all) else { return };
    let (mut top, mut bottom) = (f64::INFINITY, f64::NEG_INFINITY);
    for p in &all {
        top = top.min(p.y);
        bottom = bottom.max(p.y);
    }
    let y0 = (top - 0.5).ceil().max(0.0);
    let y1 = (bottom - 0.5).floor().min(h as f64 - 1.0);
    let mut crossings: Vec<f64> = Vec::new();
    let mut y = y0;
    while y <= y1 {
        let sy = y + 0.5;
        crossings.clear();
        for ring in loops {
            for i in 0..ring.len() {
                let (p, q) = (ring[i], ring[(i + 1) % ring.len()]);
                if p.y == q.y {
                    continue;
                }
                if (sy >= p.y && sy < q.y) || (sy >= q.y && sy < p.y) {
                    crossings.push(p.x + ((sy - p.y) / (q.y - p.y)) * (q.x - p.x));
                }
            }
        }
        crossings.sort_by(f64::total_cmp);
        let mut k = 0;
        while k + 1 < crossings.len() {
            let xa = (crossings[k] - 0.5).ceil().max(0.0);
            let xb = (crossings[k + 1] - 0.5).floor().min(w as f64 - 1.0);
            let mut x = xa;
            while x <= xb {
                let index = y as usize * w + x as usize;
                let z = depth_at(x + 0.5, sy);
                if z < f64::from(buffers.depth[index]) {
                    buffers.depth[index] = z as f32;
                    buffers.face[index] = face;
                }
                x += 1.0;
            }
            k += 2;
        }
        y += 1.0;
    }
}

/// The filled faces of `scene` in draw order (the stage the GPU path replaces).
pub fn fill_all(scene: &Scene) -> SceneBuffers {
    let (w, h) = scene.buffer_size();
    let mut buffers = SceneBuffers::empty(scene);
    let point = |index: usize| Point { x: scene.points[index * 3], y: scene.points[index * 3 + 1], z: scene.points[index * 3 + 2] };
    for fill_record in scene.fills.chunks_exact(3) {
        let (first_loop, loop_count) = (fill_record[1] as usize, fill_record[2] as usize);
        let loops: Vec<Vec<Point>> = (first_loop..first_loop + loop_count)
            .map(|l| {
                let (first, count) = (scene.loops[l * 2] as usize, scene.loops[l * 2 + 1] as usize);
                (first..first + count).map(point).collect()
            })
            .collect();
        fill(&mut buffers, w, h, &loops, fill_record[0] as i32);
    }
    buffers
}

/// Depth-tested strokes (2D sketches), in draw order, pulled toward the viewer by their bias.
pub fn draw_strokes(scene: &Scene, buffers: &mut SceneBuffers) {
    let (w, h) = scene.buffer_size();
    for s in scene.strokes.chunks_exact(9) {
        let (face, ax, ay, az, bx, by, bz, half_width, bias) = (s[0] as i32, s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8]);
        let steps = hypot(&[bx - ax, by - ay]).ceil().max(1.0);
        let radius = half_width.ceil() as i64;
        let mut k = 0.0;
        while k <= steps {
            let t = k / steps;
            let cx = ax + (bx - ax) * t;
            let cy = ay + (by - ay) * t;
            let z = az + (bz - az) * t - bias;
            for dy in -radius..=radius {
                for dx in -radius..=radius {
                    let x = cx.floor() as i64 + dx;
                    let y = cy.floor() as i64 + dy;
                    if x < 0 || y < 0 || x >= w as i64 || y >= h as i64 || (dx * dx + dy * dy) as f64 > half_width * half_width + 0.5 {
                        continue;
                    }
                    let index = y as usize * w + x as usize;
                    if z > f64::from(buffers.depth[index]) {
                        continue;
                    }
                    buffers.face[index] = face;
                }
            }
            k += 1.0;
        }
    }
}

/// Outline mask: crease, depth jump (linear depth), owner change, silhouette; strokes never outline.
fn outline(scene: &Scene, buffers: &SceneBuffers) -> Vec<u8> {
    let (w, h) = scene.buffer_size();
    let faces = &scene.faces;
    let linear = |z: f32| if scene.projection == Projection::Perspective { -1.0 / f64::from(z) } else { f64::from(z) };
    let is_line = |f: i32| f >= 0 && (faces[f as usize * 8 + 7] as i64) & 2 != 0;
    let differs = |a: usize, b: usize| -> bool {
        let (fa, fb) = (buffers.face[a], buffers.face[b]);
        if is_line(fa) || is_line(fb) {
            return false;
        }
        if fa < 0 || fb < 0 {
            return fa != fb;
        }
        if fa == fb {
            return false;
        }
        let (fa, fb) = (fa as usize, fb as usize);
        if faces[fa * 8 + 6] != faces[fb * 8 + 6] {
            return true;
        }
        if (linear(buffers.depth[a]) - linear(buffers.depth[b])).abs() > scene.depth_jump {
            return true;
        }
        let mut cos = 0.0;
        for k in 3..6 {
            cos += faces[fa * 8 + k] * faces[fb * 8 + k];
        }
        cos < scene.crease_cos
    };
    let mut edge = vec![0u8; w * h];
    edge.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (x, cell) in row.iter_mut().enumerate() {
            let index = y * w + x;
            if (x + 1 < w && differs(index, index + 1)) || (y + 1 < h && differs(index, index + w)) {
                *cell = 1;
            }
        }
    });
    edge
}

/// Outline + supersample resolve of finished buffers into the logical RGBA image.
pub fn resolve(scene: &Scene, buffers: &SceneBuffers) -> Vec<u8> {
    let (width, samples) = (scene.width, scene.samples);
    let (w, _) = scene.buffer_size();
    let edges = outline(scene, buffers);
    let faces = &scene.faces;
    let mut rgba = vec![0u8; scene.width * scene.height * 4];
    rgba.par_chunks_mut(width * 4).enumerate().for_each(|(y, row)| {
        for x in 0..width {
            let (mut r, mut g, mut b, mut a) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
            for dy in 0..samples {
                for dx in 0..samples {
                    let (sx, sy) = (x * samples + dx, y * samples + dy);
                    let index = sy * w + sx;
                    let f = buffers.face[index];
                    let edge = edges[index] == 1;
                    if f < 0 && !edge {
                        continue;
                    }
                    let hatch = f >= 0 && (faces[f as usize * 8 + 7] as i64) & 1 != 0;
                    let shade_by = (if edge { 0.35 } else { 1.0 }) * (if hatch && (sx + sy) % (6 * samples) < samples { 0.6 } else { 1.0 });
                    if f < 0 {
                        r += 20.0;
                        g += 20.0;
                        b += 30.0;
                    } else {
                        let base = f as usize * 8;
                        r += faces[base] * shade_by;
                        g += faces[base + 1] * shade_by;
                        b += faces[base + 2] * shade_by;
                    }
                    a += 255.0;
                }
            }
            let covered = a / 255.0;
            if covered == 0.0 {
                continue;
            }
            let out = x * 4;
            row[out] = round(r / covered) as u8;
            row[out + 1] = round(g / covered) as u8;
            row[out + 2] = round(b / covered) as u8;
            row[out + 3] = round(a / (samples * samples) as f64) as u8;
        }
    });
    rgba
}

/// RGBA of the logical image (bit-identical to `rasterScenePixels`).
pub fn raster_pixels(scene: &Scene) -> Vec<u8> {
    let mut buffers = fill_all(scene);
    draw_strokes(scene, &mut buffers);
    resolve(scene, &buffers)
}
