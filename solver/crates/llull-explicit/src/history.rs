//! Requested time histories (PHY-19 `add_time_history`): node, part and rigid-wall series recorded during the run.
//!
//! Sampling rule: the series of a request are sampled at the exact integer multiples `k · interval` of its interval (`k = 0, 1, …` up to the
//! end time; the interval defaults to the controls' history interval). The solver's states exist at its own steps `t^n`; the value at
//! `k · interval` is the LINEAR INTERPOLATION between the two integer-step states that bracket it (no extrapolation, no nearest-step snap), so
//! a quantity that is linear in time between steps (a constant-velocity displacement) is reproduced exactly. The integer-step state at `t^n`
//! uses `x^n`, `v^n = ½(v^{n−½} + v^{n+½})` (`v^0` = the initial velocity at t = 0), `a^n = (v^{n+½} − v^{n−½}) / (½(Δt^{n−½} + Δt^{n+½}))`.
//!
//! Quantities (analysis units; vectors have 3 components, scalars 1):
//! - node set: `displacement` (from the initial position), `velocity`, `acceleration`: the UNWEIGHTED MEAN over the set's nodes.
//! - part (solid elements): `kinetic_energy` and `momentum` over the element-owned lumped masses (an exact partition of the model mass),
//!   `internal_energy` (stress work of the part's elements; hourglass energy not included), `mass` (after mass scaling).
//! - rigid wall: `normal_impulse` (cumulative momentum the model gave the wall, ≥ 0), `normal_force` (the impulse gained since the previous
//!   sample / the sample spacing; 0 at t = 0, whose impulse already holds the first step's), `energy` (cumulative stonewall energy of this wall).

use crate::model::Model;
use crate::solver::Element;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quantity {
    Displacement,
    Velocity,
    Acceleration,
    InternalEnergy,
    KineticEnergy,
    Momentum,
    Mass,
    NormalForce,
    NormalImpulse,
    Energy,
}

