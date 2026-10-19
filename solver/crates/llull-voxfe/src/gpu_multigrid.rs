//! The multigrid V-cycle on the GPU (feature `gpu`): an f32 mirror of a CPU [`Multigrid<f32>`] hierarchy, used by
//! [`GpuOperator::pcg_f32`] as its preconditioner instead of Jacobi.
//!
//! The CPU builds (and updates) the hierarchy, Galerkin element matrices, 1 / diag(K), λ̂ and the coarsest level's dense
//! inverse; [`GpuMultigrid::upload`] copies them to GPU buffers (allocated on the first upload, rewritten in place after).
//! A V-cycle is then recorded into the PCG's command encoder without a host round trip: the smoother (Chebyshev or damped
//! Jacobi, the same polynomial as the CPU), restriction and prolongation (one thread per output node, fixed order), the
//! Galerkin mat-vec (the fine mat-vec shader reading one matrix per element) and the coarse solve as a dense f32 mat-vec
//! with the inverse. f32 throughout: the exploration path (`deterministic: false`); [`crate::gpu::refine`] keeps the f64
//! answer.

use crate::gpu::GpuOperator;
use crate::level::LevelOperator;
use crate::multigrid::{chebyshev, Multigrid, Smoother};
use llull_gpu::buffers::{dispatch_dims, f32_bytes, storage_f32, u32_bytes, uniform, zeroed_f32, STORAGE};
use llull_gpu::dot::{compute_pipeline, storage_entry, uniform_entry};
use llull_gpu::wgpu;
use llull_gpu::wgpu::util::DeviceExt;

const SHADER: &str = r"
struct Transfer { fnx: u32, fny: u32, fnz: u32, cnx: u32, cny: u32, cnz: u32, dim: u32, nodes: u32, groups_x: u32, p0: u32, p1: u32, p2: u32 };
@group(0) @binding(0) var<uniform> t: Transfer;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> mask: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;

fn node_index(wid: vec3<u32>, lid: u32) -> u32 { return (wid.y * t.groups_x + wid.x) * 64u + lid; }

// dst (fine) += P src (coarse) on the free fine DOFs; one thread per fine node
@compute @workgroup_size(64)
fn prolongation(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let node = node_index(wid, lid);
  if (node >= t.nodes) { return; }
  let i = node % t.fnx;
  let j = (node / t.fnx) % t.fny;
  let k = node / (t.fnx * t.fny);
  var acc = array<f32, 3>(0.0, 0.0, 0.0);
  for (var dk = 0u; dk < 2u; dk = dk + 1u) {
    if (k % 2u == 0u && dk == 1u) { continue; }
    let ck = select((k - 1u) / 2u + dk, k / 2u, k % 2u == 0u);
    let wk = select(0.5, 1.0, k % 2u == 0u);
    for (var dj = 0u; dj < 2u; dj = dj + 1u) {
      if (j % 2u == 0u && dj == 1u) { continue; }
      let cj = select((j - 1u) / 2u + dj, j / 2u, j % 2u == 0u);
      let wj = select(0.5, 1.0, j % 2u == 0u);
      for (var di = 0u; di < 2u; di = di + 1u) {
        if (i % 2u == 0u && di == 1u) { continue; }
        let ci = select((i - 1u) / 2u + di, i / 2u, i % 2u == 0u);
        let w = wk * wj * select(0.5, 1.0, i % 2u == 0u);
        let cn = ci + t.cnx * (cj + t.cny * ck);
        for (var q = 0u; q < t.dim; q = q + 1u) {
          acc[q] = acc[q] + w * src[cn * t.dim + q];
        }
      }
    }
  }
  for (var q = 0u; q < t.dim; q = q + 1u) {
    let d = node * t.dim + q;
    dst[d] = dst[d] + acc[q] * mask[d];
  }
}

