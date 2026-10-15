#!/usr/bin/env python3
"""
Generate the reference values of PHY-17 (topology & shape optimization).

Run:  python3 -I generate_top_reference.py        (stdlib only, deterministic; about 2-4 minutes on a laptop)

Outputs (next to this script)
  expected_results.json        cases in the docs/physics/README.md section 6.3 schema (12 significant digits)
  mbb_history.csv              compliance / volume / change per iteration of the two MBB runs
  mbb_60x20_sensitivity.txt    final density field (ft = 1) as rows of 0-9 digits (density x 9, rounded), top row first
  mbb_60x20_density.txt        same for ft = 2

What is reproduced
  The MBB half-beam of Andreassen et al. 2011 ("top88", default call top88(60, 20, 0.5, 3.0, 1.5, ft)) [S1, S2]:
  modified SIMP E(x) = Emin + x^p (E0 - Emin), E0 = 1, Emin = 1e-9, p = 3, nu = 0.3, unit square bilinear
  plane-stress elements, unit load down at the top-left node, symmetry (ux = 0) on the left edge, uy = 0 at the
  bottom-right node; optimality-criteria update (move 0.2, bisection l1 = 0, l2 = 1e9, stop (l2-l1)/(l1+l2) < 1e-3);
  sensitivity filter (ft = 1) or density filter (ft = 2) with linear-hat weights max(0, rmin - dist);
  stop when max |x_new - x| <= 0.01.  Element numbering, DOF numbering and the 8x8 element stiffness follow top88
  (as also transcribed by topoptlab, GPL-3.0 [S3]; no code copied).

  The linear systems are solved exactly (banded Cholesky); no random numbers. The final values depend only on IEEE
  double rounding, so they are pinned with a small tolerance. The final compliances agree with an independent run of
  topoptlab 1.0.0 to 1e-10 relative (TOPOPTLAB below), so they are grade A; iteration counts and grey levels were not
  cross-checked and stay grade B.

Analytic cases (grade A)
  * KE entries for nu = 0.3 vs the closed form (1/(1-nu^2)/24) (A + nu B) of top88.
  * Uniform design x = 0.5 everywhere: compliance = c_solid / 0.5^p (SIMP scales the stiffness, Emin neglected:
    exact to 1e-9 relative for Emin = 1e-9).
  * Optimality-criteria fixed point for a separable problem: minimise sum a_i / x_i subject to sum x_i = V,
    0 < x_i <= 1 -> x_i* = V sqrt(a_i) / sum sqrt(a_j) (Lagrange); with p = 1 compliance of springs in series.
  * Filter weights for rmin = 1.5 on a regular grid: centre 1.5, edge neighbours 0.5, diagonal 1.5 - sqrt(2).
"""

from __future__ import annotations

import csv
import json
import math
import operator
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def sig(x: float, n: int = 12) -> float:
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{n}g}")


# ----------------------------------------------------------------------------------------------------------
# Element stiffness (top88, E = 1, unit square, plane stress)
# ----------------------------------------------------------------------------------------------------------
def element_stiffness(nu: float = 0.3) -> list[list[float]]:
    A11 = [[12, 3, -6, -3], [3, 12, 3, 0], [-6, 3, 12, -3], [-3, 0, -3, 12]]
    A12 = [[-6, -3, 0, 3], [-3, -6, -3, -6], [0, -3, -6, 3], [3, -6, 3, -6]]
    B11 = [[-4, 3, -2, 9], [3, -4, -9, 4], [-2, -9, -4, -3], [9, 4, -3, -4]]
    B12 = [[2, -3, 4, -9], [-3, 2, 9, -2], [4, 9, 2, 3], [-9, -2, 3, 2]]

    def block(P11, P12):
        top = [P11[i] + P12[i] for i in range(4)]
        P12T = [[P12[j][i] for j in range(4)] for i in range(4)]
        bot = [P12T[i] + P11[i] for i in range(4)]
        return top + bot

    A, B = block(A11, A12), block(B11, B12)
    f = 1.0 / (1.0 - nu * nu) / 24.0
    return [[f * (A[i][j] + nu * B[i][j]) for j in range(8)] for i in range(8)]


KE = element_stiffness(0.3)


