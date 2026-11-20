//! Persistent scene raster of `llull-compute raster-serve` (PERF1 §5 row 10): one process draws every `render_view` /
//! `render_walkthrough` / `render_animation` frame of a host, so a frame no longer pays a process start and a job folder.
//!
//! Framing (both directions): one JSON header line, then exactly `bytes` payload bytes.
//! - Request: the scalars of a scene `job.json` (`width`, `height`, `samples`, `projection`, `depthJump`, `creaseCos`, `engine`), `png`
//!   (also encode the PNG), `buffers` (f64 counts of faces, fills, loops, points, strokes) and `bytes` (8 × their sum); the payload is the
//!   five buffers as little-endian f64, in that order.
//! - Reply: `{"ok":true,"warnings":[{code,message}],"rgba":N,"png":M,"bytes":N+M}` + the RGBA (logical size) + the PNG (`png.rs`,
//!   byte-identical to `encodePng(…, true)`; M = 0 when not asked), or `{"ok":false,"code","message","bytes":0}`.
//!
//! A scene the checks refuse answers an error and the loop goes on. An unreadable header or a short payload ends the loop with an error
//! (the framing is lost; the host starts a new process). End of input before a header is the clean shutdown.

use crate::png::encode_png;
use crate::scene::{check, render, Scene, SceneJob};
use crate::{produced_warning, RasterError};
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Read, Write};

/// Longest header line accepted (a scene header is about 200 bytes).
const MAX_HEADER_BYTES: usize = 64 * 1024;
/// Largest payload accepted: far above a 2000 × 2000 scene, far below what a broken length could allocate.
const MAX_PAYLOAD_BYTES: usize = 1 << 31;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    #[serde(flatten)]
    job: SceneJob,
    #[serde(default)]
    png: bool,
    buffers: [usize; 5],
    bytes: usize,
}

#[derive(Debug, Serialize)]
struct Warning {
    code: &'static str,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum Reply<'a> {
    Image { ok: bool, warnings: Vec<Warning>, rgba: usize, png: usize, bytes: usize },
    Failure { ok: bool, code: &'a str, message: &'a str, bytes: usize },
}

fn protocol_error(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// The next header line, or None at end of input.
fn read_header<R: BufRead>(input: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    let read = BufRead::read_until(&mut Read::take(&mut *input, MAX_HEADER_BYTES as u64 + 1), b'\n', &mut line)?;
    if read == 0 {
        return Ok(None);
    }
    if line.last() != Some(&b'\n') {
        return Err(protocol_error(format!("header line not terminated within {MAX_HEADER_BYTES} bytes")));
    }
    line.pop();
    Ok(Some(line))
}

fn f64s(bytes: &[u8]) -> Vec<f64> {
    bytes.chunks_exact(8).map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]])).collect()
}

fn scene_of(request: &Request, payload: &[u8]) -> Scene {
    let mut parts = request.buffers.iter().scan(0usize, |offset, &count| {
        let start = *offset;
        *offset += count * 8;
        Some(f64s(&payload[start..*offset]))
    });
    let mut next = || parts.next().unwrap_or_default();
    let job = &request.job;
    Scene {
        width: job.width,
        height: job.height,
        samples: job.samples,
        projection: job.projection,
        depth_jump: job.depth_jump,
        crease_cos: job.crease_cos,
        faces: next(),
        fills: next(),
        loops: next(),
        points: next(),
        strokes: next(),
    }
}

fn write_reply(output: &mut impl Write, reply: &Reply<'_>, payload: &[&[u8]]) -> io::Result<()> {
    serde_json::to_writer(&mut *output, reply)?;
    output.write_all(b"\n")?;
    for part in payload {
        output.write_all(part)?;
    }
    output.flush()
}

fn answer(output: &mut impl Write, request: &Request, payload: &[u8]) -> io::Result<()> {
    let scene = scene_of(request, payload);
    if let Err(RasterError { code, message }) = check(&scene) {
        return write_reply(output, &Reply::Failure { ok: false, code, message: &message, bytes: 0 }, &[]);
    }
    let (rgba, produced) = render(&scene, request.job.engine);
    let png = if request.png { encode_png(scene.width, scene.height, &rgba) } else { Vec::new() };
    let warnings = produced_warning(&produced).map(|(code, message)| Warning { code, message }).into_iter().collect();
    let reply = Reply::Image { ok: true, warnings, rgba: rgba.len(), png: png.len(), bytes: rgba.len() + png.len() };
    write_reply(output, &reply, &[&rgba, &png])
}

