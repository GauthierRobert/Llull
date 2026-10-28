"""Synthetic fixtures for 08 XCH (VC-XCH-114 xrefs, VC-XCH-135 plot style), written with ezdxf (MIT).

NOT RUN YET (written 2026-10-28; check the ezdxf calls against the installed version at M4 / M5 before trusting the output).
Run with the bundled CPython in isolated mode, output into a fresh directory:

    python -I -m pip install ezdxf
    python -I make_fixtures.py <out-dir>

Ground truth is analytic (stated next to each fixture), never read back from llull.
"""

import sys
from pathlib import Path

import ezdxf
from ezdxf.addons import acadctb


def xref_fixtures(out: Path) -> None:
    # child.dxf: 3 LINEs and 1 CIRCLE in model space -> resolved xref shows exactly 4 entities (VC-XCH-114 case a).
    child = ezdxf.new("R2018")
    msp = child.modelspace()
    msp.add_line((0, 0), (100, 0))
    msp.add_line((100, 0), (100, 50))
    msp.add_line((100, 50), (0, 0))
    msp.add_circle((50, 20), 5)
    child.saveas(out / "child.dxf")

    # host.dxf: attaches child.dxf at (1000, 0) and a missing file -> 1 resolved, 1 XCH_DRW_XREF_UNRESOLVED (cases a, b).
    host = ezdxf.new("R2018")
    host.add_xref_def("child.dxf", "CHILD")
    host.add_xref_def("does_not_exist.dxf", "MISSING")
    hmsp = host.modelspace()
    hmsp.add_blockref("CHILD", (1000, 0))
    hmsp.add_blockref("MISSING", (0, 1000))
    host.saveas(out / "host.dxf")

    # cycle_a.dxf <-> cycle_b.dxf reference each other -> XCH_DRW_XREF_CYCLE, no hang (case c).
    for me, other in (("cycle_a", "cycle_b"), ("cycle_b", "cycle_a")):
        doc = ezdxf.new("R2018")
        doc.add_xref_def(f"{other}.dxf", other.upper())
        doc.modelspace().add_blockref(other.upper(), (0, 0))
        doc.modelspace().add_line((0, 0), (10, 10))
        doc.saveas(out / f"{me}.dxf")


def plot_style_fixture(out: Path) -> None:
    # xch_test.ctb: ACI 7 -> black, lineweight 0.50 mm; every other colour unchanged (VC-XCH-135).
    # Expected PDF stroke for ACI 7: 0.50 mm x 72 / 25.4 = 1.41732 pt (derived).
    ctb = acadctb.new_ctb()
    style = ctb[7]
    style.color = (0, 0, 0)
    style.set_lineweight(0.50)
    ctb.save(str(out / "xch_test.ctb"))


if __name__ == "__main__":
    target = Path(sys.argv[1])
    target.mkdir(parents=True, exist_ok=False)
    xref_fixtures(target)
    plot_style_fixture(target)
