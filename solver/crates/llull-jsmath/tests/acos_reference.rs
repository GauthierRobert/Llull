//! Bit-exact check of acos against node (V8) `Math.acos`: bit patterns from `data/gen_acos_corpus.mjs` (regenerate with `node tests/data/gen_acos_corpus.mjs > tests/data/acos_corpus.txt`).

use llull_jsmath::acos;

#[test]
fn acos_matches_v8_bit_for_bit() {
    let text = include_str!("data/acos_corpus.txt");
    let mut checked = 0;
    for line in text.lines().filter(|l| !l.starts_with('#') && !l.is_empty()) {
        let w: Vec<u64> = line.split(' ').map(|h| u64::from_str_radix(h, 16).expect("hex word")).collect();
        let x = f64::from_bits(w[0]);
        let got = acos(x);
        if got.is_nan() {
            assert!(f64::from_bits(w[1]).is_nan(), "acos({x:e}) is NaN in V8 too");
        } else {
            assert_eq!(got.to_bits(), w[1], "acos({x:e})");
        }
        checked += 1;
    }
    assert_eq!(checked, 6017);
}
