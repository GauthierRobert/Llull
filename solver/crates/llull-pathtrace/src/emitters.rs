//! Emissive triangles as lights (next-event estimation). At load every (instance, triangle) whose material has a non-zero emission
//! factor becomes an emitter, its area taken after the instance transform. An emitter is chosen by power (luminance of the factor,
//! times the emission texture's mean when there is one, times the world area) from a Walker / Vose alias table, then a point is
//! sampled uniformly on the triangle: pdf_area = P(choose) / area, converted to solid angle by d² / |cos| (emission is two-sided).
//! A BSDF ray meeting an emitter finds its pdf in O(1): emitter index = `first[instance] + triangle`, since one instance has one
//! material and so all or none of its triangles emit.
//!
//! Above [`MAX_EMITTERS`] emissive triangles the table is not built (`over_cap` holds the count): emission is then only added where
//! a BSDF ray hits it, as before this module, and the render warns `PATHTRACE_EMITTER_LIMIT`.

use crate::material::Material;
use crate::math::Vec3;
use crate::scene::Geometry;
use crate::texture::Texture;
use std::sync::Arc;

/// Most emissive triangles light-sampled (16 B each on the CPU and on the GPU: 16 MiB at the cap).
pub const MAX_EMITTERS: u64 = 1_000_000;
/// `first` of an instance whose material does not emit.
pub const NONE: u32 = u32::MAX;

/// One emitter: its alias-table bin (keep it below `threshold`, else take `alias`), its area pdf and its instance.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EmitterRow {
    pub threshold: f32,
    pub alias: u32,
    /// Probability of choosing this emitter over its world area (0 for a degenerate triangle, never chosen).
    pub pdf_area: f32,
    pub instance: u32,
}

#[derive(Debug, Clone, Default)]
pub struct Emitters {
    pub rows: Vec<EmitterRow>,
    /// First emitter of each instance's triangles, or [`NONE`]; empty when there are no emitters.
    pub first: Vec<u32>,
    /// The emissive triangle count when it is over the cap (no table built).
    pub over_cap: Option<u64>,
}

/// Selection-power scale of a material (luminance of the factor, times its texture's mean), `None` when it does not emit.
fn power_scale(material: &Material, means: &mut [Option<Vec3>], textures: &[Arc<Texture>]) -> Option<f64> {
    if material.emission.is_black() {
        return None;
    }
    let mut emission = material.emission;
    if let Some(index) = material.emission_texture {
        if let (Some(slot), Some(texture)) = (means.get_mut(index as usize), textures.get(index as usize)) {
            emission = emission.times(*slot.get_or_insert_with(|| texture_mean(texture)));
        }
    }
    Some(f64::from(emission.luminance()).max(0.0))
}

fn texture_mean(t: &Texture) -> Vec3 {
    let mut sum = [0.0f64; 3];
    for y in 0..t.height {
        for x in 0..t.width {
            let v = t.texel(x, y);
            for (k, s) in sum.iter_mut().enumerate() {
                *s += f64::from(v[k]);
            }
        }
    }
    let n = f64::from(t.width) * f64::from(t.height);
    Vec3::from_f64(sum.map(|s| s / n))
}

/// Vose's alias table over `weights` (sum > 0): (threshold, alias) per bin.
fn alias_table(weights: &[f64], total: f64) -> Vec<(f32, u32)> {
    let n = weights.len();
    let mut scaled: Vec<f64> = weights.iter().map(|w| w / total * n as f64).collect();
    let mut table = vec![(1.0f32, 0u32); n];
    let (mut small, mut large): (Vec<u32>, Vec<u32>) = (0..n as u32).partition(|&i| scaled[i as usize] < 1.0);
    while let (Some(&s), Some(&l)) = (small.last(), large.last()) {
        small.pop();
        large.pop();
        table[s as usize] = (scaled[s as usize] as f32, l);
        scaled[l as usize] = (scaled[l as usize] + scaled[s as usize]) - 1.0;
        if scaled[l as usize] < 1.0 {
            small.push(l);
        } else {
            large.push(l);
        }
    }
    for i in small.into_iter().chain(large) {
        table[i as usize] = (1.0, i);
    }
    table
}

