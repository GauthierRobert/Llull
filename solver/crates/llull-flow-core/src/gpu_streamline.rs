//! wgpu streamlines (feature `gpu`): `streamline.wgsl` integrates every (seed, direction) in f32 on positions relative to the
//! grid origin; the host checks the seeds in f64 (as the CPU path does), dispatches the tasks in batches whose point buffer stays
//! below [`BATCH_BYTES`], and assembles the halves (lengths re-summed in f64). Not bit-identical to the CPU path (f32): the job
//! reports `deterministic: false`, and VC-CFD-42 bounds the difference on an analytic field.

use crate::field::FlowField;
use crate::streamline::{seed_speed, Half, Settings, Stop, Traced};
use llull_gpu::buffers::{dispatch_dims, storage_f32, u32_bytes, uniform, STORAGE};
use llull_gpu::device::{acquire, Gpu};
use llull_gpu::dot::{compute_pipeline, storage_entry, uniform_entry};
use llull_gpu::wgpu;
use llull_gpu::wgpu::util::DeviceExt;

const SHADER: &str = include_str!("streamline.wgsl");
const THREADS: usize = 64;
/// Named guard: bytes of the per-batch point buffer (16 bytes per point slot).
const BATCH_BYTES: usize = 64 * 1024 * 1024;

fn read_bytes(gpu: &Gpu, buffer: &wgpu::Buffer, size: u64) -> Result<Vec<u8>, String> {
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("llull-flow-core streamline read-back"),
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
    let bytes = slice.get_mapped_range().to_vec();
    staging.unmap();
    Ok(bytes)
}

fn word(bytes: &[u8], index: usize) -> [u8; 4] {
    [bytes[4 * index], bytes[4 * index + 1], bytes[4 * index + 2], bytes[4 * index + 3]]
}

fn params_bytes(field: &FlowField, settings: &Settings, tasks: usize, max_steps: usize, groups_x: u32) -> Vec<u8> {
    let grid = &field.grid;
    let mut axis = [0u32; 4];
    let mut high = [0u32; 4];
    let mut plane = [0f32; 4];
    for (m, (a, value, is_high)) in field.mirrors.iter().enumerate().take(3) {
        axis[m] = *a as u32;
        high[m] = u32::from(*is_high);
        plane[m] = (value - grid.origin[*a]) as f32;
    }
    axis[3] = tasks as u32;
    high[3] = max_steps as u32;
    plane[3] = grid.h as f32;
    let mut bytes = u32_bytes(&[grid.nx as u32, grid.ny as u32, grid.nz as u32, field.mirrors.len().min(3) as u32]);
    bytes.extend(u32_bytes(&axis));
    bytes.extend(u32_bytes(&high));
    bytes.extend(plane.iter().flat_map(|v| v.to_le_bytes()));
    let limits = [settings.step_m as f32, settings.max_length_m as f32, settings.min_speed_ms as f32, 0.0];
    bytes.extend(limits.iter().flat_map(|v| v.to_le_bytes()));
    bytes.extend(u32_bytes(&[groups_x, 0, 0, 0]));
    bytes
}

