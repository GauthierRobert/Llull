//! Lattice units (TECHNICAL_SPEC §5.3): the cell is 1, the step is 1 and the reference density is 1. The inflow lattice Mach
//! number (named default 0.1) sets the time step, the physical viscosity sets the relaxation time τ = 3 ν_lat + ½.

use crate::lattice::CS2;

/// Named default of the inflow lattice Mach number.
pub const DEFAULT_LATTICE_MACH: f64 = 0.1;
/// τ must stay above ½ by this margin without LES (`CFD_UNSTABLE_PARAMS`).
pub const MIN_TAU_MARGIN: f64 = 1e-3;

/// Conversion between the lattice and SI.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Lattice {
    /// Cell side, m.
    pub h: f64,
    /// Time step, s.
    pub dt: f64,
    /// Inflow speed in lattice units.
    pub u_lat: f64,
    pub nu_lat: f64,
    pub tau: f64,
    /// Physical density of lattice density 1, kg/m³.
    pub rho_phys: f64,
}

impl Lattice {
    /// Lattice for cells of `h` m, a free stream of `speed_ms`, air `viscosity_pa_s` / `density_kg_m3`, at `lattice_mach`.
    pub fn new(h: f64, speed_ms: f64, viscosity_pa_s: f64, density_kg_m3: f64, lattice_mach: f64) -> Lattice {
        let u_lat = lattice_mach * CS2.sqrt();
        let dt = u_lat * h / speed_ms;
        let nu_lat = viscosity_pa_s / density_kg_m3 * dt / (h * h);
        Lattice { h, dt, u_lat, nu_lat, tau: 3.0 * nu_lat + 0.5, rho_phys: density_kg_m3 }
    }

    /// Lattice from a lattice viscosity and inflow speed (tests of exact solutions set these directly).
    pub fn from_lattice(h: f64, dt: f64, u_lat: f64, nu_lat: f64, rho_phys: f64) -> Lattice {
        Lattice { h, dt, u_lat, nu_lat, tau: 3.0 * nu_lat + 0.5, rho_phys }
    }

    /// Momentum per step on a wall link -> N.
    pub fn force_newton(&self, f_lat: f64) -> f64 {
        f_lat * self.rho_phys * self.h.powi(4) / (self.dt * self.dt)
    }

    /// Lattice moment (force × cells) -> N·m.
    pub fn moment_newton_metre(&self, m_lat: f64) -> f64 {
        m_lat * self.rho_phys * self.h.powi(5) / (self.dt * self.dt)
    }

    pub fn velocity_ms(&self, u_lat: f64) -> f64 {
        u_lat * self.h / self.dt
    }

    /// Gauge pressure of a lattice density, Pa (`p = (ρ − 1) c_s²` in lattice units).
    pub fn pressure_pa(&self, rho_lat: f64) -> f64 {
        (rho_lat - 1.0) * CS2 * self.rho_phys * (self.h / self.dt).powi(2)
    }

    pub fn time_s(&self, steps: u64) -> f64 {
        steps as f64 * self.dt
    }

    /// Steps of one flow-through of `length_m` at the inflow speed (at least 1).
    pub fn flow_through_steps(&self, length_m: f64) -> u64 {
        ((length_m / self.h) / self.u_lat).ceil().max(1.0) as u64
    }

    /// Reynolds number of `length_m`.
    pub fn reynolds(&self, length_m: f64) -> f64 {
        self.u_lat * (length_m / self.h) / self.nu_lat
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_consistently_both_ways() {
        // Sphere D = 1 m, U = 1 m/s, nu = 0.01 m²/s (Re 100), 32 cells per metre.
        let lattice = Lattice::new(1.0 / 32.0, 1.0, 0.01, 1.0, 0.1);
        assert!((lattice.u_lat - 0.1 / 3f64.sqrt()).abs() < 1e-12);
        assert!((lattice.velocity_ms(lattice.u_lat) - 1.0).abs() < 1e-12);
        assert!((lattice.reynolds(1.0) - 100.0).abs() < 1e-9);
        assert!(lattice.tau > 0.5);
        // A unit lattice force on a grid of h = 1 m, dt = 1 s and ρ = 1 is one newton.
        let unit = Lattice::from_lattice(1.0, 1.0, 0.1, 0.1, 1.0);
        assert_eq!(unit.force_newton(1.0), 1.0);
        assert_eq!(unit.moment_newton_metre(1.0), 1.0);
        assert!((unit.pressure_pa(1.3) - 0.1).abs() < 1e-12);
        assert_eq!(lattice.flow_through_steps(1.0), (32.0 / lattice.u_lat).ceil() as u64);
    }
}
