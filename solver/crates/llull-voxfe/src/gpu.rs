//! wgpu kernels of llull-voxfe (feature `gpu`): the node-centric mat-vec, axpy / xpay / element-wise product, the fixed-order
//! dot of `llull-gpu`, and an f32 Jacobi PCG built from them. f32 storage and arithmetic (PHY-17 §11 Q7): the exploration
//! path, `deterministic: false` in provenance. [`refine`] wraps the f32 solve in f64 iterative refinement on the CPU twin's
//! operator, so the answer meets the f64 residual tolerance even though every inner step is f32.
//!
//! The mat-vec shader mirrors [`crate::operator::Operator::apply`] term for term (same node-centric gather, same order), so
//! GPU and CPU differ only by f32 rounding (test: ~1e-6 relative).

use crate::gpu_multigrid::GpuMultigrid;
use crate::multigrid::Multigrid;
use crate::operator::Operator;
use crate::pcg::inverse_diagonal;
use llull_gpu::buffers::{dispatch_dims, f32_bytes, read_f32, storage_f32, u32_bytes, uniform, zeroed_f32};
use llull_gpu::device::Gpu;
use llull_gpu::dot::{compute_pipeline, storage_entry, uniform_entry, FixedOrderDot};
use llull_gpu::reduce::dot;
use llull_gpu::wgpu;

const MATVEC: &str = r"
struct Grid { nnx: u32, nny: u32, nnz: u32, nx: u32, ny: u32, nz: u32, dim: u32, nodes: u32, groups_x: u32, stride: u32, p1: u32, p2: u32 };
@group(0) @binding(0) var<uniform> g: Grid;
@group(0) @binding(1) var<storage, read> ke: array<f32>;
@group(0) @binding(2) var<storage, read> scale: array<f32>;
@group(0) @binding(3) var<storage, read> mask: array<f32>;
@group(0) @binding(4) var<storage, read> u: array<f32>;
@group(0) @binding(5) var<storage, read_write> y: array<f32>;
var<private> OX: array<u32, 8> = array<u32, 8>(0u, 1u, 1u, 0u, 0u, 1u, 1u, 0u);
var<private> OY: array<u32, 8> = array<u32, 8>(0u, 0u, 1u, 1u, 0u, 0u, 1u, 1u);
var<private> OZ: array<u32, 8> = array<u32, 8>(0u, 0u, 0u, 0u, 1u, 1u, 1u, 1u);

@compute @workgroup_size(64)
fn matvec(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let node = (wid.y * g.groups_x + wid.x) * 64u + lid;
  if (node >= g.nodes) { return; }
  let i = node % g.nnx;
  let j = (node / g.nnx) % g.nny;
  let k = node / (g.nnx * g.nny);
  let npe = select(4u, 8u, g.dim == 3u);
  let nd = npe * g.dim;
  var acc = array<f32, 3>(0.0, 0.0, 0.0);
  for (var a = 0u; a < npe; a = a + 1u) {
    if (i < OX[a] || j < OY[a] || k < OZ[a]) { continue; }
    let ei = i - OX[a];
    let ej = j - OY[a];
    let ek = k - OZ[a];
    if (ei >= g.nx || ej >= g.ny || ek >= g.nz) { continue; }
    let e = ei + g.nx * (ej + g.ny * ek);
    let s = scale[e];
    if (s == 0.0) { continue; }
    let base = e * g.stride;
    for (var c = 0u; c < g.dim; c = c + 1u) {
      let row = (a * g.dim + c) * nd;
      var sum = 0.0;
      for (var b = 0u; b < npe; b = b + 1u) {
        let nb = (ei + OX[b]) + g.nnx * ((ej + OY[b]) + g.nny * (ek + OZ[b]));
        for (var q = 0u; q < g.dim; q = q + 1u) {
          sum = sum + ke[base + row + b * g.dim + q] * u[nb * g.dim + q];
        }
      }
      acc[c] = acc[c] + s * sum;
    }
  }
  for (var c = 0u; c < g.dim; c = c + 1u) {
    let d = node * g.dim + c;
    y[d] = acc[c] * mask[d];
  }
}
";

const VECTOR: &str = r"
struct Op { n: u32, groups_x: u32, alpha: f32, pad: u32 };
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
// y = a + alpha y
@compute @workgroup_size(256)
fn xpay(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = index(wid, lid);
  if (i < o.n) { y[i] = a[i] + o.alpha * y[i]; }
}
// y = a * b (element-wise)
@compute @workgroup_size(256)
fn mul(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = index(wid, lid);
  if (i < o.n) { y[i] = a[i] * b[i]; }
}
";

