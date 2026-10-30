//! The FieldProgram tape (TECHNICAL_SPEC 13.3): SSA instructions, constants, mesh and strut operands, parsed from a job folder.
//! `validate` is the twin of `programError` in `packages/core/src/geometry/field/program.ts` (same messages).

use crate::files::{input_error, read_f64, read_u32, JobError};
use crate::sampled::{Grid, Sampled, Tets};
use serde::Deserialize;
use std::path::Path;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Op {
    Const,
    X,
    Y,
    Z,
    Add,
    Sub,
    Mul,
    Div,
    Neg,
    Abs,
    Min,
    Max,
    Sqrt,
    Square,
    Sin,
    Cos,
    Atan2,
    Floor,
    Fract,
    Clamp,
    Select,
    SminQuad,
    SminExp,
    ChamferMin,
    MeshSdf,
    StrutSet,
    SampleField,
}

const NAMES: [(&str, Op); 27] = [
    ("const", Op::Const),
    ("x", Op::X),
    ("y", Op::Y),
    ("z", Op::Z),
    ("add", Op::Add),
    ("sub", Op::Sub),
    ("mul", Op::Mul),
    ("div", Op::Div),
    ("neg", Op::Neg),
    ("abs", Op::Abs),
    ("min", Op::Min),
    ("max", Op::Max),
    ("sqrt", Op::Sqrt),
    ("square", Op::Square),
    ("sin", Op::Sin),
    ("cos", Op::Cos),
    ("atan2", Op::Atan2),
    ("floor", Op::Floor),
    ("fract", Op::Fract),
    ("clamp", Op::Clamp),
    ("select", Op::Select),
    ("smin_quad", Op::SminQuad),
    ("smin_exp", Op::SminExp),
    ("chamfer_min", Op::ChamferMin),
    ("mesh_sdf", Op::MeshSdf),
    ("strut_set", Op::StrutSet),
    ("sample_field", Op::SampleField),
];

impl Op {
    pub fn from_name(name: &str) -> Option<Op> {
        NAMES.iter().find(|(n, _)| *n == name).map(|(_, op)| *op)
    }

    pub fn name(self) -> &'static str {
        NAMES.iter().find(|(_, op)| *op == self).map_or("?", |(n, _)| n)
    }

    /// Operand kinds: `r` register, `c` constant, `m` mesh, `s` strut set, `f` sampled field, `o` optional register (-1 = none).
    fn shape(self) -> &'static str {
        match self {
            Op::Const => "c",
            Op::X | Op::Y | Op::Z => "",
            Op::Add | Op::Sub | Op::Mul | Op::Div | Op::Min | Op::Max | Op::Atan2 => "rr",
            Op::Neg | Op::Abs | Op::Sqrt | Op::Square | Op::Sin | Op::Cos | Op::Floor | Op::Fract => "r",
            Op::Clamp | Op::Select | Op::SminQuad | Op::SminExp | Op::ChamferMin => "rrr",
            Op::MeshSdf => "rrrm",
            Op::StrutSet => "rrrso",
            Op::SampleField => "rrrf",
        }
    }
}

pub const SLOTS: usize = 5;

#[derive(Clone, Copy, Debug)]
pub struct Instr {
    pub op: Op,
    /// Operand slots; unused slots are -1.
    pub args: [i64; SLOTS],
}

#[derive(Clone, Copy, Debug)]
pub struct Beam {
    pub a: usize,
    pub b: usize,
    pub ra: f64,
    pub rb: f64,
    pub sphere: bool,
}

#[derive(Clone, Debug)]
pub struct StrutSet {
    pub periodic: Option<([f64; 3], [f64; 3])>,
    pub nodes: Vec<[f64; 3]>,
    pub beams: Vec<Beam>,
}

#[derive(Clone, Debug)]
pub struct Program {
    pub instrs: Vec<Instr>,
    pub output: usize,
    pub constants: Vec<f64>,
    /// Triangle soups, nine numbers per triangle.
    pub meshes: Vec<Vec<f64>>,
    pub struts: Vec<StrutSet>,
    pub sampled: Vec<Sampled>,
}

#[derive(Debug, Deserialize)]
pub struct InstrSpec {
    pub op: String,
    pub args: Vec<i64>,
}

#[derive(Debug, Deserialize)]
pub struct PeriodicSpec {
    pub cell: [f64; 3],
    pub origin: [f64; 3],
}

