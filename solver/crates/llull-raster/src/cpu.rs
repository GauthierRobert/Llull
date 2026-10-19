//! CPU twin of `rasterPixels` (`packages/domain-cae/src/results/fieldRaster.ts`): same scan rule (pixel centres, barycentric slack 1e-9),
//! the same float32 depth / value buffers, edge kinds, band colouring and supersample resolve, so the RGBA and the depth buffer are
//! bit-identical to the TypeScript reference. Rows of the resolve run in parallel; each pixel depends on the finished z-buffer only.

use crate::{Prepared, Rect};
use llull_jsmath::round;
use rayon::prelude::*;

const GHOST: [f64; 3] = [154.0, 154.0, 184.0];
const GHOST_ALPHA: f64 = 0.3;

/// Calls `visit(index, z, v)` for every pixel centre inside the triangle (x, y, z, v per corner) and the clip rectangle.
fn scan(t: &[f64], clip: &Rect, width: usize, mut visit: impl FnMut(usize, f64, f64)) {
    let (ax, ay, az, av) = (t[0], t[1], t[2], t[3]);
    let (bx, by, bz, bv) = (t[4], t[5], t[6], t[7]);
    let (cx, cy, cz, cv) = (t[8], t[9], t[10], t[11]);
    let det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if det.abs() < 1e-12 || det.is_nan() {
        return;
    }
    let x0 = clip.left.max((ax.min(bx).min(cx) - 0.5).ceil());
    let x1 = (clip.right - 1.0).min((ax.max(bx).max(cx) - 0.5).floor());
    let y0 = clip.top.max((ay.min(by).min(cy) - 0.5).ceil());
    let y1 = (clip.bottom - 1.0).min((ay.max(by).max(cy) - 0.5).floor());
    let mut y = y0;
    while y <= y1 {
        let py = y + 0.5;
        let mut x = x0;
        while x <= x1 {
            let px = x + 0.5;
            let l0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / det;
            let l1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / det;
            let l2 = 1.0 - l0 - l1;
            if !(l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) {
                visit(y as usize * width + x as usize, l0 * az + l1 * bz + l2 * cz, l0 * av + l1 * bv + l2 * cv);
            }
            x += 1.0;
        }
        y += 1.0;
    }
}

/// The supersampled buffers of the z-buffer stage: nearest depth (float32), its interpolated value (float32), the triangle drawn (-1 none)
/// and the ghost coverage (empty without a ghost). The GPU path fills the same buffers and shares `resolve`.
pub struct ZBuffer {
    pub depth: Vec<f32>,
    pub value: Vec<f32>,
    pub triangle: Vec<i64>,
    pub ghost: Vec<u8>,
}

/// Z-buffer stage: ghost coverage, then the front-facing triangles in order (a pixel keeps the strictly nearest one).
pub fn zbuffer(p: &Prepared) -> ZBuffer {
    let (w, h) = (p.width * p.samples, p.height * p.samples);
    let mut depth = vec![f32::NEG_INFINITY; w * h];
    let mut value = vec![0.0f32; w * h];
    let mut triangle = vec![-1i64; w * h];
    let mut ghost = if p.ghost { vec![0u8; w * h] } else { Vec::new() };
    if p.ghost {
        for g in p.ghost_triangles.chunks_exact(6) {
            let corners = [g[0], g[1], 0.0, 0.0, g[2], g[3], 0.0, 0.0, g[4], g[5], 0.0, 0.0];
            scan(&corners, &p.clip, w, |index, _, _| ghost[index] = 1);
        }
    }
    let drawn = p.light.len();
    for id in 0..drawn {
        scan(&p.triangles[id * 12..id * 12 + 12], &p.clip, w, |index, z, v| {
            if z <= f64::from(depth[index]) {
                return;
            }
            depth[index] = z as f32;
            value[index] = v as f32;
            triangle[index] = id as i64;
        });
    }
    ZBuffer { depth, value, triangle, ghost }
}

