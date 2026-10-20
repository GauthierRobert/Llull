//! GPU driver of the explicit solver (RS1 RS-8b, feature `gpu`): the kernels of `explicit.wgsl` (f64, SHADER_F64) run the same
//! algorithm as the CPU path of `solver.rs`, with the same step control on the host. Every cycle reads back one f64 (the minimum
//! stable step); history samples read back the per-node / per-element accumulators and add them on the host in node / element
//! order. No atomics anywhere, so a run is bit-reproducible on one device and driver (`deterministic: true`); it is NOT
//! bit-identical to the CPU twin (operation order, FMA contraction, f32 exp / log / pow): the CPU path stays the reference
//! (RS1 §2 rule 3) and `tests/gpu.rs` bounds the difference.

use crate::model::Model;
use crate::solver::{centroid, eigen_step, elements_of, kinematics, nodal_masses, sample_walls, EnergyRow, Outcome, Progress, WallHistory};
use llull_gpu::buffers::{dispatch_dims, u32_bytes, STORAGE};
use llull_gpu::device::{acquire_with, Gpu};
use llull_gpu::dot::{compute_pipeline, storage_entry, uniform_entry};
use llull_gpu::wgpu;
use wgpu::util::DeviceExt;

const SHADER: &str = include_str!("explicit.wgsl");
const WORKGROUP: u32 = 64;
/// Group count per dispatch row the shader folds linear indices with (`counts.groups_x`).
const GROUPS_X: u32 = 65_535;
const READ_ONLY: [u32; 9] = [1, 2, 8, 11, 12, 13, 14, 18, 19];

fn f64_bytes(values: &[f64]) -> Vec<u8> {
    let mut bytes: Vec<u8> = values.iter().flat_map(|value| value.to_le_bytes()).collect();
    if bytes.is_empty() {
        bytes.resize(8, 0);
    }
    bytes
}

fn buffer(gpu: &Gpu, label: &str, bytes: Vec<u8>) -> wgpu::Buffer {
    let mut bytes = bytes;
    if bytes.is_empty() {
        bytes.resize(8, 0);
    }
    gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: &bytes, usage: STORAGE })
}

fn read_f64(gpu: &Gpu, source: &wgpu::Buffer, len: usize) -> Result<Vec<f64>, String> {
    let size = (len.max(1) * 8) as u64;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("explicit read-back"),
        size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    encoder.copy_buffer_to_buffer(source, 0, &staging, 0, size);
    gpu.queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    gpu.device.poll(wgpu::PollType::Wait).map_err(|error| format!("GPU poll failed: {error}"))?;
    let data = slice.get_mapped_range();
    let values = data.chunks_exact(8).take(len).map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]])).collect();
    drop(data);
    staging.unmap();
    Ok(values)
}

struct Kernels {
    kick: wgpu::ComputePipeline,
    element: wgpu::ComputePipeline,
    gather: wgpu::ComputePipeline,
    min_step: wgpu::ComputePipeline,
    commit: wgpu::ComputePipeline,
}

struct Buffers {
    scalars: wgpu::Buffer,
    x: wgpu::Buffer,
    v_half: wgpu::Buffer,
    v_new: wgpu::Buffer,
    f_int: wgpu::Buffer,
    wall_impulse: wgpu::Buffer,
    node_energy: wgpu::Buffer,
    state: wgpu::Buffer,
    elem_energy: wgpu::Buffer,
    reduced: wgpu::Buffer,
}

fn pass(encoder: &mut wgpu::CommandEncoder, pipeline: &wgpu::ComputePipeline, bind: &wgpu::BindGroup, items: usize) {
    let mut compute = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("explicit"), timestamp_writes: None });
    compute.set_pipeline(pipeline);
    compute.set_bind_group(0, bind, &[]);
    let (x, y) = dispatch_dims((items as u32).div_ceil(WORKGROUP).max(1));
    compute.dispatch_workgroups(x, y, 1);
}

/// Material table: 20 f64 per material (layout in explicit.wgsl).
fn material_table(model: &Model) -> Vec<f64> {
    model
        .materials
        .iter()
        .flat_map(|material| {
            let jc = material.johnson_cook;
            let failure = material.failure;
            let mut row = vec![
                material.density,
                material.youngs_modulus,
                material.poisson,
                material.lambda(),
                material.shear(),
                material.bulk(),
                if jc.is_some() { 1.0 } else { 0.0 },
            ];
            let j = jc.unwrap_or(crate::model::JohnsonCook {
                a: 0.0,
                b: 0.0,
                n: 1.0,
                c: 0.0,
                reference_rate: 1.0,
                m: 1.0,
                melt_k: 1.0,
                transition_k: 0.0,
            });
            row.extend_from_slice(&[j.a, j.b, j.n, j.c, j.reference_rate, j.m, if failure.is_some() { 1.0 } else { 0.0 }]);
            row.extend_from_slice(&failure.map(|f| f.d).unwrap_or([0.0; 5]));
            row.push(0.0);
            row
        })
        .collect()
}