def edofs(nelx: int, nely: int) -> list[list[int]]:
    """0-based translation of top88's edofMat: element e = ex * nely + ey (column-major)."""
    out = []
    for ex in range(nelx):
        for ey in range(nely):
            n = (nely + 1) * ex + ey  # top-left node, nodes numbered column-wise top to bottom
            b = 2 * (n + 1)
            out.append([b, b + 1, b + 2 * nely + 2, b + 2 * nely + 3, b + 2 * nely, b + 2 * nely + 1, b - 2, b - 1])
    return out


# ----------------------------------------------------------------------------------------------------------
# Banded Cholesky (row storage, half-bandwidth m); inner products in C via sum(map(mul, ...))
# ----------------------------------------------------------------------------------------------------------
def solve_banded(rows: list[list[float]], lo: list[int], rhs: list[float]) -> list[float]:
    n = len(rows)
    L = [None] * n
    for i in range(n):
        Ri = rows[i]
        li = lo[i]
        Li = [0.0] * len(Ri)
        for j in range(li, i):
            Lj = L[j]
            lj = lo[j]
            k0 = max(li, lj)
            s = Ri[j - li] - sum(map(operator.mul, Li[k0 - li:j - li], Lj[k0 - lj:j - lj]))
            Li[j - li] = s / Lj[j - lj]
        d = Ri[i - li] - sum(map(operator.mul, Li[0:i - li], Li[0:i - li]))
        if d <= 0.0:
            raise ArithmeticError(f"matrix not positive definite at row {i}")
        Li[i - li] = math.sqrt(d)
        L[i] = Li
    y = [0.0] * n
    for i in range(n):
        li = lo[i]
        y[i] = (rhs[i] - sum(map(operator.mul, L[i][0:i - li], y[li:i]))) / L[i][i - li]
    x = y[:]
    for i in range(n - 1, -1, -1):
        x[i] /= L[i][i - lo[i]]
        xi = x[i]
        li = lo[i]
        Li = L[i]
        for k in range(li, i):
            x[k] -= Li[k - li] * xi
    return x


class Mbb:
    def __init__(self, nelx: int, nely: int, nu: float = 0.3):
        self.nelx, self.nely = nelx, nely
        self.ndof = 2 * (nelx + 1) * (nely + 1)
        self.edof = edofs(nelx, nely)
        self.m = 2 * nely + 5  # half-bandwidth bound
        self.lo = [max(0, i - self.m) for i in range(self.ndof)]
        fixed = set(range(0, 2 * (nely + 1), 2)) | {self.ndof - 1}
        self.fixed = fixed
        self.f = [0.0] * self.ndof
        self.f[1] = -1.0

    def solve(self, Ee: list[float]) -> list[float]:
        rows = [[0.0] * (i - self.lo[i] + 1) for i in range(self.ndof)]
        lo = self.lo
        for e, dofs in enumerate(self.edof):
            s = Ee[e]
            for a in range(8):
                ia = dofs[a]
                Ka = KE[a]
                for b in range(8):
                    jb = dofs[b]
                    if jb <= ia:
                        rows[ia][jb - lo[ia]] += s * Ka[b]
        for i in self.fixed:
            for j in range(lo[i], i):
                rows[i][j - lo[i]] = 0.0
            for k in range(i + 1, min(self.ndof, i + self.m + 1)):
                if lo[k] <= i:
                    rows[k][i - lo[k]] = 0.0
            rows[i][i - lo[i]] = 1.0
        rhs = [0.0 if i in self.fixed else self.f[i] for i in range(self.ndof)]
        return solve_banded(rows, lo, rhs)

    def element_energy(self, U: list[float]) -> list[float]:
        ce = []
        for dofs in self.edof:
            ue = [U[d] for d in dofs]
            ce.append(sum(ue[a] * sum(map(operator.mul, KE[a], ue)) for a in range(8)))
        return ce


def filter_matrix(nelx: int, nely: int, rmin: float):
    H = []
    r = math.ceil(rmin) - 1
    for i1 in range(nelx):
        for j1 in range(nely):
            row = []
            for i2 in range(max(i1 - r, 0), min(i1 + r, nelx - 1) + 1):
                for j2 in range(max(j1 - r, 0), min(j1 + r, nely - 1) + 1):
                    w = max(0.0, rmin - math.sqrt((i1 - i2) ** 2 + (j1 - j2) ** 2))
                    if w > 0:
                        row.append((i2 * nely + j2, w))
            H.append(row)
    Hs = [sum(w for _, w in row) for row in H]
    return H, Hs