fn world_area(geometry: &Geometry, instance: usize, triangle: [u32; 3]) -> f64 {
    let to_world = &geometry.instances[instance].to_world;
    let [a, b, c] = triangle.map(|v| to_world.point(geometry.positions[v as usize]));
    let (e1, e2) = (b - a, c - a);
    let (e1, e2) = ([e1.x, e1.y, e1.z].map(f64::from), [e2.x, e2.y, e2.z].map(f64::from));
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt()
}

impl Emitters {
    /// The emitter table of a scene, or none (no emission, zero total power, or more than `cap` emissive triangles).
    pub fn build(geometry: &Geometry, materials: &[Material], textures: &[Arc<Texture>], cap: u64) -> Emitters {
        let mut means = vec![None; textures.len()];
        let scales: Vec<Option<f64>> = materials.iter().map(|m| power_scale(m, &mut means, textures)).collect();
        let scale_of = |instance: &crate::scene::Instance| scales.get(instance.material as usize).copied().flatten();
        let count: u64 = geometry
            .instances
            .iter()
            .filter(|i| scale_of(i).is_some())
            .map(|i| geometry.meshes[i.mesh as usize].triangles.len() as u64)
            .sum();
        if count == 0 {
            return Emitters::default();
        }
        if count > cap {
            return Emitters { over_cap: Some(count), ..Emitters::default() };
        }
        let mut first = vec![NONE; geometry.instances.len()];
        let (mut powers, mut areas, mut owners) = (Vec::new(), Vec::new(), Vec::new());
        for (index, instance) in geometry.instances.iter().enumerate() {
            let Some(scale) = scale_of(instance) else { continue };
            first[index] = powers.len() as u32;
            for &triangle in &geometry.meshes[instance.mesh as usize].triangles {
                let area = world_area(geometry, index, triangle);
                areas.push(area);
                powers.push(if area.is_finite() { scale * area } else { 0.0 });
                owners.push(index as u32);
            }
        }
        let total: f64 = powers.iter().sum();
        if !(total > 0.0 && total.is_finite()) {
            return Emitters::default();
        }
        let rows = alias_table(&powers, total)
            .into_iter()
            .zip(powers.iter().zip(&areas).zip(owners))
            .map(|((threshold, alias), ((power, area), instance))| {
                let pdf_area = if *area > 0.0 { (power / total / area) as f32 } else { 0.0 };
                EmitterRow { threshold, alias, pdf_area, instance }
            })
            .collect();
        Emitters { rows, first, over_cap: None }
    }

    /// Emitter index of a triangle of an instance (mesh-local triangle index), if it is light-sampled.
    pub fn index(&self, instance: u32, triangle: u32) -> Option<usize> {
        let first = *self.first.get(instance as usize)?;
        (first != NONE).then_some(first as usize + triangle as usize)
    }

    /// Area pdf the light sampler gives a point of this triangle (None when it is not light-sampled).
    pub fn pdf_area(&self, instance: u32, triangle: u32) -> Option<f32> {
        self.index(instance, triangle).and_then(|e| self.rows.get(e)).map(|row| row.pdf_area)
    }

    /// The emitter of alias bin `bin` and uniform `u`: (emitter, instance, mesh-local triangle).
    pub fn pick(&self, bin: u32, u: f32) -> (usize, u32, u32) {
        let row = &self.rows[bin as usize];
        let e = if u < row.threshold { bin as usize } else { row.alias as usize };
        let instance = self.rows[e].instance;
        (e, instance, (e - self.first[instance as usize] as usize) as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_alias_table_reproduces_the_weights() {
        let weights = [0.0, 1.0, 3.0, 0.5, 2.5, 0.0, 9.0];
        let total: f64 = weights.iter().sum();
        let table = alias_table(&weights, total);
        let mut p = [0.0f64; 7];
        for (bin, (threshold, alias)) in table.iter().enumerate() {
            p[bin] += f64::from(*threshold) / 7.0;
            p[*alias as usize] += (1.0 - f64::from(*threshold)) / 7.0;
        }
        for (got, w) in p.iter().zip(weights) {
            assert!((got - w / total).abs() < 1e-6, "{p:?}");
        }
    }
}
