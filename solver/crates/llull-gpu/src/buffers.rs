//! Buffer helpers: little-endian f32 / u32 storage buffers, uniforms, read-back, and 2D dispatch sizing (a dimension holds at
//! most 65 535 workgroups, so large 1D problems are folded into x × y and the shader rebuilds the linear index).

use crate::device::Gpu;
use wgpu::util::DeviceExt;

/// Usage of a storage buffer the kernels read and write and the host copies to / from.
pub const STORAGE: wgpu::BufferUsages = wgpu::BufferUsages::STORAGE.union(wgpu::BufferUsages::COPY_SRC).union(wgpu::BufferUsages::COPY_DST);

/// Largest workgroup count per dispatch dimension guaranteed by WebGPU.
pub const MAX_GROUPS_PER_DIMENSION: u32 = 65_535;

/// Little-endian bytes of f32 values.
pub fn f32_bytes(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// Little-endian bytes of u32 values.
pub fn u32_bytes(values: &[u32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// A storage buffer holding `values` (at least 4 bytes: empty bindings are invalid).
pub fn storage_f32(gpu: &Gpu, label: &str, values: &[f32]) -> wgpu::Buffer {
    let mut bytes = f32_bytes(values);
    if bytes.is_empty() {
        bytes.resize(4, 0);
    }
    gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: &bytes, usage: STORAGE })
}

/// A zeroed storage buffer of `len` f32 values.
pub fn zeroed_f32(gpu: &Gpu, label: &str, len: usize) -> wgpu::Buffer {
    gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: (len.max(1) * 4) as u64,
        usage: STORAGE,
        mapped_at_creation: false,
    })
}

/// A uniform buffer holding `bytes` (padded to 16 bytes), writable later with `queue.write_buffer`.
pub fn uniform(gpu: &Gpu, label: &str, bytes: &[u8]) -> wgpu::Buffer {
    let mut padded = bytes.to_vec();
    padded.resize(bytes.len().div_ceil(16).max(1) * 16, 0);
    gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: &padded,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    })
}

/// Copies the first `len` f32 values of `buffer` back to the host (waits for the GPU).
pub fn read_f32(gpu: &Gpu, buffer: &wgpu::Buffer, len: usize) -> Result<Vec<f32>, String> {
    let size = (len.max(1) * 4) as u64;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("llull-gpu read-back"),
        size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    encoder.copy_buffer_to_buffer(buffer, 0, &staging, 0, size);
    gpu.queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    gpu.device.poll(wgpu::PollType::Wait).map_err(|error| format!("GPU poll failed: {error}"))?;
    let data = slice.get_mapped_range();
    let values = data.chunks_exact(4).take(len).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    drop(data);
    staging.unmap();
    Ok(values)
}

/// Workgroup grid `(x, y)` covering `groups` workgroups; the shader's linear group index is `wid.y * x + wid.x` and it must
/// ignore indices at or above `groups`.
pub fn dispatch_dims(groups: u32) -> (u32, u32) {
    if groups <= MAX_GROUPS_PER_DIMENSION {
        (groups.max(1), 1)
    } else {
        (MAX_GROUPS_PER_DIMENSION, groups.div_ceil(MAX_GROUPS_PER_DIMENSION))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_folds_large_counts_into_two_dimensions() {
        assert_eq!(dispatch_dims(0), (1, 1));
        assert_eq!(dispatch_dims(10), (10, 1));
        assert_eq!(dispatch_dims(65_536), (65_535, 2));
        let (x, y) = dispatch_dims(1_000_000);
        assert!(x * y >= 1_000_000 && x * (y - 1) < 1_000_000);
    }

    #[test]
    fn bytes_are_little_endian() {
        assert_eq!(f32_bytes(&[1.0]), vec![0, 0, 128, 63]);
        assert_eq!(u32_bytes(&[258]), vec![2, 1, 0, 0]);
    }
}
