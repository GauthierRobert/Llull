//! GIF89a (TR-MOV-13): ONE global palette of 255 colours (NeuQuant over frames 0, n/4, n/2, 3n/4; index 255 is the transparent index), 8x8
//! Bayer ordered dither (a position-fixed threshold, so a static region gets the same indices in every frame: no temporal flicker), each frame
//! reduced to the rectangle that changed against the picture on screen (unchanged pixels transparent, disposal "keep"), delays by the
//! cumulative rule of `generate_mov_reference.py` (frame k ends at floor(100 (k + 1) / fps + 0.5) centiseconds), NETSCAPE2.0 loop 0 (forever).

use crate::pixels::Rgb;
use color_quant::NeuQuant;
use gif::{DisposalMethod, Encoder, Frame, Repeat};
use std::borrow::Cow;

/// Colours of the palette; the 256th index is the transparent one.
const PALETTE_COLOURS: usize = 255;
const TRANSPARENT: u8 = 255;
/// NeuQuant sampling factor (1 = every pixel, 30 = fastest): a CAD frame has few distinct colours, every 10th pixel learns them.
const SAMPLE_FACTOR: i32 = 10;
/// Peak dither offset per channel, in levels (+/- DITHER_SPREAD / 2).
const DITHER_SPREAD: i32 = 16;

const BAYER_8: [[u8; 8]; 8] = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
];

/// Indices of the frames whose pixels train the palette: 0, n/4, n/2, 3n/4 (distinct, ascending).
pub fn sample_frames(count: usize) -> Vec<usize> {
    let mut picks: Vec<usize> = [0, count / 4, count / 2, 3 * count / 4].into_iter().filter(|&k| k < count).collect();
    picks.dedup();
    picks
}

/// Delay in centiseconds of frame `k` at `fps`: the difference of the cumulative ends, so the error never drifts beyond 1 cs.
pub fn delay_cs(k: usize, fps: u32) -> u16 {
    let end = |j: usize| (200 * (j as u64 + 1) + u64::from(fps)) / (2 * u64::from(fps));
    let previous = if k == 0 { 0 } else { end(k - 1) };
    (end(k) - previous) as u16
}

/// The shared palette and a cache of the nearest index of every dithered colour.
struct Palette {
    quant: NeuQuant,
    /// 256 RGB triples (the last, the transparent index, is black).
    rgb: Vec<u8>,
    /// nearest palette index per 24-bit colour, `TRANSPARENT` while not yet looked up.
    nearest: Vec<u8>,
}

impl Palette {
    fn train(samples: &[&Rgb]) -> Self {
        let rgba: Vec<u8> = samples.iter().flat_map(|frame| frame.rgb.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255])).collect();
        let quant = NeuQuant::new(SAMPLE_FACTOR, PALETTE_COLOURS, &rgba);
        let mut rgb = quant.color_map_rgb();
        rgb.resize(256 * 3, 0);
        Self { quant, rgb, nearest: vec![TRANSPARENT; 1 << 24] }
    }

    fn index_of(&mut self, r: u8, g: u8, b: u8) -> u8 {
        let key = (usize::from(r) << 16) | (usize::from(g) << 8) | usize::from(b);
        if self.nearest[key] == TRANSPARENT {
            self.nearest[key] = self.quant.index_of(&[r, g, b, 255]) as u8;
        }
        self.nearest[key]
    }
}

/// Palette indices of `frame` with the ordered dither applied.
fn dithered(palette: &mut Palette, frame: &Rgb) -> Vec<u8> {
    let mut indices = Vec::with_capacity(frame.width * frame.height);
    for y in 0..frame.height {
        for x in 0..frame.width {
            let threshold = i32::from(BAYER_8[y % 8][x % 8]);
            // (2 t + 1) / 128 - 1/2 in (-1/2, 1/2): the offset of this cell of the 8x8 matrix, in levels
            let offset = ((2 * threshold + 1 - 64) * DITHER_SPREAD) / 128;
            let at = (y * frame.width + x) * 3;
            let adjust = |value: u8| (i32::from(value) + offset).clamp(0, 255) as u8;
            indices.push(palette.index_of(adjust(frame.rgb[at]), adjust(frame.rgb[at + 1]), adjust(frame.rgb[at + 2])));
        }
    }
    indices
}