/// Serves requests from `input` until it ends (Ok) or the framing breaks (the error, after an error reply when one can be written).
pub fn serve(mut input: impl BufRead, mut output: impl Write) -> io::Result<()> {
    while let Some(header) = read_header(&mut input)? {
        let request: Request = match serde_json::from_slice(&header) {
            Ok(request) => request,
            Err(error) => {
                let message = format!("unreadable request header: {error}");
                let _ = write_reply(&mut output, &Reply::Failure { ok: false, code: "NATIVE_PROTOCOL", message: &message, bytes: 0 }, &[]);
                return Err(protocol_error(message));
            }
        };
        let expected = request.buffers.iter().try_fold(0usize, |sum, &count| sum.checked_add(count.checked_mul(8)?));
        if expected != Some(request.bytes) || request.bytes > MAX_PAYLOAD_BYTES {
            let message = format!("request of {} bytes does not hold buffers of {:?} f64 values", request.bytes, request.buffers);
            let _ = write_reply(&mut output, &Reply::Failure { ok: false, code: "NATIVE_PROTOCOL", message: &message, bytes: 0 }, &[]);
            return Err(protocol_error(message));
        }
        let mut payload = vec![0u8; request.bytes];
        input.read_exact(&mut payload)?;
        answer(&mut output, &request, &payload)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene_cpu::raster_pixels;
    use serde_json::{json, Value};
    use std::io::Cursor;

    /// One triangle face filling part of a 6 × 4 image at 2× supersampling, as the host sends it.
    fn request(width: usize, png: bool) -> (Vec<u8>, Scene) {
        let scene = Scene {
            width,
            height: 4,
            samples: 2,
            projection: crate::scene::Projection::Orthographic,
            depth_jump: 1.0,
            crease_cos: 0.9,
            faces: vec![200.0, 100.0, 50.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            fills: vec![0.0, 0.0, 1.0],
            loops: vec![0.0, 3.0],
            points: vec![1.0, 1.0, 0.0, 10.0, 1.0, 0.0, 1.0, 7.0, 0.0],
            strokes: vec![],
        };
        let buffers = [&scene.faces, &scene.fills, &scene.loops, &scene.points, &scene.strokes];
        let counts: Vec<usize> = buffers.iter().map(|b| b.len()).collect();
        let header = json!({ "width": width, "height": 4, "samples": 2, "projection": "orthographic", "depthJump": 1.0,
            "creaseCos": 0.9, "engine": "cpu", "png": png, "buffers": counts, "bytes": counts.iter().sum::<usize>() * 8 });
        let mut bytes = serde_json::to_vec(&header).unwrap();
        bytes.push(b'\n');
        for buffer in buffers {
            bytes.extend(buffer.iter().flat_map(|v| v.to_le_bytes()));
        }
        (bytes, scene)
    }

    /// Splits served output into (header, payload) replies.
    fn replies(mut bytes: &[u8]) -> Vec<(Value, Vec<u8>)> {
        let mut out = Vec::new();
        while !bytes.is_empty() {
            let end = bytes.iter().position(|&b| b == b'\n').unwrap();
            let header: Value = serde_json::from_slice(&bytes[..end]).unwrap();
            let length = header["bytes"].as_u64().unwrap() as usize;
            out.push((header, bytes[end + 1..end + 1 + length].to_vec()));
            bytes = &bytes[end + 1 + length..];
        }
        out
    }

    #[test]
    fn serves_several_frames_on_one_stream_and_ends_cleanly_at_end_of_input() {
        let (first, scene) = request(6, true);
        let (second, _) = request(6, false);
        let mut output = Vec::new();
        serve(Cursor::new([first, second].concat()), &mut output).unwrap();
        let replies = replies(&output);
        assert_eq!(replies.len(), 2);
        let rgba = raster_pixels(&scene);
        let png = encode_png(6, 4, &rgba);
        assert_eq!(replies[0].0, json!({ "ok": true, "warnings": [], "rgba": 96, "png": png.len(), "bytes": 96 + png.len() }));
        assert_eq!(replies[0].1, [rgba.clone(), png].concat());
        assert_eq!(replies[1].0["png"], 0);
        assert_eq!(replies[1].1, rgba);
    }

    #[test]
    fn a_refused_scene_answers_an_error_and_the_next_frame_is_served() {
        let (mut bad, _) = request(6, false);
        let at = bad.windows(9).position(|w| w == b"\"width\":6").unwrap();
        bad[at + 8] = b'0';
        let (good, _) = request(6, false);
        let mut output = Vec::new();
        serve(Cursor::new([bad, good].concat()), &mut output).unwrap();
        let replies = replies(&output);
        assert_eq!(replies[0].0["ok"], false);
        assert_eq!(replies[0].0["code"], "NATIVE_JOB_INPUT");
        assert_eq!(replies[1].0["ok"], true);
    }

    #[test]
    fn a_gpu_request_reports_its_cpu_fallback_as_a_warning() {
        let (mut frame, _) = request(6, false);
        let at = frame.windows(12).position(|w| w == b"\"engine\":\"cp").unwrap();
        frame.splice(at + 10..at + 13, b"gpu".iter().copied());
        let mut output = Vec::new();
        serve(Cursor::new(frame), &mut output).unwrap();
        let replies = replies(&output);
        assert_eq!(replies[0].0["ok"], true);
        if !cfg!(feature = "gpu") {
            assert_eq!(replies[0].0["warnings"][0]["code"], "NATIVE_RASTER_CPU_FALLBACK");
        }
    }

    #[test]
    fn broken_framing_ends_the_loop_with_an_error() {
        let mut output = Vec::new();
        assert!(serve(Cursor::new(b"not json\n".to_vec()), &mut output).is_err());
        assert_eq!(replies(&output)[0].0["code"], "NATIVE_PROTOCOL");

        let (frame, _) = request(6, false);
        let text = String::from_utf8_lossy(&frame[..frame.iter().position(|&b| b == b'\n').unwrap()]).replace("\"bytes\":", "\"bytes\":1");
        let mut output = Vec::new();
        assert!(serve(Cursor::new(format!("{text}\n").into_bytes()), &mut output).is_err());
        assert_eq!(replies(&output)[0].0["code"], "NATIVE_PROTOCOL");

        let (frame, _) = request(6, false);
        let mut output = Vec::new();
        let short = serve(Cursor::new(frame[..frame.len() - 3].to_vec()), &mut output).unwrap_err();
        assert_eq!(short.kind(), io::ErrorKind::UnexpectedEof);
        assert!(output.is_empty());

        let mut output = Vec::new();
        assert!(serve(Cursor::new(vec![b'{'; MAX_HEADER_BYTES + 10]), &mut output).is_err());
    }
}
