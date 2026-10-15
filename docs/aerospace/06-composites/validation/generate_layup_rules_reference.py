#!/usr/bin/env python3
"""Stacking-notation parsing + laminate design-rule reference cases for llull gap CMP.

    python3 generate_layup_rules_reference.py          # writes layup_rules_reference.json
    python3 generate_layup_rules_reference.py --check

Notation (TECHNICAL_SPEC 5.1, after NASA RP-1351 / Jones ch. 4 nomenclature): plies listed bottom -> top
inside [...], separated by '/'; '+-a' or '±a' expands to +a/-a; '(group)n' or 'an' repeats n times (written
'0_2' here to avoid ambiguity: subscript = '_n'); suffix 's' mirrors (symmetric), 'Ns' = repeat N then mirror,
'T' = total (as written); a trailing '~' on the last ply before 's' marks a middle ply that is NOT duplicated
(the textbook overbar).

Rules (configurable thresholds; the defaults below are the commonly published industry guidelines, see
FUNCTIONAL_SPEC FR-CMP-20 and validation/sources.md S15-S17 - NOT quoted CMH-17 clause text):
  R1 symmetric  : angles == reversed(angles)
  R2 balanced   : for every a not in {0, 90}: count(+a) == count(-a)
  R3 10% rule   : each of 0, +45/-45 (together), 90 >= 10 % of plies
  R4 contiguity : no more than 4 consecutive plies of the same angle
  R5 outer ±45  : both outer plies are +45 or -45 (damage tolerance guideline)
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

OUT = Path(__file__).with_name("layup_rules_reference.json")


def _split_top(s):
    parts, depth, cur = [], 0, ""
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "/" and depth == 0:
            parts.append(cur); cur = ""
        else:
            cur += ch
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


def _expand(tok):
    m = re.fullmatch(r"\((.*)\)_(\d+)", tok)
    if m:
        inner = []
        for t in _split_top(m.group(1)):
            inner += _expand(t)
        return inner * int(m.group(2))
    m = re.fullmatch(r"(\+-|±)(\d+(?:\.\d+)?)(?:_(\d+))?", tok)
    if m:
        a = float(m.group(2)); n = int(m.group(3) or 1)
        return [a, -a] * n
    m = re.fullmatch(r"(-?\d+(?:\.\d+)?)(?:_(\d+))?", tok)
    if m:
        return [float(m.group(1))] * int(m.group(2) or 1)
    raise ValueError(f"bad token {tok!r}")


def parse(notation):
    m = re.fullmatch(r"\[(.*)\](?:_)?(\d*)(s|T)?", notation.replace(" ", ""))
    if not m:
        raise ValueError(f"bad notation {notation!r}")
    body, rep, kind = m.group(1), m.group(2), m.group(3) or "T"
    toks = _split_top(body)
    middle = toks and toks[-1].endswith("~")
    if middle:
        toks[-1] = toks[-1][:-1]
    angles = []
    for t in toks:
        angles += _expand(t)
    if kind == "s":
        half = angles * (int(rep) if rep else 1)
        if middle:
            return half + half[-2::-1]
        return half + half[::-1]
    return angles * (int(rep) if rep else 1)


def norm_angle(a):
    a = ((a + 90.0) % 180.0) - 90.0
    return 90.0 if a == -90.0 else a


def rules(angles, max_run=4, min_frac=0.10):
    a = [norm_angle(x) for x in angles]; n = len(a)
    sym = a == a[::-1]
    off = sorted({abs(x) for x in a if x not in (0.0, 90.0)})
    bal = all(a.count(x) == a.count(-x) for x in off)
    frac = {"0": a.count(0.0) / n, "pm45": (a.count(45.0) + a.count(-45.0)) / n, "90": a.count(90.0) / n}
    ten = all(v >= min_frac - 1e-12 for v in frac.values())
    run, best = 1, 1
    for i in range(1, n):
        run = run + 1 if a[i] == a[i - 1] else 1
        best = max(best, run)
    outer = abs(a[0]) == 45.0 and abs(a[-1]) == 45.0
    return {"plies": n, "R1_symmetric": sym, "R2_balanced": bal, "R3_ten_percent": ten, "fractions": {k: round(v, 6) for k, v in frac.items()},
            "R4_max_consecutive": best, "R4_ok": best <= max_run, "R5_outer_pm45": outer}


CASES = [
    "[0/±45/90]s",
    "[45/-45/0/90]s",
    "[0/90]_2s",
    "[(0/90)_2/45]s",
    "[0_5/45/-45/90]s",
    "[0/45/90]s",
    "[45/-45/0_2/90~]s",
    "[0/90]T",
    "[±45/0_4/90_2]s",
    "[0/30/-45]T",
]


def build():
    out = []
    for c in CASES:
        ang = parse(c)
        out.append({"notation": c, "angles_bottom_to_top": ang, "rules": rules(ang)})
    return {"generator": "generate_layup_rules_reference.py", "defaults": {"max_consecutive": 4, "min_fraction": 0.10}, "cases": out}


def main():
    text = json.dumps(build(), indent=1) + "\n"
    if "--check" in sys.argv:
        ok = OUT.read_text() == text; print("OK" if ok else "DIFFERS"); sys.exit(0 if ok else 1)
    OUT.write_text(text); print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
