//! PNG encoder of the native raster (PERF1 §5 row 10): byte for byte what `encodePng(width, height, rgba, true)` writes
//! (`packages/core/src/lib/png.ts` + `deflate.ts`): 8-bit RGBA, row 0 filter None and every other row filter Up, one zlib stream
//! (`78 01`, one final fixed-Huffman deflate block from LZ77 with 32 KiB hash chains of at most 24 candidates, Adler-32), one IDAT,
//! IEND. Same choices in the same order, so the bytes are identical and `render_view` can embed the native PNG unchanged.

const WINDOW: usize = 32768;
const MIN_MATCH: usize = 3;
const MAX_MATCH: usize = 258;
const MAX_CHAIN: usize = 24;
const HASH_SIZE: usize = 1 << 15;

const LENGTH_BASE: [u32; 29] =
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA: [u32; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE: [u32; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385,
    24577,
];
const DIST_EXTRA: [u32; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/// Least-significant-bit-first bit sink (the TypeScript `BitWriter`).
struct BitWriter {
    bytes: Vec<u8>,
    buffer: u32,
    count: u32,
}

impl BitWriter {
    fn bits(&mut self, value: u32, count: u32) {
        self.buffer |= value << self.count;
        self.count += count;
        while self.count >= 8 {
            self.bytes.push((self.buffer & 0xff) as u8);
            self.buffer >>= 8;
            self.count -= 8;
        }
    }

    /// A Huffman code, stored most significant bit first.
    fn code(&mut self, code: u32, count: u32) {
        self.bits(code.reverse_bits() >> (32 - count), count);
    }

    fn finish(mut self) -> Vec<u8> {
        if self.count > 0 {
            self.bytes.push((self.buffer & 0xff) as u8);
        }
        self.bytes
    }
}

/// Fixed literal/length code of symbol 0..287.
fn write_literal(out: &mut BitWriter, symbol: u32) {
    match symbol {
        0..=143 => out.code(0x30 + symbol, 8),
        144..=255 => out.code(0x190 + symbol - 144, 9),
        256..=279 => out.code(symbol - 256, 7),
        _ => out.code(0xc0 + symbol - 280, 8),
    }
}

fn index_of_base(bases: &[u32], value: u32) -> usize {
    let mut index = bases.len() - 1;
    while index > 0 && bases[index] > value {
        index -= 1;
    }
    index
}

fn write_match(out: &mut BitWriter, length: u32, distance: u32) {
    let length_index = index_of_base(&LENGTH_BASE, length);
    write_literal(out, 257 + length_index as u32);
    out.bits(length - LENGTH_BASE[length_index], LENGTH_EXTRA[length_index]);
    let distance_index = index_of_base(&DIST_BASE, distance);
    out.code(distance_index as u32, 5);
    out.bits(distance - DIST_BASE[distance_index], DIST_EXTRA[distance_index]);
}

fn hash_at(data: &[u8], at: usize) -> usize {
    ((usize::from(data[at]) << 10) ^ (usize::from(data[at + 1]) << 5) ^ usize::from(data[at + 2])) & (HASH_SIZE - 1)
}

/// Raw DEFLATE stream of `data`: the TypeScript `deflateRaw` (one final block, fixed Huffman codes, greedy LZ77).
pub fn deflate_raw(data: &[u8]) -> Vec<u8> {
    let mut out = BitWriter { bytes: Vec::with_capacity(data.len() / 8 + 64), buffer: 0, count: 0 };
    out.bits(1, 1);
    out.bits(1, 2);
    let mut head = vec![-1i64; HASH_SIZE];
    let mut previous = vec![-1i64; WINDOW];
    let insert = |head: &mut [i64], previous: &mut [i64], at: usize| {
        if at + MIN_MATCH > data.len() {
            return;
        }
        let hash = hash_at(data, at);
        previous[at % WINDOW] = head[hash];
        head[hash] = at as i64;
    };
    let mut at = 0usize;
    while at < data.len() {
        let (mut best_length, mut best_distance) = (0usize, 0usize);
        if at + MIN_MATCH <= data.len() {
            let mut candidate = head[hash_at(data, at)];
            let limit = MAX_MATCH.min(data.len() - at);
            let mut chain = 0;
            while candidate >= 0 && at - candidate as usize <= WINDOW && chain < MAX_CHAIN {
                let from = candidate as usize;
                let length = data[from..from + limit].iter().zip(&data[at..at + limit]).take_while(|(a, b)| a == b).count();
                if length > best_length {
                    best_length = length;
                    best_distance = at - from;
                    if length == limit {
                        break;
                    }
                }
                let next = previous[from % WINDOW];
                if next >= candidate {
                    break;
                }
                candidate = next;
                chain += 1;
            }
        }
        if best_length >= MIN_MATCH {
            write_match(&mut out, best_length as u32, best_distance as u32);
            for k in 0..best_length {
                insert(&mut head, &mut previous, at + k);
            }
            at += best_length;
        } else {
            write_literal(&mut out, u32::from(data[at]));
            insert(&mut head, &mut previous, at);
            at += 1;
        }
    }
    write_literal(&mut out, 256);
    out.finish()
}

fn adler32(bytes: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in bytes {
        a = (a + u32::from(byte)) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}

const CRC_TABLE: [u32; 256] = crc_table();

/// CRC-32 (IEEE 802.3, reflected) of PNG chunks.
pub fn crc32(bytes: &[u8]) -> u32 {
    !bytes.iter().fold(0xffff_ffffu32, |c, &byte| CRC_TABLE[((c ^ u32::from(byte)) & 0xff) as usize] ^ (c >> 8))
}

fn push_chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    png.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = png.len();
    png.extend_from_slice(kind);
    png.extend_from_slice(data);
    let crc = crc32(&png[start..]);
    png.extend_from_slice(&crc.to_be_bytes());
}

/// PNG bytes of a `width` × `height` RGBA image, as `encodePng(width, height, rgba, true)` writes them.
/// Panics when `rgba.len() != width * height * 4` (the callers check the image size first).
pub fn encode_png(width: usize, height: usize, rgba: &[u8]) -> Vec<u8> {
    assert_eq!(rgba.len(), width * height * 4, "rgba size");
    let stride = width * 4;
    let mut raw = vec![0u8; height * (stride + 1)];
    for y in 0..height {
        let row = &mut raw[y * (stride + 1)..(y + 1) * (stride + 1)];
        let pixels = &rgba[y * stride..(y + 1) * stride];
        if y == 0 {
            row[1..].copy_from_slice(pixels);
        } else {
            row[0] = 2;
            let above = &rgba[(y - 1) * stride..y * stride];
            for ((out, &value), &up) in row[1..].iter_mut().zip(pixels).zip(above) {
                *out = value.wrapping_sub(up);
            }
        }
    }
    let body = deflate_raw(&raw);
    let mut zlib = Vec::with_capacity(body.len() + 6);
    zlib.extend_from_slice(&[0x78, 0x01]);
    zlib.extend_from_slice(&body);
    zlib.extend_from_slice(&adler32(&raw).to_be_bytes());
    let mut header = [0u8; 13];
    header[0..4].copy_from_slice(&(width as u32).to_be_bytes());
    header[4..8].copy_from_slice(&(height as u32).to_be_bytes());
    header[8..13].copy_from_slice(&[8, 6, 0, 0, 0]);
    let mut png = Vec::with_capacity(zlib.len() + 64);
    png.extend_from_slice(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    push_chunk(&mut png, b"IHDR", &header);
    push_chunk(&mut png, b"IDAT", &zlib);
    push_chunk(&mut png, b"IEND", &[]);
    png
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Inflate of a fixed-Huffman stream: enough of RFC 1951 to read back what `deflate_raw` writes.
    fn inflate_fixed(stream: &[u8]) -> Vec<u8> {
        inflate_with_matches(stream).0
    }

    /// The inflated bytes and every (length, distance, output position) match of the stream.
    fn inflate_with_matches(stream: &[u8]) -> (Vec<u8>, Vec<(usize, usize, usize)>) {
        let mut matches = Vec::new();
        let mut bit = 0usize;
        let mut read = |count: u32| -> u32 {
            let mut value = 0;
            for i in 0..count {
                value |= u32::from((stream[bit / 8] >> (bit % 8)) & 1) << i;
                bit += 1;
            }
            value
        };
        assert_eq!(read(3), 0b011, "final fixed block");
        let mut out: Vec<u8> = Vec::new();
        loop {
            let mut code = 0u32;
            let mut length = 0;
            let symbol = loop {
                code = (code << 1) | read(1);
                length += 1;
                match (length, code) {
                    (7, 0..=0x17) => break code + 256,
                    (8, 0x30..=0xbf) => break code - 0x30,
                    (8, 0xc0..=0xc7) => break code - 0xc0 + 280,
                    (9, 0x190..=0x1ff) => break code - 0x190 + 144,
                    _ => assert!(length < 9, "bad code"),
                }
            };
            match symbol {
                0..=255 => out.push(symbol as u8),
                256 => return (out, matches),
                _ => {
                    let index = (symbol - 257) as usize;
                    let length = (LENGTH_BASE[index] + read(LENGTH_EXTRA[index])) as usize;
                    let mut d = 0u32;
                    for _ in 0..5 {
                        d = (d << 1) | read(1);
                    }
                    let distance = (DIST_BASE[d as usize] + read(DIST_EXTRA[d as usize])) as usize;
                    matches.push((length, distance, out.len()));
                    for _ in 0..length {
                        out.push(out[out.len() - distance]);
                    }
                }
            }
        }
    }

    fn noise(len: usize, seed: u32) -> Vec<u8> {
        let mut state = seed;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (state >> 24) as u8
            })
            .collect()
    }

    #[test]
    fn deflate_round_trips_flat_noisy_and_periodic_data() {
        let periodic: Vec<u8> = (0..200_000u32).map(|i| ((i % 40_000) / 7) as u8).collect();
        for data in [vec![], vec![7], vec![1, 2], vec![0; 100_000], noise(70_000, 9), periodic] {
            assert_eq!(inflate_fixed(&deflate_raw(&data)), data);
        }
    }

    #[test]
    fn matches_reach_the_window_edge_but_not_past_it() {
        for (distance, reaches) in [(32768usize, true), (32769, false)] {
            let mut data = noise(65536, 21);
            data.copy_within(1000..1300, 1000 + distance);
            let (out, matches) = inflate_with_matches(&deflate_raw(&data));
            assert_eq!(out, data);
            let far: Vec<_> = matches.iter().filter(|m| m.1 >= 32768).collect();
            assert_eq!(far.first().map(|m| (m.0, m.1, m.2)), reaches.then_some((258, 32768, 1000 + 32768)), "distance {distance}");
            assert!(matches.iter().all(|m| m.1 <= 32768));
        }
    }

    #[test]
    fn a_long_match_behind_more_than_24_newer_candidates_is_not_found() {
        let mut data = noise(2400, 5);
        let tail: Vec<u8> = (0..60u32).map(|k| ((k * 37 + 11) & 0xff) as u8).collect();
        for k in 0..=30usize {
            let at = 100 + k * 70;
            data[at..at + 3].copy_from_slice(&[0xab, 0xcd, 0xef]);
            if k == 0 || k == 30 {
                data[at + 3..at + 63].copy_from_slice(&tail);
            } else {
                data[at + 3] = (k * 5) as u8;
            }
        }
        let (out, matches) = inflate_with_matches(&deflate_raw(&data));
        assert_eq!(out, data);
        let last = 100 + 30 * 70;
        assert!(matches.iter().filter(|m| m.2 == last).all(|m| m.0 < 10), "{matches:?}");
        // with the cutoff lifted the oldest copy would match all 63 bytes: the cutoff is what the fixture pins
        assert!(matches.iter().all(|m| m.2 != last || m.1 != 30 * 70));
    }

    #[test]
    fn crc_and_adler_match_their_check_values() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(adler32(b"Wikipedia"), 0x11e6_0398);
        assert_eq!(adler32(&[]), 1);
    }

    #[test]
    fn png_layout_is_signature_ihdr_one_idat_iend_with_up_filtered_rows() {
        let rgba = noise(5 * 3 * 4, 3);
        let png = encode_png(5, 3, &rgba);
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 13, 10, 26, 10]);
        assert_eq!(&png[8..16], &[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
        assert_eq!(&png[16..29], &[0, 0, 0, 5, 0, 0, 0, 3, 8, 6, 0, 0, 0]);
        assert_eq!(&png[png.len() - 12..], &[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82]);
        let idat_length = u32::from_be_bytes([png[33], png[34], png[35], png[36]]) as usize;
        assert_eq!(&png[37..41], b"IDAT");
        let zlib = &png[41..41 + idat_length];
        assert_eq!(&zlib[..2], &[0x78, 0x01]);
        let raw = inflate_fixed(&zlib[2..zlib.len() - 4]);
        assert_eq!(u32::from_be_bytes(zlib[zlib.len() - 4..].try_into().unwrap()), adler32(&raw));
        assert_eq!(raw.len(), 3 * 21);
        assert_eq!((raw[0], raw[21], raw[42]), (0, 2, 2));
        assert_eq!(&raw[1..21], &rgba[..20]);
        assert_eq!(raw[22], rgba[20].wrapping_sub(rgba[0]));
        assert_eq!(41 + idat_length + 4 + 12, png.len());
    }

    #[test]
    #[should_panic(expected = "rgba size")]
    fn refuses_a_buffer_of_the_wrong_size() {
        encode_png(2, 2, &[0; 15]);
    }
}
