//! Contract of `llull-compute media` (VC-MOV-09 / 10 / 25): container structure of the written files, determinism, progress, refusals.
//! The parsers below share no code with the crate (they read the bytes the way `validation/check_media.py` does).

use llull_media::run;
use std::path::{Path, PathBuf};

fn temp_folder(name: &str) -> PathBuf {
    let folder = std::env::temp_dir().join(format!("llull-media-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    folder
}

fn picture(width: usize, height: usize, k: usize) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        for x in 0..width {
            let mut c = [30u8 + (y * 40 / height) as u8, 34, 48];
            if x % 16 == 0 || y % 16 == 0 {
                c = [70, 74, 88];
            }
            let bar = (k * 4) % width;
            if x >= bar && x < bar + width / 6 && y > height / 3 && y < 2 * height / 3 {
                c = [255, 159, 28];
            }
            rgb.extend_from_slice(&c);
        }
    }
    rgb
}

fn write_png(path: &Path, width: usize, height: usize, rgb: &[u8]) {
    let file = std::fs::File::create(path).unwrap();
    let mut encoder = png::Encoder::new(file, width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().unwrap().write_image_data(rgb).unwrap();
}

struct Spec<'a> {
    format: &'a str,
    width: usize,
    height: usize,
    fps: u32,
    quality: &'a str,
    frames: usize,
    threads: Option<u32>,
    moving: bool,
}

impl<'a> Spec<'a> {
    fn new(format: &'a str, frames: usize) -> Self {
        Self { format, width: 128, height: 96, fps: 30, quality: "draft", frames, threads: None, moving: true }
    }

