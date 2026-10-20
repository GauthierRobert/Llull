//! The explicit model in consistent units (the solver never converts): mesh, materials, initial and boundary conditions, controls.

/// Johnson–Cook strength (Johnson & Cook 1983): σ_y = (A + B ε_pⁿ)(1 + C ln max(ε̇_p/ε̇_0, 1))(1 − T*ᵐ), T* = (T − T_r)/(T_m − T_r)
/// clamped to [0, 1] (LS-DYNA R14 Theory Manual §22.15 Eq. 22.15.1; below the transition temperature the thermal term is 1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JohnsonCook {
    pub a: f64,
    pub b: f64,
    pub n: f64,
    pub c: f64,
    pub reference_rate: f64,
    pub m: f64,
    pub melt_k: f64,
    pub transition_k: f64,
}

impl JohnsonCook {
    /// Flow stress at equivalent plastic strain `eps_p` and plastic strain rate `rate` (rate term clamped at 1, TR-EXP-20).
    pub fn flow_stress(&self, eps_p: f64, rate: f64) -> f64 {
        let hardening = self.a + self.b * eps_p.max(0.0).powf(self.n);
        let rate_term = 1.0 + self.c * (rate / self.reference_rate).max(1.0).ln();
        hardening * rate_term
    }

    /// Homologous temperature T* clamped to [0, 1].
    pub fn homologous(&self, temperature: f64) -> f64 {
        ((temperature - self.transition_k) / (self.melt_k - self.transition_k)).clamp(0.0, 1.0)
    }

    /// Flow stress with the thermal term (1 − T*ᵐ).
    pub fn flow_stress_at(&self, eps_p: f64, rate: f64, t_star: f64) -> f64 {
        let thermal = if t_star > 0.0 { 1.0 - t_star.powf(self.m) } else { 1.0 };
        self.flow_stress(eps_p, rate) * thermal
    }
}

/// Adiabatic heating of plastic work: `Ṫ = β σ : ε̇ᵖ / (ρ c_p)` with β the Taylor–Quinney coefficient (LS-DYNA R14 Keyword Manual Vol. II
/// *MAT_MODIFIED_JOHNSON_COOK Eq. 107.21: "portion of plastic work converted into heat (normally taken to be 0.9)").
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Heating {
    pub taylor_quinney: f64,
    pub specific_heat: f64,
}

/// Johnson–Cook (1985) failure strain `ε_f = [D1 + D2 exp(D3 σ*)][1 + D4 ln max(ε̇_p/ε̇_0, 1)][1 + D5 T*]` with `σ*` = mean stress / von Mises
/// (positive in tension, the 1985 convention: D3 is normally negative) and damage `D = Σ Δε_p / ε_f`; the element erodes at `D ≥ 1`
/// (LS-DYNA R14 Theory Manual §22.15 Eqs. 22.15.2–22.15.4). `ε_f` is floored at `EFMIN` = 1e-6 (LS-DYNA *MAT_015).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JohnsonCookFailure {
    pub d: [f64; 5],
    pub reference_rate: f64,
}

/// LS-DYNA *MAT_015 EFMIN default.
const EFMIN: f64 = 1e-6;

