//! GPU driver of the explicit solver (RS1 RS-8, feature `gpu`): the kernels of `explicit.wgsl`, `explicit_shell.wgsl` and
//! `explicit_contact.wgsl` (f64, SHADER_F64) run the same algorithm as the CPU path of `solver.rs`, with the same step control on the
//! host. Every cycle reads back two f64 (the minimum stable step and the largest node motion since the last contact search); history
//! samples read back the per-node / per-element accumulators and add them on the host in node / element order. No atomics anywhere, so
//! a run is bit-reproducible on one device and driver (`deterministic: true`); it is NOT bit-identical to the CPU twin (operation order,
//! FMA contraction, f32 exp / log / pow): the CPU path stays the reference (RS1 §2 rule 3) and `tests/gpu.rs` bounds the difference.
//!
//! - Solids, gather, step reduction, integration, walls, fixed and imposed dofs: `explicit.wgsl`.
//! - Shells (Belytschko–Tsay / Belytschko–Wong–Chiang): angular-velocity kick, nodal normals, one thread per shell, forces into the
//!   element force slots after the solids (the same fixed-order gather), moments by a shell-ordered gather: `explicit_shell.wgsl`.
//! - Penalty contact: one thread per slave on its candidate list, then a per-node gather in the CPU accumulation order:
//!   `explicit_contact.wgsl`. The candidate lists come from the host BVH (`Contacts::candidates`) with the margin 2δ, δ = ¼ of the
//!   contact reach; the GPU reports the largest node motion since that search every cycle and the host searches again once it passes δ,
//!   so the lists always contain every pair the CPU search would find.

use crate::contact::Contacts;
use crate::gpu_tables::{contact_search, load_shell_states, shell_tables, ContactSearch};
use crate::model::Model;
use crate::shells::Shells;
use crate::solver::{centroid, eigen_step, elements_of, kinematics, nodal_masses, sample_walls, EnergyRow, Outcome, Progress, WallHistory};
use llull_gpu::buffers::{dispatch_dims, u32_bytes, STORAGE};
use llull_gpu::device::{acquire_with, Gpu};
use llull_gpu::dot::{storage_entry, uniform_entry};
use llull_gpu::wgpu;
use wgpu::util::DeviceExt;

const SHADER: &str = concat!(include_str!("explicit.wgsl"), include_str!("explicit_shell.wgsl"), include_str!("explicit_contact.wgsl"));
const WORKGROUP: u32 = 64;
/// Group count per dispatch row the shader folds linear indices with (`counts.groups_x`).
const GROUPS_X: u32 = 65_535;
const READ_ONLY0: [u32; 14] = [1, 2, 8, 11, 12, 13, 14, 18, 19, 22, 23, 24, 25, 26];
const READ_ONLY1: [u32; 15] = [1, 2, 6, 7, 12, 13, 14, 15, 16, 17, 18, 19, 22, 23, 24];

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

fn layout(gpu: &Gpu, label: &str, bindings: u32, read_only: &[u32]) -> wgpu::BindGroupLayout {
    let entries: Vec<wgpu::BindGroupLayoutEntry> = (0..bindings)
        .map(|binding| if binding == 0 { uniform_entry(0) } else { storage_entry(binding, read_only.contains(&binding)) })
        .collect();
    gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries: &entries })
}

fn bind_group(gpu: &Gpu, layout: &wgpu::BindGroupLayout, resources: &[&wgpu::Buffer]) -> wgpu::BindGroup {
    let entries: Vec<wgpu::BindGroupEntry> = resources
        .iter()
        .enumerate()
        .map(|(binding, resource)| wgpu::BindGroupEntry { binding: binding as u32, resource: resource.as_entire_binding() })
        .collect();
    gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("explicit"), layout, entries: &entries })
}

fn pipeline(gpu: &Gpu, module: &wgpu::ShaderModule, entry: &str, layouts: &[&wgpu::BindGroupLayout]) -> wgpu::ComputePipeline {
    let pipeline_layout = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(entry),
        bind_group_layouts: layouts,
        push_constant_ranges: &[],
    });
    gpu.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(entry),
        layout: Some(&pipeline_layout),
        module,
        entry_point: Some(entry),
        compilation_options: wgpu::PipelineCompilationOptions::default(),
        cache: None,
    })
}

