//! `llull-compute field <folder>` (05 IMP M4, RS1): the native field engine. It evaluates the FieldProgram tape of
//! `packages/core/src/geometry/field/program.ts` (TECHNICAL_SPEC 13.3) on voxel grids, prunes empty / full tiles by interval arithmetic,
//! extracts the iso-surface with marching tetrahedra and measures volumes, quantiles and components. Every number is bit-identical to the
//! TypeScript engine (`tsEngine.ts`, the oracle): same tape semantics, V8-exact `sin` / `cos` / `atan2` / `exp` / `log` / `hypot`, same
//! scan orders, same vertex numbering; rayon only parallelises independent nodes, tiles and chunks, so results do not depend on the thread count.
//!
//! Job folder: `job.json` + little-endian files, prefix `` for the program and `region_` for the optional region program:
//! - `job.json` = `{ op: "mesh" | "measure" | "evaluate", program, region?, grid?, maxSamples, maxTriangles, request?, points? }`;
//!   a program is `{ instructions: [{op, args}], output, meshes: n, strutSets: [{periodic: {cell, origin} | null, nodes: n, beams: n}] }`;
//!   `grid` = `{min, max, voxel}`; `request` = `{kind: "volume", sampling} | {kind: "quantile", probabilities, absolute} | {kind: "components"}`.
//! - `constants.f64`; `mesh<i>_positions.f64` + `mesh<i>_indices.u32`; `strut<i>_nodes.f64` (3 per node) + `strut<i>_beams.f64` (a, b, ra, rb, cap 1 =
//!   sphere, 5 per beam); `points.f64` (3 per point) for `evaluate`.
//! - Out: `report.json` always (`{ refusal: { code, message, samples, limit } }` on a budget refusal, else the op's figures); `positions.f64` +
//!   `indices.u32` for `mesh`; `values.f64` for `evaluate`. One `progress` event per 5 % of the cell layers while meshing.
//!
//! Gradients are not computed here: the host answers `evaluate` with gradients from the TypeScript engine.

mod components;
mod eval;
mod files;
mod interval;
mod job;
mod jsnum;
mod measure;
mod meshsdf;
mod sampling;
mod struts;
mod tape;
#[cfg(test)]
mod testkit;
mod tetra;

pub use files::JobError;
pub use job::run;
