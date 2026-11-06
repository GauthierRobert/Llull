//! `llull-compute media <folder>` (PHY-22 MOV M2, TR-MOV-12 / 13): encodes the PNG frames of a folder to a GIF or an AV1 MP4.
//!
//! Job folder: `job.json` = `{ "version": 1, "format": "gif" | "mp4", "width", "height", "fps", "quality": "draft" | "standard" | "high",
//! "frames": n, "threads"?: t }` and `frame-00000.png` .. `frame-{n-1:05}.png` (8-bit PNG, exactly `width` x `height`). Outputs: `out.gif` or
//! `out.mp4`, and `report.json` = `{ format, frames, width, height, fps, bytes, encoder { name, version, deterministic }, threads, ms }`.
//! One `progress` event per frame (`step` = frames encoded, `total` = n). Frames are read one at a time (GIF: the four palette frames
//! first, then each frame again), so the job holds one picture plus the encoder state, never the whole clip.
//! MP4 needs even `width` and `height` (4:2:0); `threads` defaults to min(cores, 8) and never changes the bytes (fixed tile layout).
//! Errors: `NATIVE_JOB_INPUT` (manifest, size, a frame that is missing / not a PNG / the wrong size), `NATIVE_JOB_IO`, `NATIVE_JOB_ENCODE`.

use crate::av1::{preset, Av1Encoder};
use crate::gif_encoder::{sample_frames, GifWriter};
use crate::mp4::mux;
use crate::pixels::{decode_png, Rgb};
use crate::yuv::to_yuv420;
use llull_protocol::{emit, sha256_hex, Event, Output};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

/// A job failure: stable code + message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

fn input_error(message: impl Into<String>) -> JobError {
    JobError { code: "NATIVE_JOB_INPUT", message: message.into() }
}

fn encode_error(message: impl Into<String>) -> JobError {
    JobError { code: "NATIVE_JOB_ENCODE", message: message.into() }
}

fn io_error(path: &Path, error: impl std::fmt::Display) -> JobError {
    JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) }
}

/// Named guards of the manifest.
const MAX_FRAMES: u64 = 3600;
const MAX_SIDE: u64 = 4096;
const MAX_FPS: u64 = 60;
/// Default thread count of the AV1 encoder (measured at M0: no gain past 8 on a 4 x 2 tile layout).
const MAX_DEFAULT_THREADS: usize = 8;
/** Converted pictures the reader thread may run ahead of the encoder (each is 1.5 bytes per pixel). */
const PREFETCH_FRAMES: usize = 2;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MediaJob {
    version: u32,
    format: String,
    width: u64,
    height: u64,
    fps: u64,
    quality: String,
    frames: u64,
    threads: Option<u64>,
}

#[derive(Debug, Serialize)]
struct EncoderInfo {
    name: &'static str,
    version: String,
    deterministic: bool,
}

#[derive(Debug, Serialize)]
struct Report {
    format: String,
    frames: u64,
    width: u64,
    height: u64,
    fps: u64,
    bytes: usize,
    encoder: EncoderInfo,
    threads: usize,
    ms: u128,
}

fn frame_path(folder: &Path, k: usize) -> std::path::PathBuf {
    folder.join(format!("frame-{k:05}.png"))
}

/// Frame `k` decoded and checked against the job size.
fn read_frame(folder: &Path, k: usize, job: &MediaJob) -> Result<Rgb, JobError> {
    let path = frame_path(folder, k);
    let bytes = fs::read(&path).map_err(|error| io_error(&path, error))?;
    let frame = decode_png(&bytes).map_err(|message| input_error(format!("frame {k}: {message}")))?;
    if (frame.width as u64, frame.height as u64) != (job.width, job.height) {
        return Err(input_error(format!("frame {k} is {} x {}, the job says {} x {}", frame.width, frame.height, job.width, job.height)));
    }
    Ok(frame)
}

fn progress(out: &mut impl Write, step: usize, total: u64, message: &str) {
    let _ = emit(out, &Event::Progress { step: step as u64, total, message, detail: None });
}

fn validate(job: &MediaJob) -> Result<(), JobError> {
    if job.version != 1 {
        return Err(input_error(format!("job.json version {} is not supported (1)", job.version)));
    }
    if job.format != "gif" && job.format != "mp4" {
        return Err(input_error(format!("unknown format '{}' (gif, mp4)", job.format)));
    }
    if preset(&job.quality).is_none() {
        return Err(input_error(format!("unknown quality '{}' (draft, standard, high)", job.quality)));
    }
    if !(1..=MAX_FRAMES).contains(&job.frames) || !(1..=MAX_FPS).contains(&job.fps) {
        return Err(input_error(format!("{} frames at {} fps: frames 1..{MAX_FRAMES}, fps 1..{MAX_FPS}", job.frames, job.fps)));
    }
    if !(2..=MAX_SIDE).contains(&job.width) || !(2..=MAX_SIDE).contains(&job.height) {
        return Err(input_error(format!("size {} x {}: each side 2..{MAX_SIDE}", job.width, job.height)));
    }
    if job.format == "mp4" && (!job.width.is_multiple_of(2) || !job.height.is_multiple_of(2)) {
        return Err(input_error(format!("an MP4 (4:2:0) needs even sides, got {} x {}", job.width, job.height)));
    }
    Ok(())
}