def top88(nelx: int, nely: int, volfrac: float, penal: float, rmin: float, ft: int, max_iter: int = 2000):
    E0, Emin = 1.0, 1e-9
    model = Mbb(nelx, nely)
    H, Hs = filter_matrix(nelx, nely, rmin)
    nel = nelx * nely
    x = [volfrac] * nel
    xPhys = x[:]
    history = []
    change, loop = 1.0, 0
    while change > 0.01 and loop < max_iter:
        loop += 1
        Ee = [Emin + xp**penal * (E0 - Emin) for xp in xPhys]
        U = model.solve(Ee)
        ce = model.element_energy(U)
        c = sum(Ee[e] * ce[e] for e in range(nel))
        dc = [-penal * (E0 - Emin) * xPhys[e] ** (penal - 1) * ce[e] for e in range(nel)]
        dv = [1.0] * nel
        if ft == 1:
            xdc = [x[e] * dc[e] for e in range(nel)]
            dc = [sum(w * xdc[j] for j, w in H[e]) / Hs[e] / max(1e-3, x[e]) for e in range(nel)]
        else:
            dcs = [dc[e] / Hs[e] for e in range(nel)]
            dvs = [dv[e] / Hs[e] for e in range(nel)]
            dc = [sum(w * dcs[j] for j, w in H[e]) for e in range(nel)]
            dv = [sum(w * dvs[j] for j, w in H[e]) for e in range(nel)]
        l1, l2, move = 0.0, 1e9, 0.2
        while (l2 - l1) / (l1 + l2) > 1e-3:
            lmid = 0.5 * (l2 + l1)
            xnew = [max(0.0, max(x[e] - move, min(1.0, min(x[e] + move, x[e] * math.sqrt(-dc[e] / dv[e] / lmid)))))
                    for e in range(nel)]
            if ft == 1:
                xPhys = xnew
            else:
                xPhys = [sum(w * xnew[j] for j, w in H[e]) / Hs[e] for e in range(nel)]
            if sum(xPhys) > volfrac * nel:
                l1 = lmid
            else:
                l2 = lmid
        change = max(abs(xnew[e] - x[e]) for e in range(nel))
        x = xnew
        history.append((loop, c, sum(xPhys) / nel, change))
    # compliance of the final physical design (one more solve)
    Ee = [Emin + xp**penal * (E0 - Emin) for xp in xPhys]
    U = model.solve(Ee)
    c_final = sum(Ee[e] * ce_e for e, ce_e in enumerate(model.element_energy(U)))
    grey = sum(4.0 * xp * (1.0 - xp) for xp in xPhys) / nel  # measure of non-discreteness (Sigmund 2007 form)
    return {"iterations": loop, "history": history, "c_last_iter": history[-1][1], "c_final": c_final,
            "volume": sum(xPhys) / nel, "grey": grey, "xPhys": xPhys, "tipDisplacement": U[1]}


def density_text(xPhys: list[float], nelx: int, nely: int) -> str:
    lines = []
    for ey in range(nely):
        lines.append("".join(str(int(round(9 * xPhys[ex * nely + ey]))) for ex in range(nelx)))
    return "\n".join(lines) + "\n"


# Independent cross-check, run once on 2026-10-15 outside this generator (not re-run here: needs numpy + scipy):
# topoptlab 1.0.0 main(nelx=60, nely=20, volfrac=0.5, rmin=1.5, ft=0|1, optimizer="oc", bcs=mbb_2d), last-iteration
# objective as returned by main(); ft = 0 is its sensitivity filter, ft = 1 its density filter. [S3]
TOPOPTLAB = {
    1: {"tool": "topoptlab 1.0.0 (GPL-3.0), optimizer oc, ft=0", "compliance": 203.19245763914194, "xPhysMean": 0.49997009027820527},
    2: {"tool": "topoptlab 1.0.0 (GPL-3.0), optimizer oc, ft=1", "compliance": 218.80322107077228},
}