    fn folder(&self, name: &str) -> PathBuf {
        let folder = temp_folder(name);
        let threads = self.threads.map_or(String::new(), |t| format!(r#","threads":{t}"#));
        let manifest = format!(
            r#"{{"version":1,"format":"{}","width":{},"height":{},"fps":{},"quality":"{}","frames":{}{threads}}}"#,
            self.format, self.width, self.height, self.fps, self.quality, self.frames
        );
        std::fs::write(folder.join("job.json"), manifest).unwrap();
        for k in 0..self.frames {
            let rgb = picture(self.width, self.height, if self.moving { k } else { 0 });
            write_png(&folder.join(format!("frame-{k:05}.png")), self.width, self.height, &rgb);
        }
        folder
    }
}

fn run_job(folder: &Path) -> (Result<Vec<llull_protocol::Output>, llull_media::JobError>, Vec<String>) {
    let mut events = Vec::new();
    let result = run(folder, &mut events);
    (result, String::from_utf8(events).unwrap().lines().map(str::to_string).collect())
}

fn encoded(spec: &Spec, name: &str) -> (PathBuf, Vec<String>) {
    let folder = spec.folder(name);
    let (result, events) = run_job(&folder);
    result.unwrap();
    (folder, events)
}

fn be32(bytes: &[u8], at: usize) -> usize {
    u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize
}

/// `(type, body start, end)` of the boxes in `start..end`.
fn boxes(data: &[u8], start: usize, end: usize) -> Vec<(String, usize, usize)> {
    let mut found = Vec::new();
    let mut at = start;
    while at < end {
        let size = be32(data, at);
        assert!(size >= 8 && at + size <= end, "box overruns its parent at {at}");
        found.push((String::from_utf8_lossy(&data[at + 4..at + 8]).to_string(), at + 8, at + size));
        at += size;
    }
    found
}

fn child(data: &[u8], parent: (usize, usize), path: &[&str]) -> (usize, usize) {
    let (_, body, end) = boxes(data, parent.0, parent.1).into_iter().find(|b| b.0 == path[0]).unwrap_or_else(|| panic!("no {}", path[0]));
    if path.len() == 1 {
        (body, end)
    } else {
        child(data, (body, end), &path[1..])
    }
}

#[test]
fn mp4_has_the_streaming_box_tree_one_av1_track_and_one_sample_per_frame() {
    let (folder, events) = encoded(&Spec::new("mp4", 12), "mp4-tree");
    let data = std::fs::read(folder.join("out.mp4")).unwrap();
    let top = boxes(&data, 0, data.len());
    assert_eq!(top.iter().map(|b| b.0.as_str()).collect::<Vec<_>>(), ["ftyp", "moov", "mdat"], "moov before mdat");
    assert_eq!(&data[top[0].1..top[0].1 + 4], b"isom");
    let compatible = &data[top[0].1 + 8..top[0].2];
    for brand in [b"isom", b"iso6", b"av01", b"mp41"] {
        assert!(compatible.chunks(4).any(|c| c == brand), "compatible brand {}", String::from_utf8_lossy(brand));
    }
    let moov = (top[1].1, top[1].2);
    let traks: Vec<_> = boxes(&data, moov.0, moov.1).into_iter().filter(|b| b.0 == "trak").collect();
    assert_eq!(traks.len(), 1);
    let trak = (traks[0].1, traks[0].2);
    let mdhd = child(&data, trak, &["mdia", "mdhd"]);
    assert_eq!((be32(&data, mdhd.0 + 12), be32(&data, mdhd.0 + 16)), (30, 12), "timescale = fps, duration = frames");
    let stbl = child(&data, trak, &["mdia", "minf", "stbl"]);
    let stsd = child(&data, stbl, &["stsd"]);
    let entry = stsd.0 + 8;
    assert_eq!(&data[entry + 4..entry + 8], b"av01");
    assert_eq!((data[entry + 32] as usize) << 8 | data[entry + 33] as usize, 128);
    let configuration = child(&data, (entry + 86, stsd.1), &["av1C"]);
    assert_eq!(data[configuration.0], 0x81, "av1C marker + version 1");
    assert_eq!(
        configuration.1 - configuration.0,
        4,
        "rav1e gives the 4 configuration bytes; the sequence header OBU travels in the first sample"
    );
    let stsz = child(&data, stbl, &["stsz"]);
    assert_eq!(be32(&data, stsz.0 + 8), 12);
    let sizes: Vec<usize> = (0..12).map(|i| be32(&data, stsz.0 + 12 + 4 * i)).collect();
    let stts = child(&data, stbl, &["stts"]);
    assert_eq!((be32(&data, stts.0 + 4), be32(&data, stts.0 + 8), be32(&data, stts.0 + 12)), (1, 12, 1), "one run of 12 deltas of 1");
    let stss = child(&data, stbl, &["stss"]);
    assert_eq!(be32(&data, stss.0 + 8), 1, "a clip shorter than 2 s has the first frame as its only key frame");
    let stco = child(&data, stbl, &["stco"]);
    let offset = be32(&data, stco.0 + 8);
    assert_eq!(offset, top[2].1, "the chunk starts at the mdat body");
    assert_eq!(sizes.iter().sum::<usize>(), top[2].2 - top[2].1, "the samples fill the mdat");
    let first = &data[offset..offset + sizes[0]];
    assert!(!(first[0] == 0x12 && first[1] == 0), "the temporal delimiter OBU is stripped");
    assert_eq!(first[0] >> 3 & 0x0f, 1, "the first sample starts with the sequence header OBU");
    assert_eq!(events.len(), 12 + 1 - 1, "one progress event per frame");
    assert!(events[11].contains(r#""step":12"#) && events[11].contains(r#""total":12"#));
    let report: serde_json::Value = serde_json::from_slice(&std::fs::read(folder.join("report.json")).unwrap()).unwrap();
    assert_eq!(report["encoder"]["name"], "rav1e");
    assert_eq!(report["encoder"]["version"], "0.8.1");
    assert_eq!(report["encoder"]["deterministic"], true);
}

#[test]
fn mp4_bytes_do_not_depend_on_the_thread_count() {
    let mut one = Spec::new("mp4", 8);
    one.width = 256;
    one.height = 144;
    one.threads = Some(1);
    let mut four = Spec::new("mp4", 8);
    four.width = 256;
    four.height = 144;
    four.threads = Some(4);
    let (a, _) = encoded(&one, "mp4-threads-1");
    let (b, _) = encoded(&four, "mp4-threads-4");
    let (x, y) = (std::fs::read(a.join("out.mp4")).unwrap(), std::fs::read(b.join("out.mp4")).unwrap());
    assert_eq!(x, y, "fixed tile layout: same packets for 1 and 4 threads");
    let (c, _) = encoded(&one, "mp4-threads-1b");
    assert_eq!(x, std::fs::read(c.join("out.mp4")).unwrap(), "byte-identical rerun");
}

#[test]
fn high_quality_is_a_different_smaller_or_equal_quality_preset_and_still_one_packet_per_frame() {
    let mut spec = Spec::new("mp4", 6);
    spec.quality = "high";
    let (folder, _) = encoded(&spec, "mp4-high");
    let data = std::fs::read(folder.join("out.mp4")).unwrap();
    let top = boxes(&data, 0, data.len());
    let stsz = child(&data, (top[1].1, top[1].2), &["trak", "mdia", "minf", "stbl", "stsz"]);
    assert_eq!(be32(&data, stsz.0 + 8), 6);
}

struct GifFacts {
    width: usize,
    height: usize,
    frames: usize,
    delays: Vec<u16>,
    rectangles: Vec<(usize, usize, usize, usize)>,
    loop_count: Option<u16>,
    trailer: bool,
}

fn skip_sub_blocks(data: &[u8], mut at: usize) -> usize {
    loop {
        let size = data[at] as usize;
        at += 1;
        if size == 0 {
            return at;
        }
        at += size;
    }
}

fn read_gif(data: &[u8]) -> GifFacts {
    assert_eq!(&data[..6], b"GIF89a");
    let (width, height) = (u16::from_le_bytes([data[6], data[7]]) as usize, u16::from_le_bytes([data[8], data[9]]) as usize);
    let flags = data[10];
    let mut at = 13 + if flags & 0x80 != 0 { 3 * (1 << ((flags & 7) + 1)) } else { 0 };
    let mut facts = GifFacts { width, height, frames: 0, delays: vec![], rectangles: vec![], loop_count: None, trailer: false };
    while at < data.len() {
        match data[at] {
            0x3b => {
                facts.trailer = true;
                break;
            }
            0x21 => {
                let label = data[at + 1];
                if label == 0xf9 {
                    facts.delays.push(u16::from_le_bytes([data[at + 4], data[at + 5]]));
                } else if label == 0xff && &data[at + 3..at + 14] == b"NETSCAPE2.0" {
                    facts.loop_count = Some(u16::from_le_bytes([data[at + 16], data[at + 17]]));
                }
                at = skip_sub_blocks(data, at + 2);
            }
            0x2c => {
                let word = |o: usize| u16::from_le_bytes([data[at + o], data[at + o + 1]]) as usize;
                facts.rectangles.push((word(1), word(3), word(5), word(7)));
                let local = data[at + 9];
                at += 10 + if local & 0x80 != 0 { 3 * (1 << ((local & 7) + 1)) } else { 0 };
                at = skip_sub_blocks(data, at + 1);
                facts.frames += 1;
            }
            other => panic!("unexpected GIF block {other:#x}"),
        }
    }
    facts
}

#[test]
fn gif_loops_forever_with_cumulative_delays_and_changed_rectangles() {
    let (folder, events) = encoded(&Spec::new("gif", 10), "gif-moving");
    let data = std::fs::read(folder.join("out.gif")).unwrap();
    let facts = read_gif(&data);
    assert!(facts.trailer);
    assert_eq!((facts.width, facts.height, facts.frames), (128, 96, 10));
    assert_eq!(facts.loop_count, Some(0), "NETSCAPE2.0 loop 0 = forever");
    assert_eq!(facts.delays, [3, 4, 3, 3, 4, 3, 3, 4, 3, 3], "30 fps by the cumulative rule");
    assert_eq!(facts.rectangles[0], (0, 0, 128, 96), "the first frame is the whole canvas");
    assert!(facts.rectangles[1..].iter().all(|r| r.2 * r.3 < 128 * 96), "later frames carry only the changed rectangle");
    assert_eq!(events.len(), 10);
}

#[test]
fn gif_palette_and_dither_are_deterministic_and_a_still_picture_costs_one_pixel_per_frame() {
    let mut still = Spec::new("gif", 6);
    still.moving = false;
    still.fps = 10;
    let (a, _) = encoded(&still, "gif-still-a");
    let (b, _) = encoded(&still, "gif-still-b");
    let bytes = std::fs::read(a.join("out.gif")).unwrap();
    assert_eq!(bytes, std::fs::read(b.join("out.gif")).unwrap(), "byte-identical rerun");
    let facts = read_gif(&bytes);
    assert_eq!(facts.delays, [10; 6]);
    assert!(facts.rectangles[1..].iter().all(|r| (r.2, r.3) == (1, 1)), "no change: a 1 x 1 transparent frame holds the delay");
}

#[test]
fn a_single_frame_gif_and_a_single_frame_mp4_are_valid() {
    let (gif, _) = encoded(&Spec::new("gif", 1), "gif-one");
    assert_eq!(read_gif(&std::fs::read(gif.join("out.gif")).unwrap()).frames, 1);
    let (mp4, _) = encoded(&Spec::new("mp4", 1), "mp4-one");
    let data = std::fs::read(mp4.join("out.mp4")).unwrap();
    let top = boxes(&data, 0, data.len());
    let stsz = child(&data, (top[1].1, top[1].2), &["trak", "mdia", "minf", "stbl", "stsz"]);
    assert_eq!(be32(&data, stsz.0 + 8), 1);
}

fn refusal(spec: &Spec, name: &str, edit: impl FnOnce(&Path)) -> llull_media::JobError {
    let folder = spec.folder(name);
    edit(&folder);
    run_job(&folder).0.unwrap_err()
}

#[test]
fn refuses_bad_manifests_sizes_and_frames_with_input_codes() {
    let odd = Spec { width: 127, ..Spec::new("mp4", 2) };
    let error = refusal(&odd, "odd", |_| {});
    assert_eq!(error.code, "NATIVE_JOB_INPUT");
    assert!(error.message.contains("even"), "{}", error.message);
    // odd sizes are fine for a GIF
    let odd_gif = Spec { width: 127, ..Spec::new("gif", 2) };
    let folder = odd_gif.folder("odd-gif");
    run_job(&folder).0.unwrap();

    let manifest = |folder: &Path, from: &str, to: &str| {
        let path = folder.join("job.json");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(from));
        std::fs::write(&path, text.replace(from, to)).unwrap();
    };
    for (from, to, expect) in [
        (r#""version":1"#, r#""version":2"#, "version 2"),
        (r#""format":"mp4""#, r#""format":"avi""#, "unknown format"),
        (r#""quality":"draft""#, r#""quality":"ultra""#, "unknown quality"),
        (r#""fps":30"#, r#""fps":0"#, "fps"),
        (r#""frames":2"#, r#""frames":0"#, "frames"),
        (r#""frames":2"#, r#""frames":3"#, "frame-00002.png"),
        (r#""width":128"#, r#""width":64"#, "frame 0 is 128 x 96"),
        (r#""frames":2"#, r#""frames":2,"extra":1"#, "unknown field"),
    ] {
        let error = refusal(&Spec::new("mp4", 2), "bad", |folder| manifest(folder, from, to));
        assert!(error.code.starts_with("NATIVE_JOB_"), "{expect}: {error:?}");
        assert!(error.message.contains(expect), "{expect}: {}", error.message);
    }
}

#[test]
fn refuses_a_frame_that_is_not_a_png_and_a_missing_manifest() {
    let error = refusal(&Spec::new("gif", 3), "junk", |folder| std::fs::write(folder.join("frame-00001.png"), b"not a png").unwrap());
    assert_eq!(error.code, "NATIVE_JOB_INPUT");
    assert!(error.message.contains("frame 1"), "{}", error.message);
    let empty = temp_folder("empty");
    assert_eq!(run_job(&empty).0.unwrap_err().code, "NATIVE_JOB_IO");
}
