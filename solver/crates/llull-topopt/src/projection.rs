//! Heaviside projection of the filtered density (Wang, Lazarov & Sigmund 2011 form of Guest et al. 2004):
//! `xPhys = (tanh(β η) + tanh(β (x̃ − η))) / (tanh(β η) + tanh(β (1 − η)))` on top of the density filter, with β
//! continuation: β starts at `beta_start`, doubles every `beta_every` iterations or when the design has converged at the
//! current β, and is capped at `beta` (the final value). A run counts as converged only at the final β.

/// Projection settings (named defaults in [`Projection::default`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Projection {
    /// Final sharpness.
    pub beta: f64,
    /// Threshold density.
    pub eta: f64,
    pub beta_start: f64,
    /// Iterations per continuation level.
    pub beta_every: usize,
}

impl Default for Projection {
    fn default() -> Projection {
        Projection { beta: 16.0, eta: 0.5, beta_start: 1.0, beta_every: 50 }
    }
}

impl Projection {
    /// β at continuation `level` (0 = `beta_start`), capped at the final β.
    pub fn beta_at(&self, level: u32) -> f64 {
        (self.beta_start * 2f64.powi(level as i32)).min(self.beta)
    }

    /// Whether `level` has reached the final β.
    pub fn is_final(&self, level: u32) -> bool {
        self.beta_at(level) >= self.beta
    }

    fn denominator(&self, beta: f64) -> f64 {
        (beta * self.eta).tanh() + (beta * (1.0 - self.eta)).tanh()
    }

    /// `xPhys` of the filtered densities `x_tilde` at sharpness `beta`.
    pub fn apply(&self, beta: f64, x_tilde: &[f64]) -> Vec<f64> {
        let (a, d) = ((beta * self.eta).tanh(), self.denominator(beta));
        x_tilde.iter().map(|&x| (a + (beta * (x - self.eta)).tanh()) / d).collect()
    }

    /// `d xPhys / d x̃` at `x_tilde`.
    pub fn derivative(&self, beta: f64, x_tilde: &[f64]) -> Vec<f64> {
        let d = self.denominator(beta);
        x_tilde
            .iter()
            .map(|&x| {
                let t = (beta * (x - self.eta)).tanh();
                beta * (1.0 - t * t) / d
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_keeps_the_end_points_and_sharpens_with_beta() {
        let projection = Projection::default();
        for beta in [1.0, 4.0, 16.0] {
            let ends = projection.apply(beta, &[0.0, 0.5, 1.0]);
            assert!(ends[0].abs() < 1e-15 && (ends[2] - 1.0).abs() < 1e-15 && (ends[1] - 0.5).abs() < 1e-15, "{ends:?}");
        }
        let soft = projection.apply(1.0, &[0.3])[0];
        let sharp = projection.apply(16.0, &[0.3])[0];
        assert!(sharp < soft && sharp < 0.01, "{soft} {sharp}");
    }

    #[test]
    fn derivative_matches_finite_differences() {
        let projection = Projection { beta: 8.0, eta: 0.4, beta_start: 1.0, beta_every: 10 };
        for &x in &[0.1, 0.4, 0.75] {
            let h = 1e-6;
            let numeric = (projection.apply(8.0, &[x + h])[0] - projection.apply(8.0, &[x - h])[0]) / (2.0 * h);
            let analytic = projection.derivative(8.0, &[x])[0];
            assert!((numeric - analytic).abs() < 1e-7, "{x}: {numeric} vs {analytic}");
        }
    }

    #[test]
    fn continuation_doubles_and_caps() {
        let projection = Projection { beta: 12.0, eta: 0.5, beta_start: 1.0, beta_every: 5 };
        assert_eq!(projection.beta_at(0), 1.0);
        assert_eq!(projection.beta_at(2), 4.0);
        assert_eq!(projection.beta_at(3), 8.0);
        assert_eq!(projection.beta_at(4), 12.0);
        assert!(!projection.is_final(3) && projection.is_final(4) && projection.is_final(9));
    }
}
