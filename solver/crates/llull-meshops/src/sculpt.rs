//! `sculpt` (DES-7c step 7, slice 3): the brush strokes of `sculpt.ts` on a mesh of any size, bit-identical to the TypeScript engine (the oracle). Every stamp is
//! projected onto the input surface (the closest-point tree of `surface.rs`), the mesh is refined where `refineEdge` asks, then the stamps apply in order, each
//! from the positions the previous one left; the mirror image of a stamp is computed from the same positions and added to it. The report equals the TypeScript one.

use crate::geom::{js_max, length, Vec3};
use crate::sculpt_brush::{Direction, Plane, Sculptor, Settings};
use crate::sculpt_measure::{height_field_volume, is_closed, mirror, signed_volume, symmetry_error};
use crate::sculpt_refine::{refine, Refined};
use crate::surface::SurfaceIndex;
use serde::Serialize;

/// Triangles the refined working mesh may reach (the same limit as `SCULPT_MAX_TRIANGLES` of `sculpt.ts`).
pub const MAX_TRIANGLES: usize = 4_000_000;

pub struct Params {
    pub settings: Settings,
    pub stamps: Vec<Vec3>,
    pub symmetry: Option<Plane>,
    pub refine_edge: Option<f64>,
    pub max_triangles: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub moved_vertices: usize,
    pub max_displacement: f64,
    pub displaced_volume: f64,
    pub volume_basis: &'static str,
    pub symmetry_error: Option<f64>,
    pub refined_edges: usize,
    pub stamps_applied: usize,
}

pub enum Sculpted {
    Done {
        positions: Vec<f64>,
        indices: Vec<u32>,
        report: Report,
    },
    /// The index of the first stamp farther than `radius` from the surface.
    OffSurface(usize),
    /// The refined mesh passed the triangle limit (live triangles at that moment).
    TooLarge(usize),
}

/// Two displacement fields (ascending by vertex) added where they share a vertex, the first field's value first.
fn merged(first: Vec<(u32, Vec3)>, second: &[(u32, Vec3)]) -> Vec<(u32, Vec3)> {
    let mut out = Vec::with_capacity(first.len() + second.len());
    let (mut a, mut b) = (first.into_iter().peekable(), second.iter().copied().peekable());
    while let (Some(&(va, da)), Some(&(vb, db))) = (a.peek(), b.peek()) {
        if va < vb {
            out.push((va, da));
            a.next();
        } else if vb < va {
            out.push((vb, db));
            b.next();
        } else {
            out.push((va, [da[0] + db[0], da[1] + db[1], da[2] + db[2]]));
            a.next();
            b.next();
        }
    }
    out.extend(a);
    out.extend(b);
    out
}

pub fn sculpt(positions: &[f64], triangles: &[u32], params: &Params, tick: &mut dyn FnMut(f64)) -> Sculpted {
    let settings = &params.settings;
    let tolerance = 1e-9 * js_max(1.0, settings.radius);
    let surface = SurfaceIndex::new(positions, triangles);
    let mut projected: Vec<Vec3> = Vec::with_capacity(params.stamps.len());
    for (i, &stamp) in params.stamps.iter().enumerate() {
        let hit = surface.closest(stamp);
        if hit.distance > settings.radius {
            return Sculpted::OffSurface(i);
        }
        projected.push(hit.point);
    }
    drop(surface);
    tick(0.1);
    let (start, indices, splits) = match params.refine_edge {
        None => (positions.to_vec(), triangles.to_vec(), 0),
        Some(limit) => {
            let mut centres = projected.clone();
            if let Some(plane) = params.symmetry {
                centres.extend(projected.iter().map(|&p| mirror(p, plane)));
            }
            match refine(positions, triangles, limit, settings.radius, &centres, params.max_triangles) {
                Refined::Done { positions, indices, splits } => (positions, indices, splits),
                Refined::TooLarge(count) => return Sculpted::TooLarge(count),
            }
        }
    };
    tick(0.2);
    let mut sculptor = Sculptor::new(&start, &indices, settings);
    let original: Vec<Vec3> = sculptor.position.clone();
    let vector = match settings.direction {
        Direction::Vector(v) => Some(v),
        _ => None,
    };
    let mut applied = 0;
    for (n, &centre) in projected.iter().enumerate() {
        let mut field = sculptor.displacements(centre, vector);
        applied += 1;
        if let Some(plane) = params.symmetry {
            let mirrored = mirror(centre, plane);
            if length([mirrored[0] - centre[0], mirrored[1] - centre[1], mirrored[2] - centre[2]]) > tolerance {
                field = merged(field, &sculptor.displacements(mirrored, vector.map(|v| mirror(v, plane))));
                applied += 1;
            }
        }
        for (v, d) in field {
            let p = sculptor.position[v as usize];
            sculptor.position[v as usize] = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
        }
        tick(0.2 + 0.7 * (n + 1) as f64 / projected.len() as f64);
    }
    let finals = &sculptor.position;
    let (mut moved, mut max_displacement) = (0, 0.0);
    for (a, b) in finals.iter().zip(&original) {
        let d = length([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
        if d > 0.0 {
            moved += 1;
        }
        max_displacement = js_max(max_displacement, d);
    }
    let closed = is_closed(&indices);
    let volume = if closed {
        signed_volume(finals, &indices) - signed_volume(&original, &indices)
    } else {
        height_field_volume(&original, finals, &indices)
    };
    let report = Report {
        moved_vertices: moved,
        max_displacement,
        displaced_volume: volume,
        volume_basis: if closed { "closed-volume-difference" } else { "height-field-sum" },
        symmetry_error: params.symmetry.and_then(|plane| symmetry_error(&original, finals, plane, tolerance)),
        refined_edges: splits,
        stamps_applied: applied,
    };
    Sculpted::Done { positions: finals.iter().flatten().copied().collect(), indices, report }
}