/// Element-wise kernel of the vector shader.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VectorOp {
    /// `y += alpha · a`
    Axpy,
    /// `y = a + alpha · y`
    Xpay,
    /// `y = a ⊙ b`
    Mul,
}

/// Outcome of the f32 GPU PCG (inner solve of [`refine`]).
#[derive(Debug, Clone, PartialEq)]
pub struct GpuSolve {
    pub x: Vec<f64>,
    pub iterations: usize,
    /// ‖r‖ / ‖b‖ of the f32 recurrence when it stopped.
    pub relative_residual: f64,
}

/// The GPU copy of an [`Operator`] (f32) with its kernels, and optionally a multigrid V-cycle as the PCG preconditioner.
pub struct GpuOperator {
    multigrid: Option<GpuMultigrid>,
    gpu: Gpu,
    dofs: usize,
    nodes: u32,
    grid_params: wgpu::Buffer,
    ke: wgpu::Buffer,
    scale: wgpu::Buffer,
    mask: wgpu::Buffer,
    matvec_layout: wgpu::BindGroupLayout,
    matvec: wgpu::ComputePipeline,
    vector_layout: wgpu::BindGroupLayout,
    vector: [wgpu::ComputePipeline; 3],
}

fn f32s(values: &[f64]) -> Vec<f32> {
    values.iter().map(|&v| v as f32).collect()
}