// dst (coarse) = R src (fine), zero on the non-free coarse DOFs; one thread per coarse node
@compute @workgroup_size(64)
fn restriction(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let node = node_index(wid, lid);
  if (node >= t.nodes) { return; }
  let ci = node % t.cnx;
  let cj = (node / t.cnx) % t.cny;
  let ck = node / (t.cnx * t.cny);
  var acc = array<f32, 3>(0.0, 0.0, 0.0);
  for (var dk = 0u; dk < 3u; dk = dk + 1u) {
    if (2u * ck + dk < 1u || 2u * ck + dk - 1u >= t.fnz) { continue; }
    let fk = 2u * ck + dk - 1u;
    let wk = select(0.5, 1.0, dk == 1u);
    for (var dj = 0u; dj < 3u; dj = dj + 1u) {
      if (2u * cj + dj < 1u || 2u * cj + dj - 1u >= t.fny) { continue; }
      let fj = 2u * cj + dj - 1u;
      let wj = select(0.5, 1.0, dj == 1u);
      for (var di = 0u; di < 3u; di = di + 1u) {
        if (2u * ci + di < 1u || 2u * ci + di - 1u >= t.fnx) { continue; }
        let fi = 2u * ci + di - 1u;
        let w = wk * wj * select(0.5, 1.0, di == 1u);
        let f = fi + t.fnx * (fj + t.fny * fk);
        for (var q = 0u; q < t.dim; q = q + 1u) {
          acc[q] = acc[q] + w * src[f * t.dim + q];
        }
      }
    }
  }
  for (var q = 0u; q < t.dim; q = q + 1u) {
    let d = node * t.dim + q;
    dst[d] = acc[q] * mask[d];
  }
}
";

const VECTOR: &str = r"
struct Op { n: u32, groups_x: u32, alpha: f32, beta: f32 };
@group(0) @binding(0) var<uniform> o: Op;
@group(0) @binding(1) var<storage, read> a: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;

fn index(wid: vec3<u32>, lid: u32) -> u32 { return (wid.y * o.groups_x + wid.x) * 256u + lid; }

// y = y + alpha a
@compute @workgroup_size(256)
fn axpy(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = index(wid, lid);
  if (i < o.n) { y[i] = y[i] + o.alpha * a[i]; }
}
// y = alpha y + beta (a ⊙ b)
@compute @workgroup_size(256)
fn combine(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = index(wid, lid);
  if (i < o.n) { y[i] = o.alpha * y[i] + o.beta * a[i] * b[i]; }
}
// y = a - b
@compute @workgroup_size(256)
fn subtract(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = index(wid, lid);
  if (i < o.n) { y[i] = a[i] - b[i]; }
}
";

const COARSE: &str = r"
struct Coarse { m: u32, groups_x: u32, p0: u32, p1: u32 };
@group(0) @binding(0) var<uniform> c: Coarse;
@group(0) @binding(1) var<storage, read> inverse: array<f32>;
@group(0) @binding(2) var<storage, read> dofs: array<u32>;
@group(0) @binding(3) var<storage, read> r: array<f32>;
@group(0) @binding(4) var<storage, read_write> z: array<f32>;

// z[dofs[i]] = Σ_j K⁻¹[i][j] r[dofs[j]] (z cleared before)
@compute @workgroup_size(64)
fn solve(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = (wid.y * c.groups_x + wid.x) * 64u + lid;
  if (i >= c.m) { return; }
  var s = 0.0;
  for (var j = 0u; j < c.m; j = j + 1u) {
    s = s + inverse[i * c.m + j] * r[dofs[j]];
  }
  z[dofs[i]] = s;
}
";

/// Element-wise kernels of the V-cycle.
#[derive(Debug, Clone, Copy)]
enum Kernel {
    /// `y += alpha a`
    Axpy,
    /// `y = alpha y + beta a ⊙ b`
    Combine,
    /// `y = a − b`
    Subtract,
}

/// The buffers of one level.
struct GpuLevel {
    dofs: usize,
    nodes: u32,
    /// Mat-vec data of the Galerkin levels (`None` on level 0, which uses the [`GpuOperator`]'s own).
    matvec: Option<[wgpu::Buffer; 4]>,
    inverse_diagonal: wgpu::Buffer,
    residual: wgpu::Buffer,
    direction: wgpu::Buffer,
    product: wgpu::Buffer,
    /// Right-hand side and correction when this is a coarse level.
    rhs: wgpu::Buffer,
    correction: wgpu::Buffer,
    /// Uniforms: smoothing steps (`(alpha, beta)` of `Combine` per step; Chebyshev: first step `(0, 1/θ)`, then the
    /// recurrence; Jacobi: `(1, ω)`), `+1`, `−1`, plain `n`, and the transfer to the next level (prolongation, restriction).
    steps: Vec<wgpu::Buffer>,
    plus: wgpu::Buffer,
    minus: wgpu::Buffer,
    plain: wgpu::Buffer,
    transfer: Option<[wgpu::Buffer; 2]>,
}

/// The GPU hierarchy and its pipelines.
pub struct GpuMultigrid {
    levels: Vec<GpuLevel>,
    smoother: Smoother,
    coarse_m: u32,
    coarse_params: wgpu::Buffer,
    coarse_inverse: wgpu::Buffer,
    coarse_dofs: wgpu::Buffer,
    transfer_layout: wgpu::BindGroupLayout,
    prolong: wgpu::ComputePipeline,
    restrict: wgpu::ComputePipeline,
    vector_layout: wgpu::BindGroupLayout,
    vector: [wgpu::ComputePipeline; 3],
    coarse_layout: wgpu::BindGroupLayout,
    coarse: wgpu::ComputePipeline,
}

