//! Plant 02 RTE V2 auto-router (RS1 RS-7, Rust CPU): the production search behind `llull auto_route`.
//!
//! The problem comes from the TypeScript command `route_problem` (`packages/domain-aec/src/plant/piping/autoRoute/`): an integer
//! micrometre lattice, port stubs, bend cost, rack-elevation penalty and inflated obstacle boxes. [`search::search`] is the same
//! A* as the TypeScript reference `searchRoute` (state = cell + incoming axis, straight move 1 cell, turn = `minLegCells` cells,
//! open set totally ordered by (f, h, i, j, k, axis), re-expansion only on a strictly smaller g), so both return the same bends,
//! cost and expansion count (VC-RTE-25). Obstacles are never rasterised: a move is tested against an integer AABB tree
//! ([`obstacles::ObstacleTree`]) and visited states live in sparse pages ([`states::States`]), so a 100 m x 100 m x 30 m box at 50 mm costs only what
//! the search touches. The document is never written here: `auto_route_pipe` validates and commits the result.

pub mod job;
pub mod obstacles;
pub mod problem;
pub mod search;
pub mod states;