impl GpuOperator {
    /// Uploads `op` (element matrix, scales, free-DOF mask) to `gpu` and builds the pipelines.
    pub fn new(gpu: Gpu, op: &Operator) -> GpuOperator {
        let g = op.grid();
        let [nnx, nny, nnz] = g.node_dims();
        let nodes = g.nodes() as u32;
        let (groups_x, _) = dispatch_dims(nodes.div_ceil(64));
        let words = [nnx, nny, nnz, g.nx, g.ny, g.nz, g.dim].map(|v| v as u32);
        let mut params = words.to_vec();
        params.extend([nodes, groups_x, 0, 0, 0]);
        let grid_params = uniform(&gpu, "voxfe grid", &u32_bytes(&params));
        let ke = storage_f32(&gpu, "voxfe ke", &f32s(op.ke()));
        let scale = storage_f32(&gpu, "voxfe scale", &f32s(op.scale()));
        let mask_values: Vec<f32> = op.free().iter().map(|&f| if f { 1.0 } else { 0.0 }).collect();
        let mask = storage_f32(&gpu, "voxfe mask", &mask_values);
        let matvec_layout = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("voxfe matvec"),
            entries: &[
                uniform_entry(0),
                storage_entry(1, true),
                storage_entry(2, true),
                storage_entry(3, true),
                storage_entry(4, true),
                storage_entry(5, false),
            ],
        });
        let matvec = compute_pipeline(&gpu, MATVEC, "matvec", &matvec_layout);
        let vector_layout = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("voxfe vector"),
            entries: &[uniform_entry(0), storage_entry(1, true), storage_entry(2, true), storage_entry(3, false)],
        });
        let vector = ["axpy", "xpay", "mul"].map(|entry| compute_pipeline(&gpu, VECTOR, entry, &vector_layout));
        GpuOperator {
            multigrid: None,
            gpu,
            dofs: g.dofs(),
            nodes,
            grid_params,
            ke,
            scale,
            mask,
            matvec_layout,
            matvec,
            vector_layout,
            vector,
        }
    }

    /// The adapter description (`name (backend, type)`).
    pub fn adapter(&self) -> &str {
        &self.gpu.adapter
    }

    /// Replaces the element scales (same activity pattern as at creation).
    pub fn set_scale(&self, scale: &[f64]) {
        self.gpu.queue.write_buffer(&self.scale, 0, &f32_bytes(&f32s(scale)));
    }

    /// A new f32 storage vector of the DOF length holding `values` (or zeros).
    pub fn vector(&self, values: Option<&[f64]>) -> wgpu::Buffer {
        match values {
            Some(values) => storage_f32(&self.gpu, "voxfe vector", &f32s(values)),
            None => zeroed_f32(&self.gpu, "voxfe vector", self.dofs),
        }
    }

    /// Reads a DOF-length vector back as f64.
    pub fn read(&self, buffer: &wgpu::Buffer) -> Result<Vec<f64>, String> {
        Ok(read_f32(&self.gpu, buffer, self.dofs)?.into_iter().map(f64::from).collect())
    }

    /// A fixed-order dot for DOF-length vectors.
    pub fn dot_kernel(&self) -> FixedOrderDot {
        FixedOrderDot::new(&self.gpu, self.dofs)
    }

    /// A scalar uniform for [`GpuOperator::encode_vector`].
    pub fn scalar(&self, alpha: f64) -> wgpu::Buffer {
        let (groups_x, _) = dispatch_dims((self.dofs as u32).div_ceil(256));
        let mut bytes = u32_bytes(&[self.dofs as u32, groups_x]);
        bytes.extend(f32_bytes(&[alpha as f32]));
        bytes.extend(u32_bytes(&[0]));
        uniform(&self.gpu, "voxfe scalar", &bytes)
    }

    /// Rewrites a scalar uniform (takes effect at the next submit).
    pub fn set_scalar(&self, scalar: &wgpu::Buffer, alpha: f64) {
        self.gpu.queue.write_buffer(scalar, 8, &f32_bytes(&[alpha as f32]));
    }

    /// Records `y = K u` (masked).
    pub fn encode_matvec(&self, encoder: &mut wgpu::CommandEncoder, u: &wgpu::Buffer, y: &wgpu::Buffer) {
        self.encode_matvec_on([&self.grid_params, &self.ke, &self.scale, &self.mask], self.nodes, encoder, u, y);
    }

    /// Records `y = K u` of a multigrid level from its [`GpuOperator::level_matvec_buffers`].
    pub(crate) fn encode_matvec_with(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        buffers: &[wgpu::Buffer; 4],
        nodes: u32,
        u: &wgpu::Buffer,
        y: &wgpu::Buffer,
    ) {
        let [params, matrices, scale, mask] = buffers;
        self.encode_matvec_on([params, matrices, scale, mask], nodes, encoder, u, y);
    }

    fn encode_matvec_on(
        &self,
        buffers: [&wgpu::Buffer; 4],
        nodes: u32,
        encoder: &mut wgpu::CommandEncoder,
        u: &wgpu::Buffer,
        y: &wgpu::Buffer,
    ) {
        let [params, matrices, scale, mask] = buffers;
        let bind = self.gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("voxfe matvec"),
            layout: &self.matvec_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: matrices.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: scale.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: mask.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: u.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: y.as_entire_binding() },
            ],
        });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("voxfe matvec"), timestamp_writes: None });
        pass.set_pipeline(&self.matvec);
        pass.set_bind_group(0, &bind, &[]);
        let (x, y) = dispatch_dims(nodes.div_ceil(64));
        pass.dispatch_workgroups(x, y, 1);
    }

    /// Mat-vec buffers of a multigrid level with one `stride`-long matrix per element (`[params, matrices, scale, mask]`;
    /// `scale` is 1 for an element with stiffness, 0 otherwise).
    pub(crate) fn level_matvec_buffers(
        &self,
        grid: &crate::grid::Grid,
        stride: usize,
        matrices: &[f32],
        scale: &[f32],
        free: &[bool],
    ) -> [wgpu::Buffer; 4] {
        let [nnx, nny, nnz] = grid.node_dims();
        let nodes = grid.nodes() as u32;
        let (groups_x, _) = dispatch_dims(nodes.div_ceil(64));
        let mut words: Vec<u32> = [nnx, nny, nnz, grid.nx, grid.ny, grid.nz, grid.dim].map(|v| v as u32).to_vec();
        words.extend([nodes, groups_x, stride as u32, 0, 0]);
        let mask: Vec<f32> = free.iter().map(|&f| if f { 1.0 } else { 0.0 }).collect();
        [
            uniform(&self.gpu, "mg level grid", &u32_bytes(&words)),
            storage_f32(&self.gpu, "mg level matrices", matrices),
            storage_f32(&self.gpu, "mg level scale", scale),
            storage_f32(&self.gpu, "mg level mask", &mask),
        ]
    }

    pub(crate) fn gpu(&self) -> &Gpu {
        &self.gpu
    }

    /// The free-DOF mask of the fine level (1 / 0).
    pub(crate) fn mask(&self) -> &wgpu::Buffer {
        &self.mask
    }

    /// Uses a V-cycle of `mg` (whose fine level is this operator, with the same scales) as the preconditioner of
    /// [`GpuOperator::pcg_f32`] from now on; call again after the scales change (the GPU buffers are rewritten in place).
    pub fn set_multigrid(&mut self, mg: &Multigrid<f32>) {
        match self.multigrid.take() {
            Some(existing) => {
                existing.upload(self, mg);
                self.multigrid = Some(existing);
            }
            None => self.multigrid = Some(GpuMultigrid::new(self, mg)),
        }
    }

    /// Records one element-wise kernel; `scalar` comes from [`GpuOperator::scalar`]. `y` must differ from `a` and `b`.
    pub fn encode_vector(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        op: VectorOp,
        scalar: &wgpu::Buffer,
        a: &wgpu::Buffer,
        b: &wgpu::Buffer,
        y: &wgpu::Buffer,
    ) {
        let bind = self.gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("voxfe vector"),
            layout: &self.vector_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: scalar.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: a.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: b.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: y.as_entire_binding() },
            ],
        });
        let pipeline = match op {
            VectorOp::Axpy => &self.vector[0],
            VectorOp::Xpay => &self.vector[1],
            VectorOp::Mul => &self.vector[2],
        };
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("voxfe vector"), timestamp_writes: None });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &bind, &[]);
        let (x, y) = dispatch_dims((self.dofs as u32).div_ceil(256));
        pass.dispatch_workgroups(x, y, 1);
    }

    /// A fresh command encoder.
    pub fn encoder(&self) -> wgpu::CommandEncoder {
        self.gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default())
    }

    /// Submits recorded work.
    pub fn submit(&self, encoder: wgpu::CommandEncoder) {
        self.gpu.queue.submit([encoder.finish()]);
    }

    /// `K u` computed on the GPU (one upload, one dispatch, one read-back).
    pub fn matvec(&self, u: &[f64]) -> Result<Vec<f64>, String> {
        let (input, output) = (self.vector(Some(u)), self.vector(None));
        let mut encoder = self.encoder();
        self.encode_matvec(&mut encoder, &input, &output);
        self.submit(encoder);
        self.read(&output)
    }

    /// Fixed-order `a · b` of two host vectors computed on the GPU.
    pub fn dot(&self, a: &[f64], b: &[f64]) -> Result<f64, String> {
        self.dot_kernel().dot(&self.gpu, &self.vector(Some(a)), &self.vector(Some(b)))
    }

    /// `a ⊙ b`, `y + alpha a` or `a + alpha y` of host vectors computed on the GPU.
    pub fn vector_op(&self, op: VectorOp, alpha: f64, a: &[f64], b: &[f64], y: &[f64]) -> Result<Vec<f64>, String> {
        let (ga, gb, gy) = (self.vector(Some(a)), self.vector(Some(b)), self.vector(Some(y)));
        let scalar = self.scalar(alpha);
        let mut encoder = self.encoder();
        self.encode_vector(&mut encoder, op, &scalar, &ga, &gb, &gy);
        self.submit(encoder);
        self.read(&gy)
    }

    /// `z = M⁻¹ r`: one multigrid V-cycle when a hierarchy is set, else Jacobi (`dinv ⊙ r`).
    fn encode_precondition(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        unit: &wgpu::Buffer,
        dinv: &wgpu::Buffer,
        r: &wgpu::Buffer,
        z: &wgpu::Buffer,
    ) {
        match &self.multigrid {
            Some(multigrid) => multigrid.encode(self, encoder, r, z),
            None => self.encode_vector(encoder, VectorOp::Mul, unit, dinv, r, z),
        }
    }

    /// PCG in f32 on the GPU (V-cycle preconditioner after [`GpuOperator::set_multigrid`], else Jacobi): stops at ‖r‖/‖b‖ ≤ `tolerance` or after `max_iterations` (returning the residual
    /// reached). `inverse_diagonal` is 1/diag(K) on the free DOFs. Errors on breakdown or non-finite values.
    pub fn pcg_f32(&self, inverse_diagonal: &[f64], b: &[f64], tolerance: f64, max_iterations: usize) -> Result<GpuSolve, String> {
        let b_norm = dot(b, b).sqrt();
        if b_norm == 0.0 {
            return Ok(GpuSolve { x: vec![0.0; b.len()], iterations: 0, relative_residual: 0.0 });
        }
        let dinv = self.vector(Some(inverse_diagonal));
        let (x, r, z, p, q) = (self.vector(None), self.vector(Some(b)), self.vector(None), self.vector(None), self.vector(None));
        let (pq_dot, rr_dot, rz_dot) = (self.dot_kernel(), self.dot_kernel(), self.dot_kernel());
        let (alpha, minus_alpha, beta, unit) = (self.scalar(0.0), self.scalar(0.0), self.scalar(0.0), self.scalar(1.0));
        let mut encoder = self.encoder();
        self.encode_precondition(&mut encoder, &unit, &dinv, &r, &z);
        self.encode_vector(&mut encoder, VectorOp::Xpay, &beta, &z, &z, &p);
        rz_dot.encode(&self.gpu, &mut encoder, &r, &z);
        self.submit(encoder);
        let mut rz = rz_dot.resolve(&self.gpu)?;
        let mut residual = 1.0;
        let mut first = true;
        for iteration in 1..=max_iterations {
            let mut encoder = self.encoder();
            if !first {
                self.encode_vector(&mut encoder, VectorOp::Xpay, &beta, &z, &z, &p);
            }
            first = false;
            self.encode_matvec(&mut encoder, &p, &q);
            pq_dot.encode(&self.gpu, &mut encoder, &p, &q);
            self.submit(encoder);
            let pq = pq_dot.resolve(&self.gpu)?;
            if !pq.is_finite() || !rz.is_finite() {
                return Err(format!("GPU PCG produced a non-finite value at iteration {iteration}"));
            }
            if pq <= 0.0 {
                return Err(format!("GPU PCG breakdown at iteration {iteration}: the system is singular"));
            }
            let step = rz / pq;
            self.set_scalar(&alpha, step);
            self.set_scalar(&minus_alpha, -step);
            let mut encoder = self.encoder();
            self.encode_vector(&mut encoder, VectorOp::Axpy, &alpha, &p, &p, &x);
            self.encode_vector(&mut encoder, VectorOp::Axpy, &minus_alpha, &q, &q, &r);
            rr_dot.encode(&self.gpu, &mut encoder, &r, &r);
            self.encode_precondition(&mut encoder, &unit, &dinv, &r, &z);
            rz_dot.encode(&self.gpu, &mut encoder, &r, &z);
            self.submit(encoder);
            residual = rr_dot.resolve(&self.gpu)?.max(0.0).sqrt() / b_norm;
            let rz_next = rz_dot.resolve(&self.gpu)?;
            if !residual.is_finite() {
                return Err(format!("GPU PCG produced a non-finite value at iteration {iteration}"));
            }
            if residual <= tolerance {
                return Ok(GpuSolve { x: self.read(&x)?, iterations: iteration, relative_residual: residual });
            }
            self.set_scalar(&beta, rz_next / rz);
            rz = rz_next;
        }
        Ok(GpuSolve { x: self.read(&x)?, iterations: max_iterations, relative_residual: residual })
    }
}