def case(cid, quantity, value, unit, tol, source, grade, proves, **extra):
    c = {"id": cid, "quantity": quantity, "value": sig(value) if isinstance(value, float) else value, "unit": unit,
         "tolerance": tol, "source": source, "grade": grade, "proves": proves}
    c.update(extra)
    return c


def main() -> None:
    cases = []
    # VC-TOP-01: KE closed form spot checks (k11 = (12 - 4 nu)/24/(1-nu^2), k12 = (3 + 3 nu)/24/(1-nu^2))
    nu = 0.3
    cases.append(case("VC-TOP-01.a", "KE[0][0], nu = 0.3, E = 1, unit square, plane stress", KE[0][0], "N/m (E=1, t=1)",
                      {"rel": 1e-12}, "generator: (12 - 4 nu) / (24 (1 - nu^2)) [S1]", "A", ["TR-TOP-05"],
                      closedForm=sig((12 - 4 * nu) / 24 / (1 - nu * nu))))
    cases.append(case("VC-TOP-01.b", "KE[0][1]", KE[0][1], "N/m (E=1, t=1)", {"rel": 1e-12},
                      "generator: (3 + 3 nu) / (24 (1 - nu^2)) [S1]", "A", ["TR-TOP-05"],
                      closedForm=sig((3 + 3 * nu) / 24 / (1 - nu * nu))))
    rowsum = max(abs(sum(r)) for r in KE)
    cases.append(case("VC-TOP-01.c", "max |row sum| of KE (rigid translation has zero energy)", 0.0, "N/m", {"abs": 1e-14},
                      "generator (equilibrium)", "A", ["TR-TOP-05"], measuredByGenerator=f"{rowsum:.1e}"))

    # VC-TOP-02: filter weights rmin = 1.5
    H, Hs = filter_matrix(5, 5, 1.5)
    centre = dict(H[2 * 5 + 2])
    cases.append(case("VC-TOP-02.a", "filter weight, centre element, rmin = 1.5", centre[12], "1", {"abs": 1e-15},
                      "generator: max(0, rmin - 0)", "A", ["FR-TOP-04"]))
    cases.append(case("VC-TOP-02.b", "filter weight, edge neighbour", centre[13], "1", {"abs": 1e-15},
                      "generator: rmin - 1", "A", ["FR-TOP-04"]))
    cases.append(case("VC-TOP-02.c", "filter weight, diagonal neighbour", centre[18], "1", {"abs": 1e-15},
                      "generator: rmin - sqrt(2)", "A", ["FR-TOP-04"]))
    cases.append(case("VC-TOP-02.d", "Hs of an interior element (sum of 9 weights)", Hs[12], "1", {"rel": 1e-15},
                      "generator: 1.5 + 4 (0.5) + 4 (1.5 - sqrt 2)", "A", ["FR-TOP-04"]))

    # VC-TOP-03: separable OC fixed point (springs in series, p = 1): minimise sum a_i/x_i, sum x_i = V
    a = [1.0, 4.0, 9.0, 16.0]
    V = 2.0
    xs = [V * math.sqrt(ai) / sum(math.sqrt(aj) for aj in a) for ai in a]
    cases.append(case("VC-TOP-03.a", "optimal x for a = [1, 4, 9, 16], V = 2 (x_i = V sqrt(a_i) / sum sqrt(a_j))", xs, "1",
                      {"abs": 1e-6}, "generator (Lagrange multiplier, exact)", "A", ["FR-TOP-05", "TR-TOP-06"]))
    cases.append(case("VC-TOP-03.b", "optimal objective sum a_i / x_i", sum(ai / xi for ai, xi in zip(a, xs)), "1",
                      {"rel": 1e-6}, "generator: (sum sqrt a)^2 / V = 50", "A", ["FR-TOP-05", "TR-TOP-06"]))

    # VC-TOP-04: uniform design scaling (30 x 10, x = 0.5): c(0.5) = c(1) / 0.5^3 up to Emin
    small = Mbb(30, 10)
    U1 = small.solve([1.0] * 300)
    c1 = -U1[1]  # compliance = f^T u = -u_y at the loaded node (unit load down)
    Uh = small.solve([1e-9 + 0.5**3 * (1 - 1e-9)] * 300)
    ch = -Uh[1]
    cases.append(case("VC-TOP-04.a", "compliance of the solid 30x10 MBB half-beam (x = 1)", c1, "N*m (E=1, F=1)", {"rel": 1e-9},
                      "generator (exact linear solve)", "A", ["FR-TOP-03", "TR-TOP-05"]))
    cases.append(case("VC-TOP-04.b", "ratio c(x = 0.5) / c(x = 1) (SIMP p = 3)", ch / c1, "1", {"rel": 1e-8},
                      "generator: 1 / (Emin + 0.5^3 (1 - Emin)) = 7.99999994", "A", ["FR-TOP-03"],
                      closedForm=sig(1.0 / (1e-9 + 0.125 * (1 - 1e-9)))))

    # VC-TOP-10/11: MBB 60 x 20, volfrac 0.5, p = 3, rmin = 1.5 (top88 default call), ft = 1 and ft = 2
    hist_rows = []
    for vc, ft, label in (("VC-TOP-10", 1, "sensitivity"), ("VC-TOP-11", 2, "density")):
        res = top88(60, 20, 0.5, 3.0, 1.5, ft)
        for (it, c, v, ch_) in res["history"]:
            hist_rows.append([label, it, repr(sig(c)), repr(sig(v)), repr(sig(ch_))])
        with open(os.path.join(HERE, f"mbb_60x20_{label}.txt"), "w", encoding="utf-8") as fh:
            fh.write(density_text(res["xPhys"], 60, 20))
        common = {"inputs": {"nelx": 60, "nely": 20, "volfrac": 0.5, "penal": 3.0, "rmin": 1.5, "ft": ft, "E0": 1.0,
                             "Emin": 1e-9, "nu": 0.3, "move": 0.2, "stop": "max|dx| <= 0.01"}}
        cases.append(case(f"{vc}.a", f"MBB 60x20 ({label} filter): iterations to max|dx| <= 0.01", res["iterations"], "count",
                          {"abs": 0}, "generator reproduction of top88 [S1]", "B", ["FR-TOP-02", "FR-TOP-03", "TR-TOP-06"], **common))
        cases.append(case(f"{vc}.b", f"MBB 60x20 ({label}): compliance printed at the last iteration", res["c_last_iter"],
                          "N*m (E=1, F=1)", {"rel": 1e-6}, "generator reproduction of top88 [S1] + topoptlab 1.0.0 run [S3]", "A",
                          ["FR-TOP-02", "FR-TOP-03"], crossCheck=TOPOPTLAB[ft], **common))
        cases.append(case(f"{vc}.c", f"MBB 60x20 ({label}): compliance of the final xPhys", res["c_final"], "N*m (E=1, F=1)",
                          {"rel": 1e-6}, "generator reproduction of top88 [S1]", "B", ["FR-TOP-03", "FR-TOP-08"], **common))
        cases.append(case(f"{vc}.d", f"MBB 60x20 ({label}): final volume fraction of xPhys", res["volume"], "1",
                          {"abs": 1e-3}, "generator; OC bisection tolerance 1e-3" + (" + topoptlab [S3]" if ft == 1 else ""),
                          "A" if ft == 1 else "B", ["FR-TOP-02"], **common))
        cases.append(case(f"{vc}.e", f"MBB 60x20 ({label}): grey-level measure mean 4x(1-x)", res["grey"], "1",
                          {"abs": 1e-4}, "generator", "B", ["FR-TOP-09"], **common))
    with open(os.path.join(HERE, "mbb_history.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["filter", "iteration", "compliance", "volume_fraction", "change"])
        w.writerows(hist_rows)

    cases.append(case("VC-TOP-12", "MBB 300x100 (paper figure scale), compliance and topology", "TBD", "N*m (E=1, F=1)",
                      {"rel": None}, "TBD - measure with the bundled optimizer (too large for the stdlib generator)", "TBD",
                      ["FR-TOP-02", "NFR budget"]))

    doc = {"pack": "17-topology-optimization", "generatedBy": "generate_top_reference.py",
           "units": "consistent: E0 = 1, unit element edge, unit load (dimensionless top88 units) unless stated", "cases": cases}
    with open(os.path.join(HERE, "expected_results.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write("\n")


if __name__ == "__main__":
    main()
