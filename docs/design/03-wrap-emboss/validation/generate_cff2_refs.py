#!/usr/bin/env python3
"""WRP reference data for the pinned real CFF2 variable font (Source Sans 3 VF Italic, OFL-1.1; sources.md R28), from fontTools.

  python3 -m venv venv && venv/bin/pip install fonttools==4.68.0 uharfbuzz==0.57.0
  venv/bin/python generate_cff2_refs.py [path/to/SourceSans3VF-Italic.otf]   (default: data/reference/sourcesans3/SourceSans3VF-Italic.otf)
  writes data/cff2_sourcesans3_italic_refs.json

Per instance (wght user coordinates) and glyph:
  outline        the CFF2 charstring drawn at the location by fontTools (`getGlyphSet(location=...)`: blends evaluated in floating point, not rounded)
  outlineStatic  the same glyph of the STATIC instance made by `fontTools.varLib.instancer` (coordinates rounded to font units, as when it is compiled)
  advance        `hmtx` of that static instance (HVAR applied and rounded by the instancer)
kerning        HarfBuzz (uharfbuzz) `kern` feature at the location: x advance of the first glyph with kern minus without, for KERN_PAIRS (GPOS pair adjustment + GDEF variation store)
Contours are lists of segments: ["M", x, y] / ["L", x, y] / ["C", x1, y1, x2, y2, x, y] (fontTools RecordingPen, closePath implied).
"""

import hashlib
import json
import sys
from pathlib import Path

import fontTools
import uharfbuzz as hb
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

here = Path(__file__).resolve().parent
path = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "data/reference/sourcesans3/SourceSans3VF-Italic.otf"
sha256 = hashlib.sha256(path.read_bytes()).hexdigest()

COORDS = [200, 300, 400, 500, 650, 700, 900]
OUTLINE_CHARS = "HogaAg&f1ß"
KERN_PAIRS = ["AV", "To", "Te", "Wa", "LT", "r.", "fi", "AT", "P,", "Yo", "ij", "7."]
ADVANCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,&@fi"


def draw(glyph_set, name):
    pen = RecordingPen()
    glyph_set[name].draw(pen)
    contours, current = [], None
    for op, args in pen.value:
        if op == "moveTo":
            current = [["M", *args[0]]]
        elif op == "lineTo":
            current.append(["L", *args[0]])
        elif op == "curveTo":
            current.append(["C", *[v for p in args for v in p]])
        elif op in ("closePath", "endPath"):
            contours.append(current)
            current = None
        else:
            raise SystemExit(f"unexpected pen op {op}")
    return contours


def rounded(contours, digits):
    return [[[seg[0], *[round(v, digits) for v in seg[1:]]] for seg in contour] for contour in contours]



def kerning_at(hb_font, wght, pair):
    hb_font.set_variations({"wght": wght})
    return kerning(hb_font, pair)


def kerning(hb_font, pair):
    shaped = []
    for kern in (True, False):
        buf = hb.Buffer()
        buf.add_str(pair)
        buf.guess_segment_properties()
        features = {"kern": kern, "liga": False, "calt": False, "ccmp": False, "locl": False, "mark": False, "mkmk": False}
        hb.shape(hb_font, buf, features)
        shaped.append([pos.x_advance for pos in buf.glyph_positions])
    assert len(shaped[0]) == 2
    return shaped[0][0] - shaped[1][0]


hb_font = hb.Font(hb.Face(hb.Blob.from_file_path(str(path))))
font = TTFont(path)
cmap = font.getBestCmap()
order = font.getGlyphOrder()
names = {ch: cmap[ord(ch)] for ch in set(OUTLINE_CHARS + ADVANCE_CHARS)}
fvar = font["fvar"]
name_table = font["name"]
out = {
    "fontTools": fontTools.version,
    "uharfbuzz": hb.__version__,
    "script": "docs/design/03-wrap-emboss/validation/generate_cff2_refs.py",
    "font": {"file": "SourceSans3VF-Italic.otf", "sha256": sha256},
    "axes": [[a.axisTag, a.minValue, a.defaultValue, a.maxValue] for a in fvar.axes],
    "namedInstances": [
        {"name": name_table.getDebugName(i.subfamilyNameID), "postScriptName": name_table.getDebugName(i.postscriptNameID) if i.postscriptNameID != 0xFFFF else None, "coordinates": i.coordinates}
        for i in fvar.instances
    ],
    "unitsPerEm": font["head"].unitsPerEm,
    "numGlyphs": font["maxp"].numGlyphs,
    "tables": sorted(k for k in font.keys() if k != "GlyphOrder"),
    "glyphIndex": {ch: order.index(names[ch]) for ch in sorted(names)},
    "instances": {},
}
for wght in COORDS:
    static = instancer.instantiateVariableFont(TTFont(path), {"wght": wght})
    live = font.getGlyphSet(location={"wght": wght})
    static_set = static.getGlyphSet()
    out["instances"][str(wght)] = {
        "hhea": [static["hhea"].ascent, static["hhea"].descent, static["hhea"].lineGap],
        "os2": {"sCapHeight": static["OS/2"].sCapHeight, "sxHeight": static["OS/2"].sxHeight},
        "kerning": {pair: kerning_at(hb_font, wght, pair) for pair in KERN_PAIRS},
        "advance": {ch: static["hmtx"][names[ch]][0] for ch in sorted(names)},
        "outline": {ch: rounded(draw(live, names[ch]), 4) for ch in OUTLINE_CHARS},
        "outlineStatic": {ch: draw(static_set, names[ch]) for ch in OUTLINE_CHARS},
    }
Path(here / "data/cff2_sourcesans3_italic_refs.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf8")
print("ok", fontTools.version, sha256)