impl Quantity {
    pub fn components(self) -> usize {
        match self {
            Quantity::Displacement | Quantity::Velocity | Quantity::Acceleration | Quantity::Momentum => 3,
            _ => 1,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Quantity::Displacement => "displacement",
            Quantity::Velocity => "velocity",
            Quantity::Acceleration => "acceleration",
            Quantity::InternalEnergy => "internal_energy",
            Quantity::KineticEnergy => "kinetic_energy",
            Quantity::Momentum => "momentum",
            Quantity::Mass => "mass",
            Quantity::NormalForce => "normal_force",
            Quantity::NormalImpulse => "normal_impulse",
            Quantity::Energy => "energy",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Nodes(Vec<usize>),
    /// Part index (the `elementPart` value); solid (hex8 / tet4) elements only.
    Part(u32),
    /// Index into the model's walls.
    Wall(usize),
}

impl Target {
    pub fn allows(&self, quantity: Quantity) -> bool {
        match self {
            Target::Nodes(_) => matches!(quantity, Quantity::Displacement | Quantity::Velocity | Quantity::Acceleration),
            Target::Part(_) => matches!(quantity, Quantity::InternalEnergy | Quantity::KineticEnergy | Quantity::Momentum | Quantity::Mass),
            Target::Wall(_) => matches!(quantity, Quantity::NormalForce | Quantity::NormalImpulse | Quantity::Energy),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub name: String,
    pub target: Target,
    pub quantities: Vec<Quantity>,
    /// Seconds; None = the controls' history interval.
    pub interval: Option<f64>,
}

/// One recorded series: `values` holds `components` numbers per entry of `times`.
#[derive(Debug, Clone, PartialEq)]
pub struct Series {
    pub name: String,
    pub quantity: Quantity,
    pub components: usize,
    pub times: Vec<f64>,
    pub values: Vec<f64>,
}

/// The integer-step state at one time.
pub(crate) struct Snapshot<'a> {
    pub time: f64,
    pub x: &'a [f64],
    /// Velocity v^n and acceleration a^n, 3 per node.
    pub v: &'a [f64],
    pub a: &'a [f64],
    /// Per wall: cumulative [impulse, energy].
    pub walls: &'a [[f64; 2]],
}

struct Track {
    series: Series,
    request: usize,
    interval: f64,
    next_k: u64,
    previous: Option<(f64, Vec<f64>)>,
}

pub(crate) struct Recorder<'a> {
    model: &'a Model,
    elements: &'a [Element],
    part_of: Vec<u32>,
    part_internal: Vec<f64>,
    tracks: Vec<Track>,
}

/// Tolerance of "this multiple of the interval has been reached".
const REACHED: f64 = 1e-12;

impl<'a> Recorder<'a> {
    /// None when the model requests no history.
    pub fn new(model: &'a Model, elements: &'a [Element]) -> Option<Recorder<'a>> {
        if model.histories.is_empty() {
            return None;
        }
        let part_of: Vec<u32> = (0..elements.len()).map(|k| model.element_part.get(k).copied().unwrap_or(0)).collect();
        let parts = part_of.iter().max().map_or(0, |&top| top as usize + 1);
        let tracks = model
            .histories
            .iter()
            .enumerate()
            .flat_map(|(request, spec)| {
                spec.quantities.iter().map(move |&quantity| Track {
                    series: Series { name: spec.name.clone(), quantity, components: quantity.components(), times: vec![], values: vec![] },
                    request,
                    interval: spec.interval.unwrap_or(model.controls.history_interval),
                    next_k: 0,
                    previous: None,
                })
            })
            .collect();
        Some(Recorder { model, elements, part_of, part_internal: vec![0.0; parts], tracks })
    }

    /// Stress work of element `index` over the step just taken.
    pub fn add_internal(&mut self, index: usize, work: f64) {
        if let Some(&part) = self.part_of.get(index) {
            self.part_internal[part as usize] += work;
        }
    }

    fn values(&self, request: usize, quantity: Quantity, snapshot: &Snapshot<'_>) -> Vec<f64> {
        let target = &self.model.histories[request].target;
        match target {
            Target::Nodes(nodes) => {
                let count = nodes.len().max(1) as f64;
                let mean = |component: usize, field: &dyn Fn(usize) -> f64| {
                    nodes.iter().map(|&node| field(3 * node + component)).sum::<f64>() / count
                };
                (0..3)
                    .map(|i| match quantity {
                        Quantity::Displacement => mean(i, &|k| snapshot.x[k] - self.model.coordinates[k]),
                        Quantity::Velocity => mean(i, &|k| snapshot.v[k]),
                        _ => mean(i, &|k| snapshot.a[k]),
                    })
                    .collect()
            }
            Target::Part(part) => {
                let members = self.elements.iter().zip(&self.part_of).filter(|(_, &of)| of == *part).map(|(element, _)| element);
                match quantity {
                    Quantity::Mass => vec![members.map(|element| element.mass).sum()],
                    Quantity::InternalEnergy => vec![self.part_internal[*part as usize]],
                    Quantity::KineticEnergy => vec![members
                        .map(|element| {
                            element
                                .nodes
                                .iter()
                                .zip(&element.node_masses)
                                .map(|(&node, &mass)| 0.5 * mass * (0..3).map(|i| snapshot.v[3 * node + i].powi(2)).sum::<f64>())
                                .sum::<f64>()
                        })
                        .sum()],
                    _ => {
                        let mut momentum = [0.0; 3];
                        for element in members {
                            for (&node, &mass) in element.nodes.iter().zip(&element.node_masses) {
                                for (i, total) in momentum.iter_mut().enumerate() {
                                    *total += mass * snapshot.v[3 * node + i];
                                }
                            }
                        }
                        momentum.to_vec()
                    }
                }
            }
            Target::Wall(wall) => {
                let [impulse, energy] = snapshot.walls[*wall];
                vec![if quantity == Quantity::Energy { energy } else { impulse }]
            }
        }
    }

    /// Records the multiples of every interval reached by the state `snapshot` (t = 0: k = 0 exactly; later: interpolated between states).
    pub fn record(&mut self, snapshot: &Snapshot<'_>) {
        for index in 0..self.tracks.len() {
            let (request, quantity) = (self.tracks[index].request, self.tracks[index].series.quantity);
            let now = self.values(request, quantity, snapshot);
            let track = &mut self.tracks[index];
            match &track.previous {
                None => {
                    track.series.times.push(snapshot.time);
                    track.series.values.extend_from_slice(&now);
                    track.next_k = 1;
                }
                Some((before, then)) if snapshot.time > *before => loop {
                    let at = track.next_k as f64 * track.interval;
                    if at > snapshot.time * (1.0 + REACHED) {
                        break;
                    }
                    let weight = ((at - before) / (snapshot.time - before)).clamp(0.0, 1.0);
                    track.series.times.push(at);
                    track.series.values.extend(then.iter().zip(&now).map(|(a, b)| a + (b - a) * weight));
                    track.next_k += 1;
                },
                Some(_) => continue,
            }
            track.previous = Some((snapshot.time, now));
        }
    }

    /// The series; `normal_force` turns from the cumulative impulse recorded into the average force over each sample spacing.
    pub fn finish(self) -> Vec<Series> {
        self.tracks
            .into_iter()
            .map(|track| {
                let mut series = track.series;
                if series.quantity == Quantity::NormalForce {
                    let impulse = series.values.clone();
                    for k in 0..impulse.len() {
                        series.values[k] =
                            if k == 0 { 0.0 } else { (impulse[k] - impulse[k - 1]) / (series.times[k] - series.times[k - 1]) };
                    }
                }
                series
            })
            .collect()
    }
}

/// Job-file form of one request (`timeHistories` of `job.json`, camelCase, unknown fields rejected).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestSpec {
    name: String,
    kind: KindName,
    #[serde(default)]
    nodes: Vec<usize>,
    part: Option<u32>,
    wall: Option<usize>,
    quantities: Vec<QuantityName>,
    interval: Option<f64>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum KindName {
    Node,
    Part,
    RigidWall,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum QuantityName {
    Displacement,
    Velocity,
    Acceleration,
    InternalEnergy,
    KineticEnergy,
    Momentum,
    Mass,
    NormalForce,
    NormalImpulse,
    Energy,
}

impl From<QuantityName> for Quantity {
    fn from(name: QuantityName) -> Quantity {
        match name {
            QuantityName::Displacement => Quantity::Displacement,
            QuantityName::Velocity => Quantity::Velocity,
            QuantityName::Acceleration => Quantity::Acceleration,
            QuantityName::InternalEnergy => Quantity::InternalEnergy,
            QuantityName::KineticEnergy => Quantity::KineticEnergy,
            QuantityName::Momentum => Quantity::Momentum,
            QuantityName::Mass => Quantity::Mass,
            QuantityName::NormalForce => Quantity::NormalForce,
            QuantityName::NormalImpulse => Quantity::NormalImpulse,
            QuantityName::Energy => Quantity::Energy,
        }
    }
}

impl RequestSpec {
    /// The request, or why the spec is malformed (the target a kind needs is missing or a quantity does not belong to the kind).
    pub fn into_request(self) -> Result<Request, String> {
        let name = self.name;
        let target = match (self.kind, self.part, self.wall) {
            (KindName::Node, None, None) => Target::Nodes(self.nodes),
            (KindName::Part, Some(part), None) if self.nodes.is_empty() => Target::Part(part),
            (KindName::RigidWall, None, Some(wall)) if self.nodes.is_empty() => Target::Wall(wall),
            _ => return Err(format!("timeHistory '{name}': node needs nodes, part needs part, rigid_wall needs wall (one of them only)")),
        };
        let quantities: Vec<Quantity> = self.quantities.into_iter().map(Quantity::from).collect();
        if let Some(bad) = quantities.iter().find(|&&quantity| !target.allows(quantity)) {
            return Err(format!("timeHistory '{name}': '{}' is not a quantity of its kind", bad.name()));
        }
        Ok(Request { name, target, quantities, interval: self.interval })
    }
}

/// Most intervals (samples - 1) of one series or of the energy history: bounds the output size.
pub const MAX_INTERVALS: f64 = 100_000.0;

/// Whether `end_time / interval` is within `MAX_INTERVALS` (1e-9 relative slack for the division round-off).
pub fn within_cap(end_time: f64, interval: f64) -> bool {
    end_time / interval <= MAX_INTERVALS * (1.0 + 1e-9)
}

/// Index, part and interval checks of a request against the model it records.
pub fn check(request: &Request, model: &Model) -> Result<(), String> {
    let name = &request.name;
    let valid = match &request.target {
        Target::Nodes(nodes) => !nodes.is_empty() && nodes.iter().all(|&node| node < model.node_count()),
        Target::Part(part) => (0..model.hex_count() + model.tet_count()).any(|k| model.element_part.get(k).copied().unwrap_or(0) == *part),
        Target::Wall(wall) => *wall < model.walls.len(),
    };
    if !valid {
        return Err(format!("timeHistory '{name}': its nodes / part (needs a solid element) / wall do not exist in the model"));
    }
    if request.quantities.is_empty() || request.quantities.iter().enumerate().any(|(k, q)| request.quantities[..k].contains(q)) {
        return Err(format!("timeHistory '{name}': give each quantity once, at least one"));
    }
    if let Some(interval) = request.interval {
        if !(interval > 0.0 && interval <= model.controls.end_time) {
            return Err(format!("timeHistory '{name}': interval must satisfy 0 < interval <= endTime"));
        }
        if !within_cap(model.controls.end_time, interval) {
            return Err(format!("timeHistory '{name}': endTime / interval must be at most {MAX_INTERVALS}"));
        }
    }
    Ok(())
}