fn op_bytes(n: usize, alpha: f64, beta: f64) -> Vec<u8> {
    let (groups_x, _) = dispatch_dims((n as u32).div_ceil(256));
    let mut bytes = u32_bytes(&[n as u32, groups_x]);
    bytes.extend(f32_bytes(&[alpha as f32, beta as f32]));
    bytes
}

/// `(alpha, beta)` of every smoothing step of a level.
fn step_coefficients(smoother: Smoother, lambda: f64, ratio: f64, steps: usize) -> Vec<(f64, f64)> {
    match smoother {
        Smoother::Jacobi => vec![(1.0, 4.0 / (3.0 * lambda)); steps],
        Smoother::Chebyshev => {
            let (first, recurrence) = chebyshev(lambda, ratio, steps);
            std::iter::once((0.0, first)).chain(recurrence).collect()
        }
    }
}

fn transfer_bytes(fine: [usize; 3], coarse: [usize; 3], dim: usize, nodes: usize) -> Vec<u8> {
    let (groups_x, _) = dispatch_dims((nodes as u32).div_ceil(64));
    let words: Vec<u32> = fine.into_iter().chain(coarse).map(|v| v as u32).chain([dim as u32, nodes as u32, groups_x, 0, 0, 0]).collect();
    u32_bytes(&words)
}

fn f32s<T: Copy + Into<f64>>(values: &[T]) -> Vec<f32> {
    values.iter().map(|&v| v.into() as f32).collect()
}