struct Kernels {
    contact_slave: wgpu::ComputePipeline,
    contact_gather: wgpu::ComputePipeline,
    kick: wgpu::ComputePipeline,
    shell_kick: wgpu::ComputePipeline,
    element: wgpu::ComputePipeline,
    shell_normals: wgpu::ComputePipeline,
    node_normals: wgpu::ComputePipeline,
    shell_step: wgpu::ComputePipeline,
    gather: wgpu::ComputePipeline,
    moment_gather: wgpu::ComputePipeline,
    min_step: wgpu::ComputePipeline,
    commit: wgpu::ComputePipeline,
}

struct Buffers {
    scalars: wgpu::Buffer,
    x: wgpu::Buffer,
    x_new: wgpu::Buffer,
    v_half: wgpu::Buffer,
    v_new: wgpu::Buffer,
    f_int: wgpu::Buffer,
    wall_impulse: wgpu::Buffer,
    node_energy: wgpu::Buffer,
    state: wgpu::Buffer,
    elem_energy: wgpu::Buffer,
    reduced: wgpu::Buffer,
    contact_energy: wgpu::Buffer,
}

/// The buffers one contact candidate search fills (rebuilt by the next search).
struct SearchBuffers {
    slaves: wgpu::Buffer,
    candidates: wgpu::Buffer,
    gather_start: wgpu::Buffer,
    gather: wgpu::Buffer,
    x_search: wgpu::Buffer,
}

impl SearchBuffers {
    fn new(gpu: &Gpu, search: &ContactSearch, x: &[f64]) -> SearchBuffers {
        SearchBuffers {
            slaves: buffer(gpu, "slaves", u32_bytes(&search.slaves)),
            candidates: buffer(gpu, "candidates", u32_bytes(&search.candidates)),
            gather_start: buffer(gpu, "contact gather start", u32_bytes(&search.gather_start)),
            gather: buffer(gpu, "contact gather", u32_bytes(&search.gather)),
            x_search: buffer(gpu, "x_search", f64_bytes(x)),
        }
    }
}

struct Totals {
    internal: f64,
    hourglass: f64,
    wall: f64,
    external: f64,
    contact: f64,
    impulse: Vec<f64>,
}

fn pass(
    encoder: &mut wgpu::CommandEncoder,
    pipeline: &wgpu::ComputePipeline,
    bind0: &wgpu::BindGroup,
    bind1: &wgpu::BindGroup,
    items: usize,
) {
    let mut compute = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("explicit"), timestamp_writes: None });
    compute.set_pipeline(pipeline);
    compute.set_bind_group(0, bind0, &[]);
    compute.set_bind_group(1, bind1, &[]);
    let (x, y) = dispatch_dims((items as u32).div_ceil(WORKGROUP).max(1));
    compute.dispatch_workgroups(x, y, 1);
}

/// Imposed motions: per dof the motion index + 1 (0 = free), and per motion [kind, first point, point count] then the curve points.
fn imposed_tables(model: &Model, nodes: usize) -> (Vec<u32>, Vec<f64>) {
    let mut codes = vec![0u32; 3 * nodes];
    let mut data: Vec<f64> = Vec::new();
    let header = 3 * model.imposed.len();
    let mut points: Vec<f64> = Vec::new();
    for (index, motion) in model.imposed.iter().enumerate() {
        let kind = match motion.kind {
            crate::model::ImposedKind::Velocity => 0.0,
            crate::model::ImposedKind::Displacement => 1.0,
        };
        data.extend_from_slice(&[kind, (header + points.len()) as f64, motion.curve.len() as f64]);
        points.extend(motion.curve.iter().flatten());
        for &node in &motion.nodes {
            codes[3 * node + motion.dof] = index as u32 + 1;
        }
    }
    data.extend(points);
    (codes, data)
}