/// Traces on the GPU; Err(reason) when no adapter can be opened or the field exceeds its binding limit (the caller runs the CPU).
pub fn trace_gpu(field: &FlowField, seeds: &[[f64; 3]], settings: &Settings) -> Result<(Vec<Traced>, String), String> {
    let gpu = acquire("llull-flow-core streamlines")?;
    let n = field.grid.cells();
    let limits = gpu.device.limits();
    let cap = u64::from(limits.max_storage_buffer_binding_size).min(limits.max_buffer_size);
    let max_steps = settings.max_steps.max(1);
    let batch = (BATCH_BYTES / 16 / max_steps).max(1);
    if (n * 4) as u64 > cap || (batch * max_steps * 16) as u64 > cap {
        return Err(format!("the field ({n} cells) or a point batch exceeds the adapter's {cap}-byte binding limit"));
    }
    let mut bits = vec![0u32; n.div_ceil(32).max(1)];
    for (cell, valid) in field.valid.iter().enumerate() {
        if *valid {
            bits[cell >> 5] |= 1 << (cell & 31);
        }
    }
    let buffers = [
        storage_f32(&gpu, "ux", &field.ux),
        storage_f32(&gpu, "uy", &field.uy),
        storage_f32(&gpu, "uz", &field.uz),
        gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("valid"),
            contents: &u32_bytes(&bits),
            usage: STORAGE,
        }),
    ];
    let layout = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("llull-flow-core streamlines"),
        entries: &[
            uniform_entry(0),
            storage_entry(1, true),
            storage_entry(2, true),
            storage_entry(3, true),
            storage_entry(4, true),
            storage_entry(5, true),
            storage_entry(6, false),
            storage_entry(7, false),
        ],
    });
    let pipeline = compute_pipeline(&gpu, SHADER, "trace", &layout);

    let speeds: Vec<Result<f64, Stop>> = seeds.iter().map(|seed| seed_speed(field, *seed)).collect();
    let mut tasks: Vec<(usize, f64)> = Vec::new();
    for (index, speed) in speeds.iter().enumerate() {
        if speed.is_ok() {
            if settings.backward {
                tasks.push((index, -1.0));
            }
            if settings.forward {
                tasks.push((index, 1.0));
            }
        }
    }
    let origin = field.grid.origin;
    let mut halves: Vec<Half> = Vec::with_capacity(tasks.len());
    for chunk in tasks.chunks(batch) {
        let seed_data: Vec<f32> = chunk
            .iter()
            .flat_map(|(index, sign)| {
                let s = seeds[*index];
                [(s[0] - origin[0]) as f32, (s[1] - origin[1]) as f32, (s[2] - origin[2]) as f32, *sign as f32]
            })
            .collect();
        let groups = chunk.len().div_ceil(THREADS).max(1) as u32;
        let (gx, gy) = dispatch_dims(groups);
        let params = uniform(&gpu, "params", &params_bytes(field, settings, chunk.len(), max_steps, gx));
        let seed_buffer = storage_f32(&gpu, "seeds", &seed_data);
        let point_size = (chunk.len() * max_steps * 16) as u64;
        let info_size = (chunk.len() * 8) as u64;
        let make = |label: &str, size: u64| {
            gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size, usage: STORAGE, mapped_at_creation: false })
        };
        let (points, info) = (make("points", point_size), make("info", info_size));
        let bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("llull-flow-core streamlines"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: buffers[0].as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: buffers[1].as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: buffers[2].as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: buffers[3].as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: seed_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: points.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 7, resource: info.as_entire_binding() },
            ],
        });
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("streamlines"), timestamp_writes: None });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups(gx, gy, 1);
        }
        gpu.queue.submit([encoder.finish()]);
        let info_bytes = read_bytes(&gpu, &info, info_size)?;
        let point_bytes = read_bytes(&gpu, &points, point_size)?;
        for (slot, (index, _)) in chunk.iter().enumerate() {
            let count = (u32::from_le_bytes(word(&info_bytes, 2 * slot)) as usize).min(max_steps);
            let stop = Stop::from_code(u32::from_le_bytes(word(&info_bytes, 2 * slot + 1)));
            let mut half = Half { stop: Some(stop), ..Half::default() };
            let mut previous = seeds[*index];
            for k in 0..count {
                let base = 4 * (slot * max_steps + k);
                let value = |offset: usize| f64::from(f32::from_le_bytes(word(&point_bytes, base + offset)));
                let point = [value(0) + origin[0], value(1) + origin[1], value(2) + origin[2]];
                let d = [point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]];
                half.length_m += (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
                half.points.push(point);
                half.speeds.push(value(3));
                previous = point;
            }
            halves.push(half);
        }
    }
    let untraced = Half { stop: Some(Stop::NotTraced), ..Half::default() };
    let mut next = halves.into_iter();
    let traced = speeds
        .into_iter()
        .map(|speed| {
            if speed.is_err() {
                return Traced { seed_speed: speed, backward: untraced.clone(), forward: untraced.clone() };
            }
            let backward = if settings.backward { next.next().unwrap_or_default() } else { untraced.clone() };
            let forward = if settings.forward { next.next().unwrap_or_default() } else { untraced.clone() };
            Traced { seed_speed: speed, backward, forward }
        })
        .collect();
    Ok((traced, gpu.adapter.clone()))
}