#[derive(Debug, Deserialize)]
pub struct StrutSpec {
    pub periodic: Option<PeriodicSpec>,
    pub nodes: usize,
    pub beams: usize,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SampledSpec {
    Grid { nodes: [usize; 3], origin: [f64; 3], voxel: f64 },
    Tets { points: usize, tets: usize },
}

/// The JSON part of a program; the numbers of constants, meshes and struts are in files named `<prefix>constants.f64`, `<prefix>mesh<i>_positions.f64` /
/// `_indices.u32`, `<prefix>strut<i>_nodes.f64` (3 per node), `<prefix>strut<i>_beams.f64` (a, b, ra, rb, cap 1 = sphere, 5 per beam), `<prefix>sampled<i>_values.f64` (+ `_points.f64`, `_tets.u32` for tetrahedra).
#[derive(Debug, Deserialize)]
pub struct ProgramSpec {
    pub instructions: Vec<InstrSpec>,
    pub output: i64,
    pub meshes: usize,
    #[serde(rename = "strutSets")]
    pub strut_sets: Vec<StrutSpec>,
    #[serde(default)]
    pub sampled: Vec<SampledSpec>,
}

fn triangle_soup(positions: &[f64], indices: &[u32]) -> Vec<f64> {
    let corner = |vertex: u32, axis: usize| positions.get(vertex as usize * 3 + axis).copied().unwrap_or(0.0);
    let mut out = Vec::with_capacity(indices.len() / 3 * 9);
    for triangle in indices.chunks_exact(3) {
        for &vertex in triangle {
            out.extend([corner(vertex, 0), corner(vertex, 1), corner(vertex, 2)]);
        }
    }
    out
}

fn load_sampled(folder: &Path, prefix: &str, index: usize, spec: &SampledSpec) -> Result<Sampled, JobError> {
    let values = read_f64(folder, &format!("{prefix}sampled{index}_values.f64"))?;
    match spec {
        SampledSpec::Grid { nodes, origin, voxel } => {
            if values.len() != nodes[0] * nodes[1] * nodes[2] || nodes.contains(&0) {
                return Err(input_error(format!("sampled field {index}: {} values for grid {nodes:?}", values.len())));
            }
            Ok(Sampled::Grid(Grid::new(*nodes, *origin, *voxel, values)))
        }
        SampledSpec::Tets { points, tets } => {
            let coordinates = read_f64(folder, &format!("{prefix}sampled{index}_points.f64"))?;
            let corners = read_u32(folder, &format!("{prefix}sampled{index}_tets.u32"))?;
            if coordinates.len() != points * 3 || corners.len() != tets * 4 || values.len() != *points || *points == 0 {
                return Err(input_error(format!("sampled field {index}: file sizes do not match {points} nodes / {tets} tetrahedra")));
            }
            if corners.iter().any(|&n| n as usize >= *points) {
                return Err(input_error(format!("sampled field {index}: a tetrahedron names a node out of range")));
            }
            Ok(Sampled::Tets(Tets::new(coordinates, corners.iter().map(|&n| n as usize).collect(), values)))
        }
    }
}

fn load_struts(folder: &Path, prefix: &str, index: usize, spec: &StrutSpec) -> Result<StrutSet, JobError> {
    let nodes = read_f64(folder, &format!("{prefix}strut{index}_nodes.f64"))?;
    let beams = read_f64(folder, &format!("{prefix}strut{index}_beams.f64"))?;
    if nodes.len() != spec.nodes * 3 || beams.len() != spec.beams * 5 {
        return Err(input_error(format!("strut set {index}: file sizes do not match {} nodes / {} beams", spec.nodes, spec.beams)));
    }
    let count = |value: f64| if value.is_finite() && value >= 0.0 && value.fract() == 0.0 { value as usize } else { usize::MAX };
    Ok(StrutSet {
        periodic: spec.periodic.as_ref().map(|p| (p.cell, p.origin)),
        nodes: nodes.chunks_exact(3).map(|n| [n[0], n[1], n[2]]).collect(),
        beams: beams.chunks_exact(5).map(|b| Beam { a: count(b[0]), b: count(b[1]), ra: b[2], rb: b[3], sphere: b[4] != 0.0 }).collect(),
    })
}

impl Program {
    pub fn load(folder: &Path, prefix: &str, spec: &ProgramSpec) -> Result<Program, JobError> {
        let mut instrs = Vec::with_capacity(spec.instructions.len());
        for (index, entry) in spec.instructions.iter().enumerate() {
            let op = Op::from_name(&entry.op).ok_or_else(|| input_error(format!("instruction {index}: unknown op {}", entry.op)))?;
            if entry.args.len() > SLOTS {
                return Err(input_error(format!("instruction {index} ({}): {} operands", entry.op, entry.args.len())));
            }
            let mut args = [-1; SLOTS];
            args[..entry.args.len()].copy_from_slice(&entry.args);
            if entry.args.len() != op.shape().len() {
                return Err(input_error(format!(
                    "instruction {index} ({}): expected {} operands, got {}",
                    entry.op,
                    op.shape().len(),
                    entry.args.len()
                )));
            }
            instrs.push(Instr { op, args });
        }
        let constants = read_f64(folder, &format!("{prefix}constants.f64"))?;
        let mut meshes = Vec::with_capacity(spec.meshes);
        for index in 0..spec.meshes {
            let positions = read_f64(folder, &format!("{prefix}mesh{index}_positions.f64"))?;
            let indices = read_u32(folder, &format!("{prefix}mesh{index}_indices.u32"))?;
            meshes.push(triangle_soup(&positions, &indices));
        }
        let struts =
            spec.strut_sets.iter().enumerate().map(|(index, entry)| load_struts(folder, prefix, index, entry)).collect::<Result<_, _>>()?;
        let sampled =
            spec.sampled.iter().enumerate().map(|(index, entry)| load_sampled(folder, prefix, index, entry)).collect::<Result<_, _>>()?;
        let output = usize::try_from(spec.output).unwrap_or(usize::MAX);
        Ok(Program { instrs, output, constants, meshes, struts, sampled })
    }