/// Material table: 26 f64 per material (layout in explicit.wgsl), and the c_p tables it points into.
fn material_table(model: &Model) -> (Vec<f64>, Vec<f64>) {
    let mut cp_table = Vec::new();
    let rows: Vec<f64> = model
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
            row.extend_from_slice(&[j.melt_k, j.transition_k]);
            match &material.heating {
                Some(heat) => {
                    let start = (cp_table.len() / 2) as f64;
                    cp_table.extend(heat.specific_heat_table.iter().flatten());
                    let count = heat.specific_heat_table.len() as f64;
                    row.extend_from_slice(&[1.0, heat.taylor_quinney, heat.specific_heat, start, count]);
                }
                None => row.extend_from_slice(&[0.0, 0.0, 1.0, 0.0, 0.0]),
            }
            row
        })
        .collect();
    (rows, cp_table)
}

/// Integrates `model` on the GPU. `Err` when no adapter with SHADER_F64 exists (the caller runs the CPU twin) or a GPU call fails.
pub fn run(model: &Model, progress: &mut impl FnMut(Progress)) -> Result<(Outcome, String), String> {
    let gpu = acquire_with("llull-explicit", wgpu::Features::SHADER_F64)?;
    let controls = &model.controls;
    let x0 = model.coordinates.clone();
    let (elements, mut initial_mass, added_mass) = elements_of(model, &x0)?;
    let mut masses = nodal_masses(model, &elements);
    let mut shells = Shells::new(model, &x0, &mut masses).map(|(set, mass)| {
        initial_mass += mass;
        set
    });
    let volumes: Vec<f64> = elements.iter().map(|element| kinematics(&element.nodes, &x0).1).collect();
    let contacts = Contacts::new(model, &x0, &volumes);
    if masses.iter().any(|&mass| !(mass > 0.0)) {
        return Err("a node belongs to no element (zero mass)".to_string());
    }
    let nodes = model.node_count();
    let count = elements.len();
    let shell_count = shells.as_ref().map_or(0, |set| set.corners.len());
    let slots = count + shell_count;
    let walls_count = model.walls.len();
    // Element tables and the node -> (element, local node) incidence in element order; the shells follow the solids (slot count + s).
    let mut elem_nodes = vec![0u32; 8 * slots];
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
    if let Some(set) = &shells {
        for (s, corners) in set.corners.iter().enumerate() {
            for (k, &node) in corners.iter().enumerate() {
                elem_nodes[8 * (count + s) + k] = node as u32;
                incidence_lists[node].push((8 * (count + s) + k) as u32);
            }
        }
    }
    let mut incidence_start = vec![0u32; nodes + 1];
    let mut incidence = Vec::new();
    for (node, list) in incidence_lists.iter().enumerate() {
        incidence.extend_from_slice(list);
        incidence_start[node + 1] = incidence.len() as u32;
    }
    // State: stress (6), plastic strain, damage, failed, temperature.
    let initial_state: Vec<f64> = elements
        .iter()
        .flat_map(|element| {
            let mut row = [0.0; 10];
            row[9] = model.initial_temperature_of(element.material);
            row
        })
        .collect();
    let walls: Vec<f64> = model.walls.iter().flat_map(|wall| [wall.point, wall.normal].concat()).collect();
    let g = model.gravity;
    let scalars_init = [0.0, 0.0, controls.hourglass_coefficient, controls.bulk_linear, controls.bulk_quadratic, g[0], g[1], g[2], 0.0];
    let uniform = |label: &str, values: &[u32]| {
        gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: &u32_bytes(values),
            usage: wgpu::BufferUsages::UNIFORM,
        })
    };
    let counts = uniform("explicit counts", &[nodes as u32, count as u32, walls_count as u32, GROUPS_X]);
    let b = Buffers {
        scalars: buffer(&gpu, "scalars", f64_bytes(&scalars_init)),
        x: buffer(&gpu, "x", f64_bytes(&x0)),
        x_new: buffer(&gpu, "x_new", f64_bytes(&vec![0.0; 3 * nodes])),
        v_half: buffer(&gpu, "v_half", f64_bytes(&model.initial_velocity)),
        v_new: buffer(&gpu, "v_new", f64_bytes(&vec![0.0; 3 * nodes])),
        f_int: buffer(&gpu, "f_int", f64_bytes(&vec![0.0; 3 * nodes])),
        wall_impulse: buffer(&gpu, "wall_impulse", f64_bytes(&vec![0.0; walls_count * nodes])),
        node_energy: buffer(&gpu, "node_energy", f64_bytes(&vec![0.0; 2 * nodes])),
        state: buffer(&gpu, "state", f64_bytes(&initial_state)),
        elem_energy: buffer(&gpu, "elem_energy", f64_bytes(&vec![0.0; 3 * slots])),
        reduced: buffer(&gpu, "reduced", f64_bytes(&[0.0, 0.0])),
        contact_energy: buffer(&gpu, "contact_energy", f64_bytes(&vec![0.0; nodes])),
    };
    let (material_rows, cp_rows) = material_table(model);
    let fixed_mask: Vec<u32> = (0..3 * nodes).map(|k| u32::from(model.fixed.get(k).copied().unwrap_or(false))).collect();
    let (imposed_codes, motion_data) = imposed_tables(model, nodes);
    let counts_buffer = counts;
    let mass = buffer(&gpu, "mass", f64_bytes(&masses));
    let walls_buffer = buffer(&gpu, "walls", f64_bytes(&walls));
    let elem_nodes_buffer = buffer(&gpu, "elem_nodes", u32_bytes(&elem_nodes));
    let elem_info_buffer = buffer(&gpu, "elem_info", u32_bytes(&elem_info));
    let elem_mass_buffer = buffer(&gpu, "elem_mass", f64_bytes(&elem_mass));
    let materials = buffer(&gpu, "materials", f64_bytes(&material_rows));
    let elem_force = buffer(&gpu, "elem_force", f64_bytes(&vec![0.0; 24 * slots]));
    let start_buffer = buffer(&gpu, "incidence_start", u32_bytes(&incidence_start));
    let incidence_buffer = buffer(&gpu, "incidence", u32_bytes(&incidence));
    let contact_force = buffer(&gpu, "contact_force", f64_bytes(&vec![0.0; 3 * nodes]));
    let fixed_buffer = buffer(&gpu, "fixed", u32_bytes(&fixed_mask));
    let cp_table_buffer = buffer(&gpu, "cp_table", f64_bytes(&cp_rows));
    let imposed_buffer = buffer(&gpu, "imposed", u32_bytes(&imposed_codes));
    let motions_buffer = buffer(&gpu, "motions", f64_bytes(&motion_data));
    let x_ref_buffer = buffer(&gpu, "x_ref", f64_bytes(&x0));
    let resources0: [&wgpu::Buffer; 28] = [
        &counts_buffer,
        &b.scalars,
        &mass,
        &b.x,
        &b.x_new,
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
        &contact_force,
        &fixed_buffer,
        &cp_table_buffer,
        &imposed_buffer,
        &motions_buffer,
        &x_ref_buffer,
        &b.contact_energy,
    ];
    let layout0 = layout(&gpu, "explicit", 28, &READ_ONLY0);
    let layout1 = layout(&gpu, "explicit shells and contact", 25, &READ_ONLY1);
    let bind0 = bind_group(&gpu, &layout0, &resources0);

    // Group 1: shells and contact.
    let shell = shells.as_ref().map(|set| shell_tables(set, nodes));
    let inertia = shells.as_ref().map_or_else(|| vec![0.0; nodes], |set| set.inertia.clone());
    let fixed_rotation: Vec<u32> = (0..3 * nodes).map(|k| u32::from(model.fixed_rotation.get(k).copied().unwrap_or(false))).collect();
    let tables = contacts.as_ref().map(|set| set.gpu_tables());
    // Candidate search margin: a pair within reach now was within reach + 2δ at the last search while no node moved more than δ.
    let delta = tables.as_ref().map_or(0.0, |t| 0.25 * t.reach);
    let search = |x: &[f64]| match (&contacts, &tables) {
        (Some(set), Some(t)) => contact_search(set, &t.slaves, &t.segment_nodes, x, 2.0 * delta),
        _ => ContactSearch { slaves: vec![], candidates: vec![], gather_start: vec![0; nodes + 1], gather: vec![] },
    };
    let slave_count = tables.as_ref().map_or(0, |t| t.slaves.len());
    let points = model.shell_points as u32;
    let shell_counts = uniform(
        "explicit shell counts",
        &[shell_count as u32, points, u32::from(model.shell_warping), count as u32, slave_count as u32, 0, 0, 0],
    );
    let fixed1: [wgpu::Buffer; 18] = [
        shell_counts,
        buffer(&gpu, "shell_nodes", u32_bytes(shell.as_ref().map_or(&[][..], |t| &t.nodes))),
        buffer(&gpu, "shell_info", f64_bytes(shell.as_ref().map_or(&[][..], |t| &t.info))),
        buffer(&gpu, "shell_state", f64_bytes(shell.as_ref().map_or(&[][..], |t| &t.state))),
        buffer(&gpu, "omega", f64_bytes(&vec![0.0; 3 * nodes])),
        buffer(&gpu, "omega_prev", f64_bytes(&vec![0.0; 3 * nodes])),
        buffer(&gpu, "inertia", f64_bytes(&inertia)),
        buffer(&gpu, "fixed_rotation", u32_bytes(&fixed_rotation)),
        buffer(&gpu, "shell_moment", f64_bytes(&vec![0.0; 12 * shell_count])),
        buffer(&gpu, "moments", f64_bytes(&vec![0.0; 3 * nodes])),
        buffer(&gpu, "shell_normal", f64_bytes(&vec![0.0; 3 * shell_count])),
        buffer(&gpu, "normals", f64_bytes(&vec![0.0; 3 * nodes])),
        buffer(&gpu, "shell_start", u32_bytes(shell.as_ref().map_or(&vec![0; nodes + 1][..], |t| &t.start))),
        buffer(&gpu, "shell_incidence", u32_bytes(shell.as_ref().map_or(&[][..], |t| &t.incidence))),
        buffer(&gpu, "seg_nodes", u32_bytes(tables.as_ref().map_or(&[][..], |t| &t.segment_nodes))),
        buffer(&gpu, "seg_data", f64_bytes(tables.as_ref().map_or(&[][..], |t| &t.segment_data))),
        buffer(&gpu, "slave_data", f64_bytes(tables.as_ref().map_or(&[][..], |t| &t.slave_data))),
        buffer(&gpu, "pass_data", f64_bytes(tables.as_ref().map_or(&[][..], |t| &t.pass_data))),
    ];
    let slave_state_init: Vec<f64> = (0..slave_count).flat_map(|_| [-1.0, 0.0, 0.0, 0.0, 0.0, 0.0]).collect();
    let slave_state = buffer(&gpu, "slave_state", f64_bytes(&slave_state_init));
    let slave_out = buffer(&gpu, "slave_out", f64_bytes(&vec![0.0; 8 * slave_count]));
    let mut searched = SearchBuffers::new(&gpu, &search(&x0), &x0);
    let bind1 = |searched: &SearchBuffers| {
        let [shell_counts, shell_nodes, shell_info, shell_state, omega, omega_prev, inertia, fixed_rotation, shell_moment, moments, shell_normal, normals, shell_start, shell_incidence, seg_nodes, seg_data, slave_data, pass_data] =
            &fixed1;
        let resources: [&wgpu::Buffer; 25] = [
            shell_counts,
            shell_nodes,
            shell_info,
            shell_state,
            omega,
            omega_prev,
            inertia,
            fixed_rotation,
            shell_moment,
            moments,
            shell_normal,
            normals,
            shell_start,
            shell_incidence,
            seg_nodes,
            seg_data,
            &searched.slaves,
            slave_data,
            pass_data,
            &searched.candidates,
            &slave_state,
            &slave_out,
            &searched.gather_start,
            &searched.gather,
            &searched.x_search,
        ];
        bind_group(&gpu, &layout1, &resources)
    };
    let mut group1 = bind1(&searched);
    let module = gpu
        .device
        .create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("explicit"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
    let kernel = |entry: &str| pipeline(&gpu, &module, entry, &[&layout0, &layout1]);
    let kernels = Kernels {
        contact_slave: kernel("contact_slave"),
        contact_gather: kernel("contact_gather"),
        kick: kernel("kick"),
        shell_kick: kernel("shell_kick"),
        element: kernel("element"),
        shell_normals: kernel("shell_normals"),
        node_normals: kernel("node_normals"),
        shell_step: kernel("shell_step"),
        gather: kernel("gather"),
        moment_gather: kernel("moment_gather"),
        min_step: kernel("min_step"),
        commit: kernel("commit"),
    };

    let mut element_dt = f64::INFINITY;
    for element in &elements {
        let (gradients, volume) = kinematics(&element.nodes, &x0);
        element_dt = element_dt.min(eigen_step(&gradients, volume, &element.node_masses, &model.materials[element.material]));
    }
    if let Some(set) = &shells {
        element_dt = element_dt.min(set.initial_step(model, &x0));
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
    let totals = |gpu: &Gpu, b: &Buffers| -> Result<Totals, String> {
        let elem_energy = read_f64(gpu, &b.elem_energy, 3 * slots)?;
        let node_energy = read_f64(gpu, &b.node_energy, 2 * nodes)?;
        let impulse = read_f64(gpu, &b.wall_impulse, walls_count * nodes)?;
        let contact = read_f64(gpu, &b.contact_energy, nodes)?;
        Ok(Totals {
            internal: (0..slots).map(|e| elem_energy[3 * e]).sum::<f64>(),
            hourglass: (0..slots).map(|e| elem_energy[3 * e + 1]).sum::<f64>(),
            wall: (0..nodes).map(|n| node_energy[2 * n]).sum::<f64>(),
            external: (0..nodes).map(|n| node_energy[2 * n + 1]).sum::<f64>(),
            contact: contact.iter().sum::<f64>(),
            impulse: (0..walls_count).map(|w| impulse[w * nodes..(w + 1) * nodes].iter().sum::<f64>()).collect(),
        })
    };
    let [_, _, _, _, omega_buffer, omega_prev_buffer, ..] = &fixed1;
    let inertia_of = |omega: &[f64], previous: &[f64]| -> f64 {
        (0..3 * nodes).map(|k| 0.5 * inertia[k / 3] * (0.5 * (previous[k] + omega[k])).powi(2)).sum::<f64>()
    };
    let warping = model.shell_warping && shell_count > 0;
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
        gpu.queue.write_buffer(&b.scalars, 64, &f64_bytes(&[time]));
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        if slave_count > 0 {
            pass(&mut encoder, &kernels.contact_slave, &bind0, &group1, slave_count);
            pass(&mut encoder, &kernels.contact_gather, &bind0, &group1, nodes);
        }
        pass(&mut encoder, &kernels.kick, &bind0, &group1, nodes);
        if shell_count > 0 {
            pass(&mut encoder, &kernels.shell_kick, &bind0, &group1, nodes);
        }
        gpu.queue.submit([encoder.finish()]);
        if cycles > 0 && time >= next_sample * (1.0 - 1e-12) {
            let v_half = read_f64(&gpu, &b.v_half, 3 * nodes)?;
            let v_new = read_f64(&gpu, &b.v_new, 3 * nodes)?;
            let rotation = if shell_count > 0 {
                inertia_of(&read_f64(&gpu, omega_buffer, 3 * nodes)?, &read_f64(&gpu, omega_prev_buffer, 3 * nodes)?)
            } else {
                0.0
            };
            let kinetic: f64 = rotation + (0..3 * nodes).map(|k| 0.5 * masses[k / 3] * (0.5 * (v_half[k] + v_new[k])).powi(2)).sum::<f64>();
            let mut sums = totals(&gpu, &b)?;
            if !sums.internal.is_finite() {
                normal = false;
                message = format!("the solution became non-finite at t = {time:e} s");
                break;
            }
            energy.push(EnergyRow {
                time,
                kinetic,
                internal: sums.internal,
                hourglass: sums.hourglass,
                wall: sums.wall,
                contact: sums.contact,
                external_work: sums.external,
            });
            sample_walls(&mut walls_history, &mut sums.impulse, time, last_sample);
            gpu.queue.write_buffer(&b.wall_impulse, 0, &f64_bytes(&vec![0.0; walls_count * nodes]));
            last_sample = time;
            next_sample = (((time / controls.history_interval) + 1e-9).floor() + 1.0) * controls.history_interval;
        }
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        pass(&mut encoder, &kernels.element, &bind0, &group1, count);
        if shell_count > 0 {
            if warping {
                pass(&mut encoder, &kernels.shell_normals, &bind0, &group1, shell_count);
                pass(&mut encoder, &kernels.node_normals, &bind0, &group1, nodes);
            }
            pass(&mut encoder, &kernels.shell_step, &bind0, &group1, shell_count);
        }
        pass(&mut encoder, &kernels.gather, &bind0, &group1, nodes);
        if shell_count > 0 {
            pass(&mut encoder, &kernels.moment_gather, &bind0, &group1, nodes);
        }
        {
            let mut compute = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("min_step"), timestamp_writes: None });
            compute.set_pipeline(&kernels.min_step);
            compute.set_bind_group(0, &bind0, &[]);
            compute.set_bind_group(1, &group1, &[]);
            compute.dispatch_workgroups(1, 1, 1);
        }
        pass(&mut encoder, &kernels.commit, &bind0, &group1, nodes);
        gpu.queue.submit([encoder.finish()]);
        let reduced = read_f64(&gpu, &b.reduced, 2)?;
        element_dt = reduced[0];
        time += dt;
        dt_prev = dt;
        cycles += 1;
        if slave_count > 0 && reduced[1] > delta {
            // A node moved more than δ since the last search: search again around the committed positions.
            let x = read_f64(&gpu, &b.x, 3 * nodes)?;
            searched = SearchBuffers::new(&gpu, &search(&x), &x);
            group1 = bind1(&searched);
        }
        if !(element_dt.is_finite() && element_dt > 0.0 && element_dt < 1e299) {
            normal = false;
            message = if element_dt >= 1e299 {
                format!("every element eroded at t = {time:e} s")
            } else {
                format!("the solution became non-finite at t = {time:e} s")
            };
            break;
        }
        progress(Progress { cycle: cycles, time, dt });
    }
    let v_half = read_f64(&gpu, &b.v_half, 3 * nodes)?;
    let f_int = read_f64(&gpu, &b.f_int, 3 * nodes)?;
    let external: Vec<f64> = (0..3 * nodes).map(|k| masses[k / 3] * g[k % 3]).collect();
    let v_end: Vec<f64> = (0..3 * nodes).map(|k| v_half[k] + 0.5 * dt_prev * (external[k] - f_int[k]) / masses[k / 3]).collect();
    let rotation = if shell_count > 0 {
        let omega = read_f64(&gpu, omega_buffer, 3 * nodes)?;
        inertia_of(&omega, &omega)
    } else {
        0.0
    };
    let kinetic: f64 = rotation + (0..3 * nodes).map(|k| 0.5 * masses[k / 3] * v_end[k] * v_end[k]).sum::<f64>();
    let mut sums = totals(&gpu, &b)?;
    energy.push(EnergyRow {
        time,
        kinetic,
        internal: sums.internal,
        hourglass: sums.hourglass,
        wall: sums.wall,
        contact: sums.contact,
        external_work: sums.external,
    });
    if time > last_sample {
        sample_walls(&mut walls_history, &mut sums.impulse, time, last_sample);
    }
    let x = read_f64(&gpu, &b.x, 3 * nodes)?;
    let state = read_f64(&gpu, &b.state, 10 * count)?;
    let mut fields = Vec::with_capacity(crate::solver::FIELD_STRIDE * slots);
    for (e, element) in elements.iter().enumerate() {
        let c = centroid(&element.nodes, &x);
        let s: [f64; 6] = std::array::from_fn(|k| state[10 * e + k]);
        fields.extend_from_slice(&[
            crate::material::von_mises(&s),
            state[10 * e + 6],
            state[10 * e + 8],
            state[10 * e + 9],
            c[0],
            c[1],
            c[2],
        ]);
    }
    if let Some(set) = shells.as_mut() {
        let [_, _, _, shell_state, ..] = &fixed1;
        let data = read_f64(&gpu, shell_state, (10 * model.shell_points + 5) * shell_count)?;
        load_shell_states(set, &data);
        fields.extend(set.fields(&x));
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
