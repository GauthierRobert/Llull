//! The serde shapes of the `flow` job: `case.json` in ([`JobFile`]) and `result.json` out ([`ResultFile`]). Field names are the
//! camelCase the TypeScript side writes and reads (`packages/domain-aero/src/cfd/{flowJob,flowResult}.ts`).

use crate::outputs::{Coefficients, HistoryEntry, Peak, Probe, WarningEntry};
use crate::units::DEFAULT_LATTICE_MACH;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridSpec {
    pub cell_m: f64,
    pub min_m: [f64; 3],
    pub max_m: [f64; 3],
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowSpec {
    #[serde(rename = "speedMS")]
    pub speed_ms: f64,
    pub direction: [f64; 3],
    pub density_kg_m3: f64,
    pub viscosity_pa_s: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceSpec {
    pub area_m2: f64,
    pub length_m: f64,
    pub moment_point_m: [f64; 3],
    #[serde(default = "up_z")]
    pub up: [f64; 3],
}

fn up_z() -> [f64; 3] {
    [0.0, 0.0, 1.0]
}

/// What a domain face is. `symmetry` is a free-slip plane the body may touch: the half model is mirrored (forces doubled).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FaceKind {
    #[default]
    FarField,
    Slip,
    Symmetry,
    Ground,
    MovingGround,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct FacesSpec {
    pub x_min: FaceKind,
    pub x_max: FaceKind,
    pub y_min: FaceKind,
    pub y_max: FaceKind,
    pub z_min: FaceKind,
    pub z_max: FaceKind,
}

impl FacesSpec {
    /// `(axis, high, kind)` of the six faces.
    pub fn faces(&self) -> [(usize, bool, FaceKind); 6] {
        [
            (0, false, self.x_min),
            (0, true, self.x_max),
            (1, false, self.y_min),
            (1, true, self.y_max),
            (2, false, self.z_min),
            (2, true, self.z_max),
        ]
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BodySpec {
    pub entity_id: String,
    /// `[start, count]` into the STL triangles.
    pub triangles: [usize; 2],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceName {
    #[default]
    Cpu,
    Gpu,
    Auto,
}

/// Largest CPU grid by default (≈ 8 GB of the f64 twin's 395 B / cell).
pub const DEFAULT_CELL_CAP: usize = 20_000_000;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct SettingsSpec {
    pub lattice_mach: f64,
    pub les: bool,
    pub smagorinsky: f64,
    pub max_steps: u64,
    pub start_averaging_tol: f64,
    pub stop_tol: f64,
    /// 0 = one fiftieth of a flow-through.
    pub sample_every: u64,
    pub history_cap: usize,
    pub device: DeviceName,
    pub cell_cap: usize,
}

impl Default for SettingsSpec {
    fn default() -> SettingsSpec {
        SettingsSpec {
            lattice_mach: DEFAULT_LATTICE_MACH,
            les: true,
            smagorinsky: 0.1,
            max_steps: 200_000,
            start_averaging_tol: 0.005,
            stop_tol: 0.001,
            sample_every: 0,
            history_cap: 1000,
            device: DeviceName::Cpu,
            cell_cap: DEFAULT_CELL_CAP,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SliceField {
    Speed,
    P,
    Ux,
    Uy,
    Uz,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SliceSpec {
    pub origin_m: [f64; 3],
    pub normal: [f64; 3],
    pub field: SliceField,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct OutputsSpec {
    pub probes_m: Vec<[f64; 3]>,
    pub slices: Vec<SliceSpec>,
    pub surface_fields: Vec<String>,
}

/// The whole `case.json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobFile {
    pub version: u32,
    pub case_id: String,
    pub grid: GridSpec,
    pub flow: FlowSpec,
    pub reference: ReferenceSpec,
    #[serde(default)]
    pub faces: FacesSpec,
    #[serde(default)]
    pub bodies: Vec<BodySpec>,
    #[serde(default = "default_surface")]
    pub surface: String,
    #[serde(default)]
    pub settings: SettingsSpec,
    #[serde(default)]
    pub outputs: OutputsSpec,
}

fn default_surface() -> String {
    "surface.stl".to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridInfo {
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
    pub cell_m: f64,
    pub cells: usize,
    pub fluid_cells: usize,
    pub solid_cells: usize,
    pub odd_rows: usize,
    pub origin_m: [f64; 3],
}

/// Bytes per cell of the lattice layouts, so the host's memory estimate can be tied to the real buffers.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    /// The layout this run used.
    pub bytes_per_cell: usize,
    pub gpu_bytes_per_cell: usize,
    pub cpu_bytes_per_cell: usize,
    pub bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatticeInfo {
    pub tau: f64,
    pub u_lattice: f64,
    pub nu_lattice: f64,
    pub dt_s: f64,
    pub flow_through_steps: u64,
    pub sample_every: u64,
    pub les: bool,
    pub smagorinsky: f64,
    pub reynolds: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyForce {
    pub entity_id: String,
    pub force_n: [f64; 3],
}

/// `result.json`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultFile {
    pub version: u32,
    pub case_id: String,
    pub solver: &'static str,
    pub status: &'static str,
    pub converged: bool,
    pub steps: u64,
    pub averaged_steps: u64,
    pub samples: u32,
    pub time_s: f64,
    pub elapsed_s: f64,
    pub device: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    pub deterministic: bool,
    pub precision: &'static str,
    /// True when a symmetry face halved the model: forces and moments are those of the whole body (doubled, antisymmetric parts zero).
    pub half_model: bool,
    pub grid: GridInfo,
    pub memory: MemoryInfo,
    pub lattice: LatticeInfo,
    pub forces: Coefficients,
    pub per_body: Vec<BodyForce>,
    pub peaks: Vec<Peak>,
    pub probes: Vec<Probe>,
    pub history: Vec<HistoryEntry>,
    pub settings: SettingsSpec,
    pub surface: String,
    pub slices: Vec<String>,
    pub not_modelled: Vec<&'static str>,
    pub warnings: Vec<WarningEntry>,
}