/// Outcome of [`refine`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RefineStats {
    /// f64 refinement steps (one f32 GPU solve each).
    pub outer: usize,
    /// Total f32 PCG iterations on the GPU.
    pub inner: usize,
    pub relative_residual: f64,
}

/// Solves `K x = b` to the f64 relative residual `tolerance`: the residual is formed in f64 by the CPU twin, each correction
/// is an f32 Jacobi PCG on the GPU to `inner_tolerance` (1e-4 typical). Fails when a step stops reducing the residual.
pub fn refine(
    gpu: &GpuOperator,
    op: &Operator,
    b: &[f64],
    x: &mut [f64],
    tolerance: f64,
    inner_tolerance: f64,
    max_inner: usize,
) -> Result<RefineStats, String> {
    let mut rhs = b.to_vec();
    op.mask(&mut rhs);
    op.mask(x);
    let b_norm = dot(&rhs, &rhs).sqrt();
    if b_norm == 0.0 {
        x.fill(0.0);
        return Ok(RefineStats { outer: 0, inner: 0, relative_residual: 0.0 });
    }
    let inverse = inverse_diagonal(op);
    let mut kx = vec![0.0; b.len()];
    let (mut inner, mut previous) = (0, f64::INFINITY);
    for outer in 0..=60 {
        op.apply(x, &mut kx);
        let r: Vec<f64> = rhs.iter().zip(&kx).map(|(b, k)| b - k).collect();
        let residual = dot(&r, &r).sqrt() / b_norm;
        if residual <= tolerance {
            return Ok(RefineStats { outer, inner, relative_residual: residual });
        }
        if !residual.is_finite() || residual > 0.9 * previous {
            return Err(format!("GPU refinement stalled at relative residual {residual:.3e} after {outer} steps"));
        }
        previous = residual;
        let correction = gpu.pcg_f32(&inverse, &r, inner_tolerance, max_inner)?;
        inner += correction.iterations;
        for (x, d) in x.iter_mut().zip(&correction.x) {
            *x += d;
        }
    }
    Err(format!("GPU refinement did not reach {tolerance:.1e} in 60 steps"))
}
