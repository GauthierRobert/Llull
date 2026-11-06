//! Own ISOBMFF writer for one AV1 video track: `ftyp` (isom / iso6 / av01 / mp41), `moov` BEFORE `mdat` (streams / progressive download),
//! `stts` one delta of 1 at timescale `fps`, `stss` keyframes, one chunk. Every box is a `Vec<u8>` built from its parts.

use crate::av1::Packet;

fn u32b(value: u32) -> Vec<u8> {
    value.to_be_bytes().to_vec()
}

fn u16b(value: u16) -> Vec<u8> {
    value.to_be_bytes().to_vec()
}

/// A box: size, four-character type, body.
fn boxed(kind: &str, parts: &[Vec<u8>]) -> Vec<u8> {
    let body: Vec<u8> = parts.concat();
    [u32b(8 + body.len() as u32), kind.as_bytes().to_vec(), body].concat()
}

/// A full box: version (high byte) and flags (low 24 bits) first.
fn full(kind: &str, version_flags: u32, parts: &[Vec<u8>]) -> Vec<u8> {
    let mut all = vec![u32b(version_flags)];
    all.extend_from_slice(parts);
    boxed(kind, &all)
}

/// The identity transformation matrix of `mvhd` / `tkhd`.
const MATRIX: [u8; 36] = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0];

fn sample_entry(width: u16, height: u16, av1c: &[u8]) -> Vec<u8> {
    // colr 'nclx': BT.709 primaries / transfer / matrix, limited range
    let colr = boxed("colr", &[b"nclx".to_vec(), u16b(1), u16b(1), u16b(1), vec![0]]);
    boxed(
        "av01",
        &[
            vec![0; 6],
            u16b(1),
            vec![0; 16],
            u16b(width),
            u16b(height),
            u32b(0x0048_0000),
            u32b(0x0048_0000),
            u32b(0),
            u16b(1),
            vec![0; 32],
            u16b(0x18),
            u16b(0xffff),
            boxed("av1C", &[av1c.to_vec()]),
            colr,
        ],
    )
}

/// `moov` for `packets` with the sample data starting at byte `data_offset` of the file.
fn moov(width: u16, height: u16, fps: u32, packets: &[Packet], av1c: &[u8], data_offset: u32) -> Vec<u8> {
    let count = packets.len() as u32;
    let mvhd = full(
        "mvhd",
        0,
        &[u32b(0), u32b(0), u32b(fps), u32b(count), u32b(0x0001_0000), u16b(0x100), vec![0; 10], MATRIX.to_vec(), vec![0; 24], u32b(2)],
    );
    let tkhd = full(
        "tkhd",
        3,
        &[
            u32b(0),
            u32b(0),
            u32b(1),
            u32b(0),
            u32b(count),
            vec![0; 8],
            u16b(0),
            u16b(0),
            u16b(0),
            u16b(0),
            MATRIX.to_vec(),
            u32b(u32::from(width) << 16),
            u32b(u32::from(height) << 16),
        ],
    );
    let mdhd = full("mdhd", 0, &[u32b(0), u32b(0), u32b(fps), u32b(count), u16b(0x55c4), u16b(0)]);
    let hdlr = full("hdlr", 0, &[u32b(0), b"vide".to_vec(), vec![0; 12], b"llull video\0".to_vec()]);
    let vmhd = full("vmhd", 1, &[vec![0; 8]]);
    let dinf = boxed("dinf", &[full("dref", 0, &[u32b(1), full("url ", 1, &[])])]);
    let stsd = full("stsd", 0, &[u32b(1), sample_entry(width, height, av1c)]);
    let stts = full("stts", 0, &[u32b(1), u32b(count), u32b(1)]);
    let keys: Vec<u8> = packets.iter().enumerate().filter(|(_, p)| p.key).flat_map(|(i, _)| u32b(i as u32 + 1)).collect();
    let stss = full("stss", 0, &[u32b((keys.len() / 4) as u32), keys]);
    let stsc = full("stsc", 0, &[u32b(1), u32b(1), u32b(count), u32b(1)]);
    let sizes: Vec<u8> = packets.iter().flat_map(|p| u32b(p.data.len() as u32)).collect();
    let stsz = full("stsz", 0, &[u32b(0), u32b(count), sizes]);
    let stco = full("stco", 0, &[u32b(1), u32b(data_offset)]);
    let stbl = boxed("stbl", &[stsd, stts, stss, stsc, stsz, stco]);
    let minf = boxed("minf", &[vmhd, dinf, stbl]);
    let mdia = boxed("mdia", &[mdhd, hdlr, minf]);
    boxed("moov", &[mvhd, boxed("trak", &[tkhd, mdia])])
}

/// Largest file the 32-bit box sizes and the 32-bit `stco` offset can describe.
const MAX_FILE_BYTES: u64 = u32::MAX as u64;

/// Error text when a file of `total` bytes does not fit the 32-bit boxes, else None.
fn size_refusal(total: u64) -> Option<String> {
    (total >= MAX_FILE_BYTES).then(|| format!("the MP4 would be {total} bytes: files of 4 GiB or more need 64-bit boxes, which this muxer does not write (lower the size, fps or duration)"))
}

/// The file of `packets` (decode order = display order) as `width` x `height` AV1 at `fps` frames per second.
/// A string describes the refusal of a file of 4 GiB or more.
pub fn mux(width: usize, height: usize, fps: u32, packets: &[Packet], av1c: &[u8]) -> Result<Vec<u8>, String> {
    // generous allowance for ftyp + moov (about 12 bytes of sample tables per frame plus the headers)
    let data_bytes: u64 = packets.iter().map(|p| p.data.len() as u64).sum();
    if let Some(refusal) = size_refusal(data_bytes + 16 * packets.len() as u64 + 4096) {
        return Err(refusal);
    }
    let ftyp = boxed("ftyp", &[b"isom".to_vec(), u32b(0x200), b"isomiso6av01mp41".to_vec()]);
    let (w, h) = (width as u16, height as u16);
    // the chunk offset sits inside moov: its size does not depend on the value, so one pass measures it
    let measured = moov(w, h, fps, packets, av1c, 0);
    let data_offset = (ftyp.len() + measured.len() + 8) as u32;
    let moov = moov(w, h, fps, packets, av1c, data_offset);
    let data: Vec<u8> = packets.iter().flat_map(|p| p.data.iter().copied()).collect();
    Ok([ftyp, moov, boxed("mdat", &[data])].concat())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_of_4_gib_or_more_are_refused_with_a_reason_and_smaller_ones_pass() {
        assert!(size_refusal(u64::from(u32::MAX) - 1).is_none());
        assert!(size_refusal(u64::from(u32::MAX)).unwrap().contains("4 GiB"));
        assert!(size_refusal(6_000_000_000).is_some());
    }

    #[test]
    fn a_tiny_clip_is_muxed() {
        let packets = vec![Packet { data: vec![1, 2, 3], key: true }];
        let file = mux(64, 64, 30, &packets, &[0x81, 0, 0, 0]).unwrap();
        assert_eq!(&file[4..8], b"ftyp");
    }
}