/// Integrates `model` on the GPU. `Err` when no adapter with SHADER_F64 exists (the caller runs the CPU twin) or a GPU call fails.
pub fn run(model: &Model, progress: &mut impl FnMut(Progress)) -> Result<(Outcome, String), String> {
    if !model.contacts.is_empty() || model.fixed.iter().any(|&held| held) {
        return Err("contact and fixed supports run on the CPU path only (RS-8c)".to_string());
    }
    let gpu = acquire_with("llull-explicit", wgpu::Features::SHADER_F64)?;
    let controls = &model.controls;
    let x0 = model.coordinates.clone();
    let (elements, initial_mass, added_mass) = elements_of(model, &x0)?;
    let masses = nodal_masses(model, &elements);
    if masses.iter().any(|&mass| !(mass > 0.0)) {
        return Err("a node belongs to no element (zero mass)".to_string());
    }
    let nodes = model.node_count();
    let count = elements.len();
    let walls_count = model.walls.len();
    // Element tables and the node -> (element, local node) incidence in element order.
    let mut elem_nodes = vec![0u32; 8 * count];
    let mut elem_info = vec![0u32; 2 * count];
    let mut elem_mass = vec![0.0f64; 9 * count];
    let mut incidence_lists: Vec<Vec<u32>> = vec![Vec::new(); nodes];
    for (e, element) in elements.iter().enumerate() {
        elem_info[2 * e] = element.nodes.len() as u32;
        elem_info[2 * e + 1] = element.material as u32;
        elem_mass[9 * e] = element.mass;
        for (k, &node) in element.nodes.iter().enumerate() {
            elem_nodes[8 * e + k] = node as u32;
            elem_mass[9 * e + 1 + k] = element.node_masses[k];
            incidence_lists[node].push((8 * e + k) as u32);
        }
    }
    let mut incidence_start = vec![0u32; nodes + 1];
    let mut incidence = Vec::new();
    for (node, list) in incidence_lists.iter().enumerate() {
        incidence.extend_from_slice(list);
        incidence_start[node + 1] = incidence.len() as u32;
    }
    let walls: Vec<f64> = model.walls.iter().flat_map(|wall| [wall.point, wall.normal].concat()).collect();
    let g = model.gravity;
    let scalars_init = [0.0, 0.0, controls.hourglass_coefficient, controls.bulk_linear, controls.bulk_quadratic, g[0], g[1], g[2]];
    let counts = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("explicit counts"),
        contents: &u32_bytes(&[nodes as u32, count as u32, walls_count as u32, GROUPS_X]),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let b = Buffers {
        scalars: buffer(&gpu, "scalars", f64_bytes(&scalars_init)),
        x: buffer(&gpu, "x", f64_bytes(&x0)),
        v_half: buffer(&gpu, "v_half", f64_bytes(&model.initial_velocity)),
        v_new: buffer(&gpu, "v_new", f64_bytes(&vec![0.0; 3 * nodes])),
        f_int: buffer(&gpu, "f_int", f64_bytes(&vec![0.0; 3 * nodes])),
        wall_impulse: buffer(&gpu, "wall_impulse", f64_bytes(&vec![0.0; walls_count * nodes])),
        node_energy: buffer(&gpu, "node_energy", f64_bytes(&vec![0.0; 2 * nodes])),
        state: buffer(&gpu, "state", f64_bytes(&vec![0.0; 10 * count])),
        elem_energy: buffer(&gpu, "elem_energy", f64_bytes(&vec![0.0; 3 * count])),
        reduced: buffer(&gpu, "reduced", f64_bytes(&[0.0])),
    };
    let mass = buffer(&gpu, "mass", f64_bytes(&masses));
    let x_new = buffer(&gpu, "x_new", f64_bytes(&vec![0.0; 3 * nodes]));
    let walls_buffer = buffer(&gpu, "walls", f64_bytes(&walls));
    let elem_nodes_buffer = buffer(&gpu, "elem_nodes", u32_bytes(&elem_nodes));
    let elem_info_buffer = buffer(&gpu, "elem_info", u32_bytes(&elem_info));
    let elem_mass_buffer = buffer(&gpu, "elem_mass", f64_bytes(&elem_mass));
    let materials = buffer(&gpu, "materials", f64_bytes(&material_table(model)));
    let elem_force = buffer(&gpu, "elem_force", f64_bytes(&vec![0.0; 24 * count]));
    let start_buffer = buffer(&gpu, "incidence_start", u32_bytes(&incidence_start));
    let incidence_buffer = buffer(&gpu, "incidence", u32_bytes(&incidence));
    let entries: Vec<wgpu::BindGroupLayoutEntry> = (0..21u32)
        .map(|binding| if binding == 0 { uniform_entry(0) } else { storage_entry(binding, READ_ONLY.contains(&binding)) })
        .collect();
    let layout = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("explicit"), entries: &entries });
    let resources: [&wgpu::Buffer; 21] = [
        &counts,
        &b.scalars,
        &mass,
        &b.x,
        &x_new,
        &b.v_half,
        &b.v_new,
        &b.f_int,
        &walls_buffer,
        &b.wall_impulse,
        &b.node_energy,
        &elem_nodes_buffer,
        &elem_info_buffer,
        &elem_mass_buffer,
        &materials,
        &b.state,
        &elem_force,
        &b.elem_energy,
        &start_buffer,
        &incidence_buffer,
        &b.reduced,
    ];
    let bind_entries: Vec<wgpu::BindGroupEntry> = resources
        .iter()
        .enumerate()
        .map(|(binding, resource)| wgpu::BindGroupEntry { binding: binding as u32, resource: resource.as_entire_binding() })
        .collect();
    let bind =
        gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("explicit"), layout: &layout, entries: &bind_entries });
    let kernels = Kernels {
        kick: compute_pipeline(&gpu, SHADER, "kick", &layout),
        element: compute_pipeline(&gpu, SHADER, "element", &layout),
        gather: compute_pipeline(&gpu, SHADER, "gather", &layout),
        min_step: compute_pipeline(&gpu, SHADER, "min_step", &layout),
        commit: compute_pipeline(&gpu, SHADER, "commit", &layout),
    };

    let mut element_dt = f64::INFINITY;
    for element in &elements {
        let (gradients, volume) = kinematics(&element.nodes, &x0);
        element_dt = element_dt.min(eigen_step(&gradients, volume, &element.node_masses, &model.materials[element.material]));
    }
    let initial_kinetic: f64 = (0..3 * nodes).map(|k| 0.5 * masses[k / 3] * model.initial_velocity[k] * model.initial_velocity[k]).sum();
    let mut energy =
        vec![EnergyRow { time: 0.0, kinetic: initial_kinetic, internal: 0.0, hourglass: 0.0, wall: 0.0, contact: 0.0, external_work: 0.0 }];
    let mut walls_history: Vec<WallHistory> =
        model.walls.iter().map(|wall| WallHistory { name: wall.name.clone(), times: vec![], forces: vec![] }).collect();
    let mut last_sample = 0.0;
    let mut next_sample = controls.history_interval;
    let (mut dt_prev, mut time, mut cycles, mut min_dt) = (0.0, 0.0, 0u64, f64::INFINITY);
    let mut message = String::new();
    let mut normal = true;
    let end = controls.end_time;
    let totals = |gpu: &Gpu, b: &Buffers| -> Result<(f64, f64, f64, f64, Vec<f64>), String> {
        let elem_energy = read_f64(gpu, &b.elem_energy, 3 * count)?;
        let node_energy = read_f64(gpu, &b.node_energy, 2 * nodes)?;
        let impulse = read_f64(gpu, &b.wall_impulse, walls_count * nodes)?;
        let internal = (0..count).map(|e| elem_energy[3 * e]).sum::<f64>();
        let hourglass = (0..count).map(|e| elem_energy[3 * e + 1]).sum::<f64>();
        let wall = (0..nodes).map(|n| node_energy[2 * n]).sum::<f64>();
        let external = (0..nodes).map(|n| node_energy[2 * n + 1]).sum::<f64>();
        let per_wall = (0..walls_count).map(|w| impulse[w * nodes..(w + 1) * nodes].iter().sum::<f64>()).collect();
        Ok((internal, hourglass, wall, external, per_wall))
    };
    while time < end * (1.0 - 1e-12) {
        let mut dt = controls.time_step_scale * element_dt;
        if let Some(limit) = controls.min_time_step {
            if dt < limit {
                normal = false;
                message = format!("the stable time step {dt:e} s fell below minTimeStep {limit:e} s at t = {time:e} s");
                break;
            }
        }
        if cycles >= controls.max_cycles {
            normal = false;
            message = format!("maxCycles {} reached at t = {time:e} s", controls.max_cycles);
            break;
        }
        min_dt = min_dt.min(dt);
        dt = dt.min(end - time);
        gpu.queue.write_buffer(&b.scalars, 0, &f64_bytes(&[dt_prev, dt]));
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        pass(&mut encoder, &kernels.kick, &bind, nodes);
        gpu.queue.submit([encoder.finish()]);
        if cycles > 0 && time >= next_sample * (1.0 - 1e-12) {
            let v_half = read_f64(&gpu, &b.v_half, 3 * nodes)?;
            let v_new = read_f64(&gpu, &b.v_new, 3 * nodes)?;
            let kinetic: f64 = (0..3 * nodes).map(|k| 0.5 * masses[k / 3] * (0.5 * (v_half[k] + v_new[k])).powi(2)).sum();
            let (internal, hourglass, wall, external_work, mut impulse) = totals(&gpu, &b)?;
            if !internal.is_finite() {
                normal = false;
                message = format!("the solution became non-finite at t = {time:e} s");
                break;
            }
            energy.push(EnergyRow { time, kinetic, internal, hourglass, wall, contact: 0.0, external_work });
            sample_walls(&mut walls_history, &mut impulse, time, last_sample);
            gpu.queue.write_buffer(&b.wall_impulse, 0, &f64_bytes(&vec![0.0; walls_count * nodes]));
            last_sample = time;
            next_sample = (((time / controls.history_interval) + 1e-9).floor() + 1.0) * controls.history_interval;
        }
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        pass(&mut encoder, &kernels.element, &bind, count);
        pass(&mut encoder, &kernels.gather, &bind, nodes);
        {
            let mut compute = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("min_step"), timestamp_writes: None });
            compute.set_pipeline(&kernels.min_step);
            compute.set_bind_group(0, &bind, &[]);
            compute.dispatch_workgroups(1, 1, 1);
        }
        pass(&mut encoder, &kernels.commit, &bind, nodes);
        gpu.queue.submit([encoder.finish()]);
        element_dt = read_f64(&gpu, &b.reduced, 1)?[0];
        time += dt;
        dt_prev = dt;
        cycles += 1;
        if !(element_dt.is_finite() && element_dt > 0.0 && element_dt < 1e299) {
            if element_dt >= 1e299 {
                normal = false;
                message = format!("every element eroded at t = {time:e} s");
            } else {
                normal = false;
                message = format!("the solution became non-finite at t = {time:e} s");
            }
            break;
        }
        progress(Progress { cycle: cycles, time, dt });
    }
    let v_half = read_f64(&gpu, &b.v_half, 3 * nodes)?;
    let f_int = read_f64(&gpu, &b.f_int, 3 * nodes)?;
    let external: Vec<f64> = (0..3 * nodes).map(|k| masses[k / 3] * g[k % 3]).collect();
    let v_end: Vec<f64> = (0..3 * nodes).map(|k| v_half[k] + 0.5 * dt_prev * (external[k] - f_int[k]) / masses[k / 3]).collect();
    let kinetic: f64 = (0..3 * nodes).map(|k| 0.5 * masses[k / 3] * v_end[k] * v_end[k]).sum();
    let (internal, hourglass, wall, external_work, mut impulse) = totals(&gpu, &b)?;
    energy.push(EnergyRow { time, kinetic, internal, hourglass, wall, contact: 0.0, external_work });
    if time > last_sample {
        sample_walls(&mut walls_history, &mut impulse, time, last_sample);
    }
    let x = read_f64(&gpu, &b.x, 3 * nodes)?;
    let state = read_f64(&gpu, &b.state, 10 * count)?;
    let mut fields = Vec::with_capacity(6 * count);
    for (e, element) in elements.iter().enumerate() {
        let c = centroid(&element.nodes, &x);
        let s: [f64; 6] = std::array::from_fn(|k| state[10 * e + k]);
        fields.extend_from_slice(&[crate::material::von_mises(&s), state[10 * e + 6], state[10 * e + 8], c[0], c[1], c[2]]);
    }
    let outcome = Outcome {
        normal,
        message,
        cycles,
        final_time: time,
        min_time_step: if min_dt.is_finite() { min_dt } else { 0.0 },
        initial_mass,
        added_mass,
        energy,
        walls: walls_history,
        fields,
        coordinates: x,
        velocities: v_half,
    };
    Ok((outcome, gpu.adapter.clone()))
}
