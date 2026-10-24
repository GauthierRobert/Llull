//! Bit-exact check of sin / cos / atan2 against node (V8) Math, bit patterns: (x, y, sin x, cos x, atan2(y, x)).
#![allow(clippy::approx_constant)] // the cases are literal V8 inputs (pi/2, pi, 2 pi, pi/4)

use llull_jsmath::{atan2, cos, sin};

const CASES: &[(f64, f64, u64, u64, u64)] = &[
    (310.30809693038464_f64, -3.9037132263183594_f64, 0x3fe4d92fafa3d34b, 0xbfe846c3e522e70f, 0xbf89c3421dddb11b),
    (28.605995178222656_f64, 5.8551788330078125_f64, 0xbfd4d6dd18879412, 0xbfee418ee4909505, 0x3fc9d7b1b58f6d52),
    (-1.7403266429901123_f64, 0.6025773286819458_f64, 0xbfef8a8f7b3f5004, 0xbfc598990d94534f, 0x4006775538cabf2e),
    (-877.7155876159668_f64, 2.916589379310608_f64, 0x3fedf4237517d57e, 0xbfd684e635b752fd, 0x40091b2d297fc375),
    (7.874772548675537_f64, -7.20956563949585_f64, 0x3feffe3ac1b256b4, 0xbf9549d2266599dc, 0xbfe7b8f48841dacf),
    (0.7786045074462891_f64, -0.6908988952636719_f64, 0x3fe67921dfbdfbe2, 0x3fe6c7d67c31de9c, 0xbfe739a18a256c08),
    (144.26541328430176_f64, 8.854639530181885_f64, 0xbfcf669d4e9788b5, 0x3fef05ac1126edcd, 0x3faf62c84b9f9c2f),
    (-7.000771164894104_f64, -9.072237014770508_f64, 0xbfe50acb991c758c, 0x3fe81bd0a38f7f2e, 0xc001d2fd7127727b),
    (0.3424873352050781_f64, 5.3942108154296875_f64, 0x3fd57e4153d7287e, 0x3fee243a248a356c, 0x3ff81e44c13e4263),
    (-659.4939231872559_f64, -2.21984326839447_f64, 0x3fce7e0989529e77, 0x3fef1428dacee827, 0xc0091b1697cd57f0),
    (-6.252193450927734_f64, -9.262523651123047_f64, 0x3f9fbb0756905fff, 0x3feffc10edae8be3, 0xc00150fd19b78928),
    (-1.103926420211792_f64, -6.873180866241455_f64, 0xbfec934ded7598a5, 0x3fdcce547618f4ab, 0xbffbae48badf24b9),
    (-0.4906654357910156_f64, -7.885785102844238_f64, 0xbfde285a3bfde6d2, 0x3fec3980f10e99c2, 0xbffa20834e493eaf),
    (26.3826584815979_f64, -0.6426072120666504_f64, 0x3fee5dde4447282d, 0x3fd42f8733c3679a, 0xbf98efd3ac38bf70),
    (2.1732725501060486_f64, 1.9402837753295898_f64, 0x3fea5dacbbf315c3, 0xbfe22247706fbd58, 0x3fe7527cf87533cc),
    (-376.10048055648804_f64, 0.5410075187683105_f64, 0x3fe8e10f36ea7123, 0x3fe42014eb00ef64, 0x40091f0928d8552b),
    (15.468435287475586_f64, -1.3247966766357422_f64, 0x3fce5e03d5ad4f46, 0xbfef161e7363e76b, 0xbfb5df2d8fdc3b7f),
    (1.1029817461967468_f64, -7.050449848175049_f64, 0x3fec8fd1669de900, 0x3fdcdc25d598be58, 0xbff6a659a115f399),
    (628.592312335968_f64, -4.47446346282959_f64, 0x3fd14dcf4ffc0d96, 0x3feecee444a4c455, 0xbf7d27e088f72f0d),
    (-29.45676326751709_f64, 8.646407648921013_f64, 0x3fed9dee5b30b437, 0xbfd83c407645ba6d, 0x4006d94231850b68),
    (0.34576892852783203_f64, 6.259374618530273_f64, 0x3fd5b0de5679360c, 0x3fee1b28525f2729, 0x3ff83ff29ee58fdc),
    (-856.1859130859375_f64, 3.5543447732925415_f64, 0xbfefd57e37a78015, 0xbfba0b8b46cebff0, 0x4009197ad3fa1b59),
    (3.2934021949768066_f64, 3.3579039573669434_f64, 0xbfc35b68efc2469a, 0xbfefa1c8bfac43a4, 0x3fe9716c0cee5d5b),
    (-0.6975216865539551_f64, 3.898777961730957_f64, 0xbfe48de31353d548, 0x3fe886a5a683a629, 0x3ffbf71dc27e24d5),
    (-557.5121641159058_f64, -3.7483245134353638_f64, 0x3fefc490c966a48a, 0xbfbec810d707e764, 0xc00914366f1835f5),
    (1.5707963267948966_f64, 1.3_f64, 0x3ff0000000000000, 0x3c91a62633145c07, 0x3fe61f86e3e8b1ca),
    (3.141592653589793_f64, 1.3_f64, 0x3ca1a62633145c07, 0xbff0000000000000, 0x3fd91c3cbf3f59ca),
    (4.71238898038469_f64, 1.3_f64, 0xbff0000000000000, 0xbcaa79394c9e8a0a, 0x3fd13a239f79352f),
    (6.283185307179586_f64, 1.3_f64, 0xbcb1a62633145c07, 0x3ff0000000000000, 0x3fca1d6a10da7314),
    (31.41592653589793_f64, 1.3_f64, 0xbcd60fafbfd97309, 0x3ff0000000000000, 0x3fa52cb442e86204),
    (157.07963267948966_f64, 1.3_f64, 0x3cd1b19140c0c0d5, 0x3ff0000000000000, 0x3f80f2f036999ac6),
    (0.7853981633974483_f64, 1.3_f64, 0x3fe6a09e667f3bcc, 0x3fe6a09e667f3bcd, 0x3ff06ff0b358bd13),
    (1e-9_f64, 1.3_f64, 0x3e112e0be826d695, 0x3ff0000000000000, 0x3ff921fb540f50a5),
    (0.3_f64, 1.3_f64, 0x3fd2e9cd95baba33, 0x3fee921dd42f09ba, 0x3ff58103801195e6),
    (0.5_f64, 1.3_f64, 0x3fdeaee8744b05f0, 0x3fec1528065b7d50, 0x3ff34209a8c10980),
    (-1.5707963267948966_f64, 1.3_f64, 0xbff0000000000000, 0x3c91a62633145c07, 0x40039a199b4a00a6),
];

