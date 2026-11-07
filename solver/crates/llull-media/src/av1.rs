//! AV1 encoding with rav1e 0.8.1 (BSD-2-Clause, AOM patent licence): 4:2:0 8-bit BT.709 limited range, a keyframe at least every 2 s, a fixed
//! tile layout (4 columns x 2 rows) so the packet stream does not depend on the thread count (measured at M0, spec §13.2: identical bytes
//! for 1 / 4 / 8 / 16 threads; tiles are what makes the threads useful at all).

use crate::yuv::Yuv420;
use rav1e::prelude::*;

/// Encoding preset of a quality: rav1e speed and fixed quantizer (0 best .. 255 smallest).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Preset {
    pub speed: u8,
    pub quantizer: usize,
}

/// `draft` and `standard` share speed 10 (the 20 s budget of §8, measured at M2); `high` is speed 6 with a finer quantizer.
pub fn preset(quality: &str) -> Option<Preset> {
    match quality {
        "draft" => Some(Preset { speed: 10, quantizer: 140 }),
        "standard" => Some(Preset { speed: 10, quantizer: 100 }),
        "high" => Some(Preset { speed: 6, quantizer: 80 }),
        _ => None,
    }
}

/// One encoded temporal unit, temporal-delimiter OBU removed (ISOBMFF samples do not carry it).
pub struct Packet {
    pub data: Vec<u8>,
    pub key: bool,
}

pub struct Encoded {
    pub packets: Vec<Packet>,
    /// The `av1C` payload `container_sequence_header()` gives: the 4 configuration bytes (profile, level, chroma); the sequence header OBU stays in the first sample.
    pub av1c: Vec<u8>,
}

/// Streaming encoder: frames in, packets out.
pub struct Av1Encoder {
    context: Context<u8>,
    packets: Vec<Packet>,
    width: usize,
}

fn config(width: usize, height: usize, fps: u32, preset: Preset) -> EncoderConfig {
    let mut config = EncoderConfig::with_speed_preset(preset.speed);
    config.width = width;
    config.height = height;
    config.bit_depth = 8;
    config.chroma_sampling = ChromaSampling::Cs420;
    config.time_base = Rational::new(1, u64::from(fps));
    config.pixel_range = PixelRange::Limited;
    config.color_description = Some(ColorDescription {
        color_primaries: ColorPrimaries::BT709,
        transfer_characteristics: TransferCharacteristics::BT709,
        matrix_coefficients: MatrixCoefficients::BT709,
    });
    config.min_key_frame_interval = 0;
    config.max_key_frame_interval = u64::from(2 * fps);
    config.quantizer = preset.quantizer;
    config.tile_cols = 4;
    config.tile_rows = 2;
    config
}

/// A packet without its temporal delimiter (`0x12 0x00`).
fn strip_delimiter(data: &[u8]) -> Vec<u8> {
    if data.len() >= 2 && data[0] == 0x12 && data[1] == 0 {
        data[2..].to_vec()
    } else {
        data.to_vec()
    }
}

impl Av1Encoder {
    /// `width` and `height` must be even. `threads` of 0 is 1.
    pub fn new(width: usize, height: usize, fps: u32, preset: Preset, threads: usize) -> Result<Self, String> {
        let configuration = Config::new().with_encoder_config(config(width, height, fps, preset)).with_threads(threads.max(1));
        let context = configuration.new_context().map_err(|error| format!("rav1e refused the configuration: {error}"))?;
        Ok(Self { context, packets: Vec::new(), width })
    }

    fn drain(&mut self) -> Result<(), String> {
        loop {
            match self.context.receive_packet() {
                Ok(packet) => self.packets.push(Packet { data: strip_delimiter(&packet.data), key: packet.frame_type == FrameType::KEY }),
                Err(EncoderStatus::Encoded) => {}
                Err(EncoderStatus::NeedMoreData | EncoderStatus::LimitReached) => return Ok(()),
                Err(error) => return Err(format!("rav1e failed: {error:?}")),
            }
        }
    }

    /// Feeds one picture; completed packets are collected.
    pub fn push(&mut self, planes: &Yuv420) -> Result<(), String> {
        let mut frame = self.context.new_frame();
        frame.planes[0].copy_from_raw_u8(&planes.y, self.width, 1);
        frame.planes[1].copy_from_raw_u8(&planes.u, self.width / 2, 1);
        frame.planes[2].copy_from_raw_u8(&planes.v, self.width / 2, 1);
        self.context.send_frame(frame).map_err(|error| format!("rav1e rejected a frame: {error:?}"))?;
        self.drain()
    }

    /// Flushes the encoder and returns every packet with the `av1C` payload.
    pub fn finish(mut self) -> Result<Encoded, String> {
        self.context.flush();
        self.drain()?;
        Ok(Encoded { av1c: self.context.container_sequence_header(), packets: self.packets })
    }
}