/// Bounding box `(left, top, width, height)` of the positions where `next` differs from `shown`, `None` when they are equal.
fn changed_rectangle(shown: &[u8], next: &[u8], width: usize) -> Option<(usize, usize, usize, usize)> {
    let mut bounds: Option<(usize, usize, usize, usize)> = None;
    for (at, (a, b)) in shown.iter().zip(next).enumerate() {
        if a != b {
            let (x, y) = (at % width, at / width);
            bounds = Some(match bounds {
                None => (x, y, x, y),
                Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
            });
        }
    }
    bounds.map(|(x0, y0, x1, y1)| (x0, y0, x1 - x0 + 1, y1 - y0 + 1))
}

/// Streaming GIF writer: `push` every frame in order, then `finish`.
pub struct GifWriter {
    encoder: Encoder<Vec<u8>>,
    palette: Palette,
    fps: u32,
    width: usize,
    height: usize,
    shown: Option<Vec<u8>>,
    pushed: usize,
}

impl GifWriter {
    /// A writer for `width` x `height` frames whose palette is learned from `samples` (see [`sample_frames`]).
    pub fn new(width: usize, height: usize, fps: u32, samples: &[&Rgb]) -> Result<Self, String> {
        let palette = Palette::train(samples);
        let mut encoder =
            Encoder::new(Vec::new(), width as u16, height as u16, &palette.rgb).map_err(|error| format!("GIF header: {error}"))?;
        encoder.set_repeat(Repeat::Infinite).map_err(|error| format!("GIF loop block: {error}"))?;
        Ok(Self { encoder, palette, fps, width, height, shown: None, pushed: 0 })
    }

    /// Adds the next frame (the same size as the writer's).
    pub fn push(&mut self, frame: &Rgb) -> Result<(), String> {
        let indices = dithered(&mut self.palette, frame);
        let delay = delay_cs(self.pushed, self.fps);
        let (left, top, width, height, buffer) = match &self.shown {
            None => (0, 0, self.width, self.height, indices.clone()),
            Some(shown) => match changed_rectangle(shown, &indices, self.width) {
                // nothing moved: a 1 x 1 transparent frame carries the delay
                None => (0, 0, 1, 1, vec![TRANSPARENT]),
                Some((left, top, width, height)) => {
                    let mut cut = Vec::with_capacity(width * height);
                    for y in top..top + height {
                        for x in left..left + width {
                            let at = y * self.width + x;
                            cut.push(if shown[at] == indices[at] { TRANSPARENT } else { indices[at] });
                        }
                    }
                    (left, top, width, height, cut)
                }
            },
        };
        let out = Frame {
            left: left as u16,
            top: top as u16,
            width: width as u16,
            height: height as u16,
            delay,
            dispose: DisposalMethod::Keep,
            transparent: Some(TRANSPARENT),
            buffer: Cow::Owned(buffer),
            ..Frame::default()
        };
        self.encoder.write_frame(&out).map_err(|error| format!("GIF frame {}: {error}", self.pushed))?;
        self.shown = Some(indices);
        self.pushed += 1;
        Ok(())
    }

    /// The finished file.
    pub fn finish(self) -> Result<Vec<u8>, String> {
        self.encoder.into_inner().map_err(|error| format!("GIF trailer: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays_follow_the_cumulative_rule_and_never_drift() {
        let at = |fps: u32, n: usize| (0..n).map(|k| delay_cs(k, fps)).collect::<Vec<_>>();
        assert_eq!(at(10, 4), [10, 10, 10, 10]);
        assert_eq!(at(30, 6), [3, 4, 3, 3, 4, 3]);
        assert_eq!(at(24, 5), [4, 4, 5, 4, 4]);
        // 40 fps: 2.5 cs per frame, ends floor(2.5 (k + 1) + 0.5) = 3, 5, 8, 10
        assert_eq!(at(40, 4), [3, 2, 3, 2]);
        for fps in [1u32, 7, 24, 25, 30, 50, 60] {
            let total: u64 = (0..fps as usize * 10).map(|k| u64::from(delay_cs(k, fps))).sum();
            assert_eq!(total, 1000, "10 s at {fps} fps");
        }
    }

    #[test]
    fn samples_are_quarter_points_without_repeats() {
        assert_eq!(sample_frames(1), [0]);
        assert_eq!(sample_frames(3), [0, 1, 2]);
        assert_eq!(sample_frames(8), [0, 2, 4, 6]);
        assert_eq!(sample_frames(0), Vec::<usize>::new());
    }

    #[test]
    fn changed_rectangle_is_the_bounding_box() {
        let shown = vec![0u8; 20];
        let mut next = shown.clone();
        assert_eq!(changed_rectangle(&shown, &next, 5), None);
        next[7] = 1; // (2, 1)
        next[13] = 1; // (3, 2)
        assert_eq!(changed_rectangle(&shown, &next, 5), Some((2, 1, 2, 2)));
    }
}
