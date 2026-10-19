//! Plant 10 point clouds in native code (RS1 RS-3 / RS-4, `docs/plant/10-pointcloud-brownfield/TECHNICAL_SPEC.md` §2.A).
//!
//! - [`read`]: E57 (`e57` crate), LAS / LAZ (`las` + `laz` crates), ASCII readers into a [`cloud::RawCloud`].
//! - [`octree`], [`asset`], [`manifest`]: the content-addressed octree asset (§3.1) with lossless integer coordinates; [`store`] reads it.
//! - [`job`]: `llull-compute cloud import | op <job-folder>`.
//!
//! Determinism (TR-SCN-08): canonical point order, seeded RNG, fixed-order merges and `libm` transcendental functions, so a result
//! does not depend on the thread count or the platform C library.

pub mod asset;
pub mod cloud;
pub mod error;
pub mod fit;
pub mod job;
pub mod kdtree;
pub mod linalg;
pub mod lm;
pub mod manifest;
pub mod normals;
pub mod octree;
pub mod ops;
pub mod read;
pub mod register;
pub mod slice;
pub mod store;