#[test]
fn sin_cos_atan2_match_v8_bit_for_bit() {
    for &(x, y, s, c, a) in CASES {
        assert_eq!(sin(x).to_bits(), s, "sin({x:e})");
        assert_eq!(cos(x).to_bits(), c, "cos({x:e})");
        assert_eq!(atan2(y, x).to_bits(), a, "atan2({y:e}, {x:e})");
    }
}

#[test]
fn randomized_corpus_matches_v8_bit_for_bit() {
    let text = include_str!("data/trig_corpus.txt");
    let mut checked = 0;
    for line in text.lines().filter(|l| !l.starts_with('#') && !l.is_empty()) {
        let w: Vec<u64> = line.split(' ').map(|h| u64::from_str_radix(h, 16).expect("hex word")).collect();
        let (x, y) = (f64::from_bits(w[0]), f64::from_bits(w[1]));
        assert_eq!(sin(x).to_bits(), w[2], "sin({x:e})");
        assert_eq!(cos(x).to_bits(), w[3], "cos({x:e})");
        assert_eq!(atan2(y, x).to_bits(), w[4], "atan2({y:e}, {x:e})");
        checked += 1;
    }
    assert_eq!(checked, 4000);
}

#[test]
fn arguments_beyond_the_reduction_bound_are_flagged() {
    let _ = llull_jsmath::take_platform_fallback();
    let _ = sin(1.0e3);
    assert!(!llull_jsmath::take_platform_fallback(), "inside the bound nothing is flagged");
    let _ = cos(1.0e7);
    assert!(llull_jsmath::take_platform_fallback(), "beyond 2^19 pi / 2 the platform answer is flagged");
    assert!(!llull_jsmath::take_platform_fallback(), "reading resets the flag");
}