impl JohnsonCookFailure {
    pub fn failure_strain(&self, triaxiality: f64, rate: f64, t_star: f64) -> f64 {
        let [d1, d2, d3, d4, d5] = self.d;
        let strain = (d1 + d2 * (d3 * triaxiality).exp()) * (1.0 + d4 * (rate / self.reference_rate).max(1.0).ln()) * (1.0 + d5 * t_star);
        strain.max(EFMIN)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Material {
    pub density: f64,
    pub youngs_modulus: f64,
    pub poisson: f64,
    pub johnson_cook: Option<JohnsonCook>,
    pub failure: Option<JohnsonCookFailure>,
    /// Adiabatic heating (None: isothermal).
    pub heating: Option<Heating>,
}

impl Material {
    /// Lamé λ.
    pub fn lambda(&self) -> f64 {
        let (e, nu) = (self.youngs_modulus, self.poisson);
        e * nu / ((1.0 + nu) * (1.0 - 2.0 * nu))
    }

    /// Shear modulus μ = G.
    pub fn shear(&self) -> f64 {
        self.youngs_modulus / (2.0 * (1.0 + self.poisson))
    }

    /// Bulk modulus K.
    pub fn bulk(&self) -> f64 {
        self.youngs_modulus / (3.0 * (1.0 - 2.0 * self.poisson))
    }

    /// Dilatational (P-wave) speed √((λ + 2μ)/ρ) at density `rho`.
    pub fn dilatational_speed(&self, rho: f64) -> f64 {
        ((self.lambda() + 2.0 * self.shear()) / rho).sqrt()
    }
}

/// A fixed planar rigid wall: nodes stay on the side `normal` points to.
#[derive(Debug, Clone, PartialEq)]
pub struct Wall {
    pub name: String,
    pub point: [f64; 3],
    /// Unit normal.
    pub normal: [f64; 3],
}

/// Coulomb friction of a contact: `μ = μ_d + (μ_s − μ_d) exp(−c |v|)` (LS-DYNA R14 Theory Manual Eq. 29.30).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Friction {
    pub static_coefficient: f64,
    pub dynamic_coefficient: f64,
    pub decay: f64,
}

/// Which surfaces a penalty contact pairs: two part sets checked both ways (symmetric), the nodes of one set against the segments of
/// another (one way, LS-DYNA type 5 node-to-surface), or one set against itself.
#[derive(Debug, Clone, PartialEq)]
pub enum ContactKind {
    SurfaceToSurface { a: Vec<u32>, b: Vec<u32> },
    NodesToSurface { slave: Vec<u32>, master: Vec<u32> },
    SelfContact { parts: Vec<u32> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Contact {
    pub name: String,
    pub kind: ContactKind,
    pub friction: Friction,
    /// Penalty scale `f_si` (SLSFAC × SFS; LS-DYNA default 0.1).
    pub penalty_scale: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MassScaling {
    pub target_time_step: f64,
    pub max_added_mass_ratio: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Controls {
    pub end_time: f64,
    pub history_interval: f64,
    pub time_step_scale: f64,
    pub min_time_step: Option<f64>,
    pub hourglass_coefficient: f64,
    pub bulk_linear: f64,
    pub bulk_quadratic: f64,
    pub mass_scaling: Option<MassScaling>,
    pub max_cycles: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Model {
    /// 3 coordinates per node.
    pub coordinates: Vec<f64>,
    /// 8 node indices per hexahedron (bottom face counter-clockwise from +z, then the top face).
    pub hex8: Vec<u32>,
    /// 4 node indices per tetrahedron (positive volume when node 3 is on the side of (1-0) x (2-0)).
    pub tet4: Vec<u32>,
    /// Material per element: hex8 first, then tet4.
    pub element_material: Vec<u32>,
    pub materials: Vec<Material>,
    /// 3 values per node.
    pub initial_velocity: Vec<f64>,
    pub gravity: [f64; 3],
    pub walls: Vec<Wall>,
    pub controls: Controls,
    /// Part index per element (contacts select surfaces by part); empty = every element in part 0.
    pub element_part: Vec<u32>,
    pub contacts: Vec<Contact>,
    /// Fixed degrees of freedom (3 per node, velocity held at 0); empty = none.
    pub fixed: Vec<bool>,
    /// 4 node indices per Belytschko–Tsay shell (after hex8 and tet4 in the element order).
    pub shell4: Vec<u32>,
    /// Thickness per shell.
    pub shell_thickness: Vec<f64>,
    /// Gauss points through the shell thickness (default 2).
    pub shell_points: usize,
    /// Fixed rotations (3 per node, angular velocity held at 0); empty = none.
    pub fixed_rotation: Vec<bool>,
    /// Initial temperature, K (None: each Johnson–Cook material starts at its transition temperature, others at 293.15 K).
    pub initial_temperature: Option<f64>,
}

impl Model {
    pub fn node_count(&self) -> usize {
        self.coordinates.len() / 3
    }

    pub fn hex_count(&self) -> usize {
        self.hex8.len() / 8
    }

    pub fn tet_count(&self) -> usize {
        self.tet4.len() / 4
    }

    pub fn shell_count(&self) -> usize {
        self.shell4.len() / 4
    }

    /// Initial temperature of material `index`: the model's, else the Johnson–Cook transition temperature, else 293.15 K.
    pub fn initial_temperature_of(&self, index: usize) -> f64 {
        self.initial_temperature
            .or_else(|| self.materials.get(index).and_then(|material| material.johnson_cook).map(|jc| jc.transition_k))
            .unwrap_or(293.15)
    }

    pub fn element_count(&self) -> usize {
        self.hex_count() + self.tet_count() + self.shell_count()
    }
}
