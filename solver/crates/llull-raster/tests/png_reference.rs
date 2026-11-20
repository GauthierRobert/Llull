//! Native PNG encoder vs `encodePng(…, true)` (PERF1 §5 row 10): `tests/unit/native/pngReference.test.ts` writes RGBA images reaching every
//! deflate branch and the sha256 of the PNG the TypeScript writes for each; `png::encode_png` must write the same bytes.

use llull_protocol::sha256_hex;
use serde_json::Value;
use std::fs;

fn base64(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => u32::from(c - b'A'),
        b'a'..=b'z' => u32::from(c - b'a') + 26,
        b'0'..=b'9' => u32::from(c - b'0') + 52,
        b'+' => 62,
        _ => 63,
    };
    let mut out = Vec::new();
    for group in text.as_bytes().chunks(4) {
        let digits: Vec<u8> = group.iter().copied().filter(|&c| c != b'=').collect();
        let bits = digits.iter().enumerate().fold(0u32, |acc, (i, &c)| acc | value(c) << (18 - 6 * i));
        out.extend_from_slice(&bits.to_be_bytes()[1..digits.len()]);
    }
    out
}

#[test]
fn native_png_is_byte_identical_to_the_typescript_encoder() {
    let text = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/png.json")).unwrap();
    let cases: Value = serde_json::from_str(&text).unwrap();
    let cases = cases.as_array().unwrap();
    assert_eq!(cases.len(), 9);
    for case in cases {
        let (width, height) = (case["width"].as_u64().unwrap() as usize, case["height"].as_u64().unwrap() as usize);
        let rgba = base64(case["rgbaBase64"].as_str().unwrap());
        assert_eq!(rgba.len(), width * height * 4, "{}", case["name"]);
        let png = llull_raster::png::encode_png(width, height, &rgba);
        assert_eq!(sha256_hex(&png), case["pngSha256"].as_str().unwrap(), "{}: PNG differs from encodePng(…, true)", case["name"]);
    }
}