/// RGBA of the logical image and the supersampled float32 depth buffer (bit-identical to `rasterPixels`).
pub fn raster_pixels(p: &Prepared) -> (Vec<u8>, Vec<f32>) {
    let buffers = zbuffer(p);
    let rgba = resolve(p, &buffers);
    (rgba, buffers.depth)
}

/// Resolve stage: edge kinds, band colours, light and supersample averaging into the logical RGBA image.
pub fn resolve(p: &Prepared, buffers: &ZBuffer) -> Vec<u8> {
    let (width, height, samples) = (p.width, p.height, p.samples);
    let (w, h) = (width * samples, height * samples);
    let mut rgba = vec![0u8; width * height * 4];
    if p.light.is_empty() && !p.ghost {
        return rgba;
    }
    let ZBuffer { depth, value, triangle, ghost } = buffers;
    let bands = p.palette.len() / 3;
    let normal_dot = |ta: usize, tb: usize| {
        p.normals[ta * 3] * p.normals[tb * 3]
            + p.normals[ta * 3 + 1] * p.normals[tb * 3 + 1]
            + p.normals[ta * 3 + 2] * p.normals[tb * 3 + 2]
    };
    let edge_kind = |a: usize, b: usize| -> u8 {
        let (ta, tb) = (triangle[a], triangle[b]);
        if ta < 0 && tb < 0 {
            return 0;
        }
        if ta < 0 || tb < 0 {
            return 1;
        }
        if ta == tb {
            return 0;
        }
        let (ta, tb) = (ta as usize, tb as usize);
        if p.owners[ta] != p.owners[tb] || (f64::from(depth[a]) - f64::from(depth[b])).abs() > p.jump {
            return 1;
        }
        if (p.caps[ta] == 1.0 || p.caps[tb] == 1.0) && normal_dot(ta, tb) < p.crease_cos {
            return 1;
        }
        if p.show_mesh {
            2
        } else {
            0
        }
    };
    rgba.par_chunks_mut(width * 4).enumerate().for_each(|(y, row)| {
        for x in 0..width {
            let (mut r, mut g, mut b, mut a) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
            for dy in 0..samples {
                for dx in 0..samples {
                    let (sx, sy) = (x * samples + dx, y * samples + dy);
                    let index = sy * w + sx;
                    let id = triangle[index];
                    if id < 0 {
                        if !p.ghost || ghost[index] != 1 {
                            continue;
                        }
                        r += GHOST[0] * GHOST_ALPHA;
                        g += GHOST[1] * GHOST_ALPHA;
                        b += GHOST[2] * GHOST_ALPHA;
                        a += 255.0 * GHOST_ALPHA;
                        continue;
                    }
                    let edge = [
                        if sx + 1 < w { edge_kind(index, index + 1) } else { 0 },
                        if sy + 1 < h { edge_kind(index, index + w) } else { 0 },
                        u8::from(sx > 0 && edge_kind(index, index - 1) == 1),
                        u8::from(sy > 0 && edge_kind(index, index - w) == 1),
                    ]
                    .into_iter()
                    .max()
                    .unwrap_or(0);
                    let raw = if p.step > 0.0 { ((f64::from(value[index]) - p.low) / p.step).floor() } else { 0.0 };
                    let band = if raw.is_nan() { f64::NAN } else { (bands as f64 - 1.0).min(raw.max(0.0)) };
                    let shade = p.light[id as usize]
                        * if edge == 1 {
                            0.3
                        } else if edge == 2 {
                            0.7
                        } else {
                            1.0
                        };
                    let colour = if band.is_nan() {
                        [0.0; 3]
                    } else {
                        [p.palette[band as usize * 3], p.palette[band as usize * 3 + 1], p.palette[band as usize * 3 + 2]]
                    };
                    r += colour[0] * shade;
                    g += colour[1] * shade;
                    b += colour[2] * shade;
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
