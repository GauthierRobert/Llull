//! Motion-video encoders for `llull-compute media <folder>` (PHY-22 MOV M2, `docs/physics/22-motion-video/TECHNICAL_SPEC.md` §4.1 / TR-MOV-13).
//! `gif`: one global palette + 8x8 Bayer ordered dither + changed-rectangle frames; `mp4`: AV1 (rav1e) in an own ISOBMFF muxer.
//! Contract of the job folder in [`job`].

pub mod av1;
pub mod gif_encoder;
pub mod job;
pub mod mp4;
pub mod pixels;
pub mod yuv;

pub use job::{run, JobError};