fn encode_gif(folder: &Path, job: &MediaJob, out: &mut impl Write) -> Result<(Vec<u8>, EncoderInfo), JobError> {
    let count = job.frames as usize;
    let samples: Vec<Rgb> = sample_frames(count).into_iter().map(|k| read_frame(folder, k, job)).collect::<Result<_, _>>()?;
    let refs: Vec<&Rgb> = samples.iter().collect();
    let mut writer = GifWriter::new(job.width as usize, job.height as usize, job.fps as u32, &refs).map_err(encode_error)?;
    drop(samples);
    for k in 0..count {
        writer.push(&read_frame(folder, k, job)?).map_err(encode_error)?;
        progress(out, k + 1, job.frames, "gif frame");
    }
    let bytes = writer.finish().map_err(encode_error)?;
    Ok((bytes, EncoderInfo { name: "llull-media-gif", version: env!("CARGO_PKG_VERSION").to_string(), deterministic: true }))
}

fn encode_mp4(folder: &Path, job: &MediaJob, threads: usize, out: &mut impl Write) -> Result<(Vec<u8>, EncoderInfo), JobError> {
    let (width, height) = (job.width as usize, job.height as usize);
    let chosen = preset(&job.quality).ok_or_else(|| input_error("unknown quality"))?;
    let mut encoder = Av1Encoder::new(width, height, job.fps as u32, chosen, threads).map_err(encode_error)?;
    // a reader thread decodes and converts frame k + 1 while the encoder threads work on frame k (the encoder pool is idle during a serial decode)
    let (sender, receiver) = std::sync::mpsc::sync_channel(PREFETCH_FRAMES);
    std::thread::scope(|scope| {
        scope.spawn(move || {
            for k in 0..job.frames as usize {
                let planes = read_frame(folder, k, job).map(|frame| to_yuv420(&frame));
                let failed = planes.is_err();
                if sender.send(planes).is_err() || failed {
                    return;
                }
            }
        });
        for (k, planes) in receiver.iter().enumerate() {
            encoder.push(&planes?).map_err(encode_error)?;
            progress(out, k + 1, job.frames, "mp4 frame");
        }
        Ok::<(), JobError>(())
    })?;
    let encoded = encoder.finish().map_err(encode_error)?;
    if encoded.packets.len() as u64 != job.frames {
        return Err(encode_error(format!("rav1e produced {} packets for {} frames", encoded.packets.len(), job.frames)));
    }
    let bytes = mux(width, height, job.fps as u32, &encoded.packets, &encoded.av1c);
    Ok((bytes, EncoderInfo { name: "rav1e", version: rav1e::version::short(), deterministic: true }))
}

fn write(folder: &Path, name: &str, bytes: &[u8]) -> Result<Output, JobError> {
    let path = folder.join(name);
    fs::write(&path, bytes).map_err(|error| io_error(&path, error))?;
    Ok(Output { path: name.to_string(), sha256: sha256_hex(bytes) })
}

/// Runs the job in `folder`; returns the written outputs.
pub fn run(folder: &Path, out: &mut impl Write) -> Result<Vec<Output>, JobError> {
    let started = Instant::now();
    let manifest = folder.join("job.json");
    let text = fs::read_to_string(&manifest).map_err(|error| io_error(&manifest, error))?;
    let job: MediaJob = serde_json::from_str(&text).map_err(|error| input_error(format!("job.json: {error}")))?;
    validate(&job)?;
    let threads = job.threads.map_or_else(
        || std::thread::available_parallelism().map_or(1, usize::from).min(MAX_DEFAULT_THREADS),
        |t| (t as usize).clamp(1, 64),
    );
    let (bytes, encoder) = if job.format == "gif" { encode_gif(folder, &job, out)? } else { encode_mp4(folder, &job, threads, out)? };
    let name = if job.format == "gif" { "out.gif" } else { "out.mp4" };
    let report = Report {
        format: job.format.clone(),
        frames: job.frames,
        width: job.width,
        height: job.height,
        fps: job.fps,
        bytes: bytes.len(),
        encoder,
        threads,
        ms: started.elapsed().as_millis(),
    };
    let report_json = serde_json::to_vec(&report).map_err(|error| encode_error(error.to_string()))?;
    Ok(vec![write(folder, name, &bytes)?, write(folder, "report.json", &report_json)?])
}
