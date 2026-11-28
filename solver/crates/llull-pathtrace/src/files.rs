//! Result files, streamed row by row so an 8192² image needs no second full-size buffer:
//!
//! - `beauty.exr`: a minimal OpenEXR 2.0 single-part scanline file written here — channels A, B, G, R (alphabetical, as the format
//!   requires) all HALF, NO_COMPRESSION (one scanline per chunk, so the offset table is known up front), INCREASING_Y, data and display
//!   window the whole image, alpha 1.
//! - `image.png`: 8-bit RGB through the `png` crate's stream writer (opaque, so no alpha channel).

use crate::render::Image;
use crate::tonemap::to_srgb8;
use half::f16;
use sha2::{Digest, Sha256};
use std::io::{self, Write};

fn attribute(header: &mut Vec<u8>, name: &str, kind: &str, value: &[u8]) {
    header.extend_from_slice(name.as_bytes());
    header.push(0);
    header.extend_from_slice(kind.as_bytes());
    header.push(0);
    header.extend_from_slice(&(value.len() as i32).to_le_bytes());
    header.extend_from_slice(value);
}

fn exr_header(width: u32, height: u32) -> Vec<u8> {
    let mut header = vec![0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0];
    let mut channels = Vec::new();
    for name in ["A", "B", "G", "R"] {
        channels.extend_from_slice(name.as_bytes());
        channels.push(0);
        channels.extend_from_slice(&1i32.to_le_bytes()); // HALF
        channels.extend_from_slice(&[0, 0, 0, 0]); // pLinear + reserved
        channels.extend_from_slice(&1i32.to_le_bytes());
        channels.extend_from_slice(&1i32.to_le_bytes());
    }
    channels.push(0);
    let window: Vec<u8> = [0i32, 0, width as i32 - 1, height as i32 - 1].iter().flat_map(|v| v.to_le_bytes()).collect();
    attribute(&mut header, "channels", "chlist", &channels);
    attribute(&mut header, "compression", "compression", &[0]);
    attribute(&mut header, "dataWindow", "box2i", &window);
    attribute(&mut header, "displayWindow", "box2i", &window);
    attribute(&mut header, "lineOrder", "lineOrder", &[0]);
    attribute(&mut header, "pixelAspectRatio", "float", &1.0f32.to_le_bytes());
    attribute(&mut header, "screenWindowCenter", "v2f", &[0u8; 8]);
    attribute(&mut header, "screenWindowWidth", "float", &1.0f32.to_le_bytes());
    header.push(0);
    header
}

/// Writes the beauty as `beauty.exr` bytes to `out`.
pub fn write_exr(out: &mut impl Write, image: &Image) -> io::Result<()> {
    let (width, height) = (image.width as usize, image.height as usize);
    let header = exr_header(image.width, image.height);
    out.write_all(&header)?;
    let line_bytes = width * 4 * 2;
    let chunk = 8 + line_bytes;
    let table_end = header.len() + height * 8;
    for y in 0..height {
        out.write_all(&((table_end + y * chunk) as u64).to_le_bytes())?;
    }
    let one = f16::ONE.to_le_bytes();
    let mut line = vec![0u8; line_bytes];
    for y in 0..height {
        let row = &image.beauty[y * width..(y + 1) * width];
        for (x, pixel) in row.iter().enumerate() {
            let at = |channel: usize| (channel * width + x) * 2;
            line[at(0)..at(0) + 2].copy_from_slice(&one);
            line[at(1)..at(1) + 2].copy_from_slice(&pixel[2].to_le_bytes());
            line[at(2)..at(2) + 2].copy_from_slice(&pixel[1].to_le_bytes());
            line[at(3)..at(3) + 2].copy_from_slice(&pixel[0].to_le_bytes());
        }
        out.write_all(&(y as i32).to_le_bytes())?;
        out.write_all(&(line_bytes as i32).to_le_bytes())?;
        out.write_all(&line)?;
    }
    out.flush()
}

/// Writes the tone-mapped `image.png` bytes to `out` (exposure in EV).
pub fn write_png(out: &mut impl Write, image: &Image, exposure: f32) -> io::Result<()> {
    let to_io = |error: png::EncodingError| io::Error::other(error.to_string());
    let mut encoder = png::Encoder::new(out, image.width, image.height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(to_io)?;
    let mut stream = writer.stream_writer().map_err(to_io)?;
    let scale = exposure.exp2();
    let width = image.width as usize;
    let mut line = vec![0u8; width * 3];
    for y in 0..image.height as usize {
        for (x, pixel) in image.beauty[y * width..(y + 1) * width].iter().enumerate() {
            let rgb = to_srgb8([pixel[0].to_f32(), pixel[1].to_f32(), pixel[2].to_f32()], scale);
            line[x * 3..x * 3 + 3].copy_from_slice(&rgb);
        }
        stream.write_all(&line)?;
    }
    stream.finish().map_err(to_io)?;
    writer.finish().map_err(to_io)
}

/// Passes bytes through to `inner` and hashes them (the sha256 of a streamed file without reading it back).
pub struct HashingWriter<W: Write> {
    pub inner: W,
    hasher: Sha256,
}

impl<W: Write> HashingWriter<W> {
    pub fn new(inner: W) -> HashingWriter<W> {
        HashingWriter { inner, hasher: Sha256::new() }
    }

    /// Lower-case hex digest (the `llull_protocol::sha256_hex` format).
    pub fn hex(self) -> String {
        self.hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(bytes)?;
        self.hasher.update(&bytes[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}
