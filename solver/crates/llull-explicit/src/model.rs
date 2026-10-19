//! The explicit model in consistent units (the solver never converts): mesh, materials, initial and boundary conditions, controls.

/// Johnson–Cook strength (Johnson & Cook 1983): σ_y = (A + B ε_pⁿ)(1 + C ln max(ε̇_p/ε̇_0, 1))(1 − T*ᵐ). The solver is isothermal at the
/// transition temperature (T* = 0) in RS-8a, so `m`, `melt_k` and `transition_k` are carried for provenance and checked only.
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

    /// dσ_y/dε_p of the strain-hardening term at `eps_p` (rate term held), used by the radial return.
    pub fn hardening_slope(&self, eps_p: f64, rate: f64) -> f64 {
        let rate_term = 1.0 + self.c * (rate / self.reference_rate).max(1.0).ln();
        if self.b == 0.0 || self.n == 0.0 {
            return 0.0;
        }
        // n < 1 makes the slope unbounded at eps_p = 0: evaluate it at a tiny positive strain.
        let at = eps_p.max(1e-12);
        self.b * self.n * at.powf(self.n - 1.0) * rate_term
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Material {
    pub density: f64,
    pub youngs_modulus: f64,
    pub poisson: f64,
    pub johnson_cook: Option<JohnsonCook>,
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

    pub fn element_count(&self) -> usize {
        self.hex_count() + self.tet_count()
    }
}