    /// Why the tape is malformed (the text of `programError`), or None.
    pub fn validate(&self) -> Option<String> {
        let count = self.instrs.len();
        if self.output >= count {
            return Some("output register out of range".to_string());
        }
        for (index, instr) in self.instrs.iter().enumerate() {
            for (slot, kind) in instr.op.shape().chars().enumerate() {
                let value = instr.args[slot];
                let (limit, lowest) = match kind {
                    'r' => (index, 0),
                    'o' => (index, -1),
                    'c' => (self.constants.len(), 0),
                    'm' => (self.meshes.len(), 0),
                    'f' => (self.sampled.len(), 0),
                    _ => (self.struts.len(), 0),
                };
                if value < lowest || value >= limit as i64 {
                    return Some(format!("instruction {index} ({}): operand {slot} = {value} out of range", instr.op.name()));
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::{f64_bytes, write_file};

    fn program(ops: &[(&str, &[i64])], constants: usize, tag: &str) -> Program {
        let spec = ProgramSpec {
            instructions: ops.iter().map(|(op, args)| InstrSpec { op: (*op).to_string(), args: args.to_vec() }).collect(),
            output: 0,
            meshes: 0,
            strut_sets: vec![],
            sampled: vec![],
        };
        let dir = std::env::temp_dir().join(format!("llull-field-tape-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_file(&dir, "constants.f64", &f64_bytes(&vec![1.0; constants])).unwrap();
        let loaded = Program::load(&dir, "", &spec);
        std::fs::remove_dir_all(&dir).unwrap();
        loaded.unwrap()
    }

    #[test]
    fn accepts_a_well_formed_tape_and_names_every_defect() {
        let mut ok = program(&[("const", &[0]), ("x", &[]), ("add", &[0, 1])], 1, "ok");
        ok.output = 2;
        assert_eq!(ok.validate(), None);
        ok.output = 3;
        assert_eq!(ok.validate().as_deref(), Some("output register out of range"));
        let forward = program(&[("const", &[0]), ("add", &[0, 1])], 1, "forward");
        assert!(forward.validate().unwrap().contains("operand 1 = 1 out of range"));
        let constant = program(&[("const", &[4])], 1, "const");
        assert!(constant.validate().unwrap().contains("operand 0 = 4"));
        let no_set = program(&[("const", &[0]), ("strut_set", &[0, 0, 0, 0, -1])], 1, "set");
        assert!(no_set.validate().unwrap().contains("operand 3 = 0 out of range"), "no strut set exists");
        let bad_optional = program(&[("const", &[0]), ("strut_set", &[0, 0, 0, 0, -2])], 1, "opt");
        assert!(bad_optional.validate().unwrap().contains("operand 3"));
    }

    #[test]
    fn rejects_unknown_ops_and_wrong_operand_counts() {
        let spec = ProgramSpec {
            instructions: vec![InstrSpec { op: "wobble".into(), args: vec![] }],
            output: 0,
            meshes: 0,
            strut_sets: vec![],
            sampled: vec![],
        };
        assert!(Program::load(Path::new("."), "", &spec).unwrap_err().message.contains("unknown op wobble"));
        let spec = ProgramSpec {
            instructions: vec![InstrSpec { op: "x".into(), args: vec![0; 6] }],
            output: 0,
            meshes: 0,
            strut_sets: vec![],
            sampled: vec![],
        };
        assert!(Program::load(Path::new("."), "", &spec).unwrap_err().message.contains("6 operands"));
        let spec = ProgramSpec {
            instructions: vec![InstrSpec { op: "add".into(), args: vec![0] }],
            output: 0,
            meshes: 0,
            strut_sets: vec![],
            sampled: vec![],
        };
        assert!(Program::load(Path::new("."), "", &spec).unwrap_err().message.contains("expected 2 operands"));
    }
}