impl GpuMultigrid {
    /// Allocates the GPU mirror of `mg` (whose level 0 is `op`'s fine operator) and uploads it.
    pub fn new(op: &GpuOperator, mg: &Multigrid<f32>) -> GpuMultigrid {
        let gpu = op.gpu();
        let device = &gpu.device;
        let settings = *mg.settings();
        let steps = settings.smoothing_steps.max(1);
        let levels = (0..mg.levels())
            .map(|index| {
                let (level, inverse_diagonal, lambda) = mg.level(index);
                let grid = *level.grid();
                let dofs = grid.dofs();
                let matvec = match level {
                    LevelOperator::Fine(_) => None,
                    LevelOperator::Assembled(matrices) => {
                        let nd = grid.element_dofs();
                        let active: Vec<f32> = (0..grid.elements()).map(|e| if matrices.active(e) { 1.0 } else { 0.0 }).collect();
                        Some(op.level_matvec_buffers(&grid, nd * nd, &f32s(matrices.matrices()), &active, level.free()))
                    }
                };
                let coefficients = step_coefficients(settings.smoother, lambda, settings.chebyshev_ratio, steps);
                let next = (index + 1 < mg.levels()).then(|| *mg.level(index + 1).0.grid());
                GpuLevel {
                    dofs,
                    nodes: grid.nodes() as u32,
                    matvec,
                    inverse_diagonal: storage_f32(gpu, "mg dinv", &f32s(inverse_diagonal)),
                    residual: zeroed_f32(gpu, "mg residual", dofs),
                    direction: zeroed_f32(gpu, "mg direction", dofs),
                    product: zeroed_f32(gpu, "mg product", dofs),
                    rhs: zeroed_f32(gpu, "mg rhs", dofs),
                    correction: zeroed_f32(gpu, "mg correction", dofs),
                    steps: coefficients.iter().map(|&(a, b)| uniform(gpu, "mg step", &op_bytes(dofs, a, b))).collect(),
                    plus: uniform(gpu, "mg plus", &op_bytes(dofs, 1.0, 0.0)),
                    minus: uniform(gpu, "mg minus", &op_bytes(dofs, -1.0, 0.0)),
                    plain: uniform(gpu, "mg plain", &op_bytes(dofs, 0.0, 0.0)),
                    transfer: next.map(|c| {
                        let (f, cn) = (grid.node_dims(), c.node_dims());
                        [
                            uniform(gpu, "mg prolong", &transfer_bytes(f, cn, grid.dim, grid.nodes())),
                            uniform(gpu, "mg restrict", &transfer_bytes(f, cn, grid.dim, c.nodes())),
                        ]
                    }),
                }
            })
            .collect();
        let transfer_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("mg transfer"),
            entries: &[uniform_entry(0), storage_entry(1, true), storage_entry(2, true), storage_entry(3, false)],
        });
        let vector_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("mg vector"),
            entries: &[uniform_entry(0), storage_entry(1, true), storage_entry(2, true), storage_entry(3, false)],
        });
        let coarse_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("mg coarse"),
            entries: &[uniform_entry(0), storage_entry(1, true), storage_entry(2, true), storage_entry(3, true), storage_entry(4, false)],
        });
        let coarse_level = mg.coarse();
        let m = coarse_level.dofs().len();
        let (groups_x, _) = dispatch_dims((m as u32).div_ceil(64));
        let dofs: Vec<u32> = coarse_level.dofs().iter().map(|&d| d as u32).collect();
        let mut dof_bytes = u32_bytes(&dofs);
        if dof_bytes.is_empty() {
            dof_bytes.resize(4, 0);
        }
        GpuMultigrid {
            levels,
            smoother: settings.smoother,
            coarse_m: m as u32,
            coarse_params: uniform(gpu, "mg coarse", &u32_bytes(&[m as u32, groups_x, 0, 0])),
            coarse_inverse: storage_f32(gpu, "mg coarse inverse", &f32s(&coarse_level.inverse())),
            coarse_dofs: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("mg coarse dofs"),
                contents: &dof_bytes,
                usage: STORAGE,
            }),
            prolong: compute_pipeline(gpu, SHADER, "prolongation", &transfer_layout),
            restrict: compute_pipeline(gpu, SHADER, "restriction", &transfer_layout),
            transfer_layout,
            vector: ["axpy", "combine", "subtract"].map(|entry| compute_pipeline(gpu, VECTOR, entry, &vector_layout)),
            vector_layout,
            coarse: compute_pipeline(gpu, COARSE, "solve", &coarse_layout),
            coarse_layout,
        }
    }

    /// Rewrites every level from an updated `mg` with the same grids and supports (the GPU buffers are reused).
    pub fn upload(&self, op: &GpuOperator, mg: &Multigrid<f32>) {
        let queue = &op.gpu().queue;
        let settings = *mg.settings();
        for (index, gpu_level) in self.levels.iter().enumerate() {
            let (level, inverse_diagonal, lambda) = mg.level(index);
            if let (LevelOperator::Assembled(matrices), Some([_, data, _, _])) = (level, &gpu_level.matvec) {
                queue.write_buffer(data, 0, &f32_bytes(&f32s(matrices.matrices())));
            }
            queue.write_buffer(&gpu_level.inverse_diagonal, 0, &f32_bytes(&f32s(inverse_diagonal)));
            let coefficients = step_coefficients(settings.smoother, lambda, settings.chebyshev_ratio, settings.smoothing_steps.max(1));
            for (buffer, &(a, b)) in gpu_level.steps.iter().zip(&coefficients) {
                queue.write_buffer(buffer, 0, &op_bytes(gpu_level.dofs, a, b));
            }
        }
        queue.write_buffer(&self.coarse_inverse, 0, &f32_bytes(&f32s(&mg.coarse().inverse())));
    }

    fn encode_vector(
        &self,
        op: &GpuOperator,
        encoder: &mut wgpu::CommandEncoder,
        kernel: Kernel,
        params: &wgpu::Buffer,
        buffers: [&wgpu::Buffer; 3],
        n: usize,
    ) {
        let [a, b, y] = buffers;
        let bind = op.gpu().device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("mg vector"),
            layout: &self.vector_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: a.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: b.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: y.as_entire_binding() },
            ],
        });
        let pipeline = &self.vector[kernel as usize];
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("mg vector"), timestamp_writes: None });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &bind, &[]);
        let (x, y) = dispatch_dims((n as u32).div_ceil(256));
        pass.dispatch_workgroups(x, y, 1);
    }

    fn encode_transfer(
        &self,
        op: &GpuOperator,
        encoder: &mut wgpu::CommandEncoder,
        prolong: bool,
        params: &wgpu::Buffer,
        buffers: [&wgpu::Buffer; 3],
        nodes: u32,
    ) {
        let [src, mask, dst] = buffers;
        let bind = op.gpu().device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("mg transfer"),
            layout: &self.transfer_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: src.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: mask.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: dst.as_entire_binding() },
            ],
        });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("mg transfer"), timestamp_writes: None });
        pass.set_pipeline(if prolong { &self.prolong } else { &self.restrict });
        pass.set_bind_group(0, &bind, &[]);
        let (x, y) = dispatch_dims(nodes.div_ceil(64));
        pass.dispatch_workgroups(x, y, 1);
    }

    fn encode_matvec(&self, op: &GpuOperator, encoder: &mut wgpu::CommandEncoder, index: usize, u: &wgpu::Buffer, y: &wgpu::Buffer) {
        match &self.levels[index].matvec {
            None => op.encode_matvec(encoder, u, y),
            Some(buffers) => op.encode_matvec_with(encoder, buffers, self.levels[index].nodes, u, y),
        }
    }

    fn mask<'a>(&'a self, op: &'a GpuOperator, index: usize) -> &'a wgpu::Buffer {
        match &self.levels[index].matvec {
            None => op.mask(),
            Some([_, _, _, mask]) => mask,
        }
    }

    /// Records the smoothing of level `index` (the CPU [`Multigrid`]'s polynomial). From zero, `z` is overwritten and the
    /// residual `r − K z` is left in the level's `residual`.
    fn encode_smooth(
        &self,
        op: &GpuOperator,
        encoder: &mut wgpu::CommandEncoder,
        index: usize,
        r: &wgpu::Buffer,
        z: &wgpu::Buffer,
        from_zero: bool,
    ) {
        let level = &self.levels[index];
        let n = level.dofs;
        if from_zero {
            encoder.copy_buffer_to_buffer(r, 0, &level.residual, 0, (n * 4) as u64);
            encoder.clear_buffer(z, 0, None);
        } else {
            self.encode_matvec(op, encoder, index, z, &level.product);
            self.encode_vector(op, encoder, Kernel::Subtract, &level.plain, [r, &level.product, &level.residual], n);
        }
        let steps = level.steps.len();
        for (step, params) in level.steps.iter().enumerate() {
            let last = step + 1 == steps;
            match self.smoother {
                Smoother::Jacobi => {
                    self.encode_vector(op, encoder, Kernel::Combine, params, [&level.inverse_diagonal, &level.residual, z], n);
                    if !last || from_zero {
                        self.encode_matvec(op, encoder, index, z, &level.product);
                        self.encode_vector(op, encoder, Kernel::Subtract, &level.plain, [r, &level.product, &level.residual], n);
                    }
                }
                Smoother::Chebyshev => {
                    self.encode_vector(
                        op,
                        encoder,
                        Kernel::Combine,
                        params,
                        [&level.inverse_diagonal, &level.residual, &level.direction],
                        n,
                    );
                    self.encode_vector(op, encoder, Kernel::Axpy, &level.plus, [&level.direction, &level.direction, z], n);
                    if !last || from_zero {
                        self.encode_matvec(op, encoder, index, &level.direction, &level.product);
                        self.encode_vector(op, encoder, Kernel::Axpy, &level.minus, [&level.product, &level.product, &level.residual], n);
                    }
                }
            }
        }
    }

    /// Records one V-cycle `z ≈ K⁻¹ r` on level `index` (`r`, `z`: that level's DOF-length buffers).
    fn encode_cycle(&self, op: &GpuOperator, encoder: &mut wgpu::CommandEncoder, index: usize, r: &wgpu::Buffer, z: &wgpu::Buffer) {
        if index + 1 == self.levels.len() {
            encoder.clear_buffer(z, 0, None);
            if self.coarse_m == 0 {
                return;
            }
            let bind = op.gpu().device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("mg coarse"),
                layout: &self.coarse_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: self.coarse_params.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: self.coarse_inverse.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: self.coarse_dofs.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: r.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 4, resource: z.as_entire_binding() },
                ],
            });
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("mg coarse"), timestamp_writes: None });
            pass.set_pipeline(&self.coarse);
            pass.set_bind_group(0, &bind, &[]);
            let (x, y) = dispatch_dims(self.coarse_m.div_ceil(64));
            pass.dispatch_workgroups(x, y, 1);
            return;
        }
        let (level, next) = (&self.levels[index], &self.levels[index + 1]);
        let Some([prolong, restrict]) = &level.transfer else { unreachable!("every level but the coarsest has a transfer") };
        self.encode_smooth(op, encoder, index, r, z, true);
        self.encode_transfer(op, encoder, false, restrict, [&level.residual, self.mask(op, index + 1), &next.rhs], next.nodes);
        self.encode_cycle(op, encoder, index + 1, &next.rhs, &next.correction);
        self.encode_transfer(op, encoder, true, prolong, [&next.correction, self.mask(op, index), z], level.nodes);
        self.encode_smooth(op, encoder, index, r, z, false);
    }

    /// Records `z = M⁻¹ r` (one V-cycle) for DOF-length buffers of the fine level.
    pub fn encode(&self, op: &GpuOperator, encoder: &mut wgpu::CommandEncoder, r: &wgpu::Buffer, z: &wgpu::Buffer) {
        self.encode_cycle(op, encoder, 0, r, z);
    }
}
