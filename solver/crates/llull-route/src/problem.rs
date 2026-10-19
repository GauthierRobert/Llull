//! The canonical problem (mirror of `RouteProblem` in `autoRoute/lattice.ts`; camelCase JSON, every length in integer µm).

use serde::Deserialize;

pub type Int3 = [i64; 3];

/// Axis order +X, -X, +Y, -Y, +Z, -Z (move order and last tie-break key); `axis ^ 1` reverses.
pub const AXIS_VECTORS: [Int3; 6] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObstacleBox {
    pub id: String,
    pub min: Int3,
    pub max: Int3,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub min: Int3,
    pub max: Int3,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemEnd {
    pub point_um: Int3,
    pub axis: u8,
    pub stub_um: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub cell: Int3,
    pub axis: u8,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteProblem {
    pub version: u32,
    pub cell_um: i64,
    pub origin_um: Int3,
    pub bounds: Bounds,
    pub from: ProblemEnd,
    pub to: ProblemEnd,
    pub goal: Goal,
    pub min_leg_cells: i64,
    pub bend_cost_um: i64,
    pub preferred_k: Vec<i64>,
    pub off_elevation_penalty_per_cell_um: i64,
    pub obstacles: Vec<ObstacleBox>,
}

/// Largest lattice extent per axis (cells): keeps every state key below 2^53, like the TypeScript number keys.
pub const MAX_CELLS_PER_AXIS: i64 = 1 << 20;

impl RouteProblem {
    /// World point (µm) of a lattice cell.
    pub fn cell_point(&self, cell: Int3) -> Int3 {
        std::array::from_fn(|d| self.origin_um[d] + cell[d] * self.cell_um)
    }

    /// Size of the search box in cells per axis.
    pub fn size(&self) -> Int3 {
        std::array::from_fn(|d| self.bounds.max[d] - self.bounds.min[d] + 1)
    }

    /// Structural checks the host already guarantees; a hand-written job gets a clear message instead of a panic.
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err(format!("problem version {} (expected 1)", self.version));
        }
        if self.cell_um < 1 || self.min_leg_cells < 1 || self.bend_cost_um < 0 || self.off_elevation_penalty_per_cell_um < 0 {
            return Err("cellUm and minLegCells must be >= 1; bendCostUm and offElevationPenaltyPerCellUm >= 0".to_string());
        }
        if self.from.axis > 5 || self.to.axis > 5 || self.goal.axis > 5 {
            return Err("axes are 0..5 (+X, -X, +Y, -Y, +Z, -Z)".to_string());
        }
        let size = self.size();
        if size.iter().any(|&n| !(1..=MAX_CELLS_PER_AXIS).contains(&n)) {
            return Err(format!("bounds must span 1..={MAX_CELLS_PER_AXIS} cells per axis"));
        }
        let inside = |c: &Int3| (0..3).all(|d| c[d] >= self.bounds.min[d] && c[d] <= self.bounds.max[d]);
        if !inside(&[0, 0, 0]) || !inside(&self.goal.cell) {
            return Err("the start cell [0, 0, 0] and the goal cell must lie inside bounds".to_string());
        }
        if self.obstacles.iter().any(|b| (0..3).any(|d| b.min[d] > b.max[d])) {
            return Err("an obstacle has min > max".to_string());
        }
        Ok(())
    }
}
