"""Pure geometry helpers for the S5 generator: vectors, section frames, airfoil / superellipse sections, sprocket tooth
outlines, subdivision cages. No llull calls here: the generator turns these into plan actions."""

import math

# ---------------------------------------------------------------- vectors


def add(a, b):
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]


def sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def mul(a, s):
    return [a[0] * s, a[1] * s, a[2] * s]


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def norm(a):
    n = math.sqrt(dot(a, a))
    return [a[0] / n, a[1] / n, a[2] / n]


def lerp(a, b, t):
    return [a[i] + (b[i] - a[i]) * t for i in range(3)]


def rnd(v, d=3):
    return [round(x, d) for x in v]


# ---------------------------------------------------------------- frames


def euler_xyz(ex, ey, ez):
    """three.js intrinsic XYZ Euler of the rotation whose columns are ex, ey, ez (local x, y, z in world)."""
    m13, m23, m33, m12, m11, m32, m22 = ez[0], ez[1], ez[2], ey[0], ex[0], ey[2], ey[1]
    y = math.asin(max(-1.0, min(1.0, m13)))
    if abs(m13) < 0.9999999:
        x, z = math.atan2(-m23, m33), math.atan2(-m12, m11)
    else:
        x, z = math.atan2(m32, m22), 0.0
    return [round(x, 7), round(y, 7), round(z, 7)]


FORWARD, UP, LEFT = [1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]


def section_frame(tangent, chord_hint=FORWARD, fallback=UP):
    """Section plane normal to `tangent`: ex = chord direction (the hint made perpendicular), ey = lateral, ez = tangent."""
    ez = norm(tangent)
    h = sub(chord_hint, mul(ez, dot(chord_hint, ez)))
    if math.sqrt(dot(h, h)) < 0.25:
        h = sub(fallback, mul(ez, dot(fallback, ez)))
    ex = norm(h)
    ey = cross(ez, ex)
    return ex, ey, ez


def frame_point(origin, ex, ey, u, v):
    return add(origin, add(mul(ex, u), mul(ey, v)))


# ---------------------------------------------------------------- 2D sections (u = chord / ex, v = lateral / ey)


def kamm(chord, thickness, lead=None, truncate=0.86, n=10):
    """Truncated NACA 00xx outline, CCW: leading edge at u = lead (default 0.3 chord, so u = 0 is near max thickness), Kamm
    tail cut at `truncate` of the chord with small rounded corners."""
    t = thickness / chord
    lead = 0.3 * chord if lead is None else lead
    xs = [truncate * (1 - math.cos(math.pi * i / (n - 1))) / 2 for i in range(n)]

    def half(x):
        return 5 * t * chord * (0.2969 * math.sqrt(x) - 0.1260 * x - 0.3516 * x**2 + 0.2843 * x**3 - 0.1015 * x**4)

    upper = [(lead - x * chord, half(x)) for x in xs]  # leading edge -> tail on the +v side
    tail_u, tail_v = upper[-1]
    r = min(2.5, 0.35 * tail_v)
    corner = [(tail_u + r - r * math.sin(a), tail_v - r + r * math.cos(a)) for a in (0.0, math.pi / 4, math.pi / 2)]
    upper = [p for p in upper[:-1] if p[0] > tail_u + r + 0.5] + corner  # monotone in u, ends at (tail_u, tail_v - r)
    lower = [(u, -v) for u, v in reversed(upper)]
    outline = upper + lower[:-1]
    return [[round(u, 3), round(v, 3)] for u, v in outline]


def superellipse(a, b, n=4.0, k=16, du=0.0):
    """|u/a|^n + |v/b|^n = 1, CCW, k points (u half-size a along ex, v half-size b along ey)."""
    pts = []
    for i in range(k):
        th = 2 * math.pi * i / k
        c, s = math.cos(th), math.sin(th)
        pts.append([round(du + a * math.copysign(abs(c) ** (2 / n), c), 3), round(b * math.copysign(abs(s) ** (2 / n), s), 3)])
    return pts


def ellipse(a, b, k=16, du=0.0):
    return superellipse(a, b, 2.0, k, du)


# ---------------------------------------------------------------- sprockets


def pitch_radius(teeth, pitch=12.7):
    return pitch / (2 * math.sin(math.pi / teeth))


def sprocket_outline(teeth, pitch=12.7, roller=7.75, tip_height=None, seat_points=7):
    """Chain-sprocket outline (CCW): a roller seat arc (roller radius + 0.1) at every pitch point, straight-ish flanks and a
    rounded tip half-way between."""
    rp = pitch_radius(teeth, pitch)
    rs = roller / 2 + 0.12
    tip = tip_height if tip_height is not None else min(0.42 * pitch, 5.2)
    pts = []
    step = 2 * math.pi / teeth
    for k in range(teeth):
        a = k * step
        cx, cy = rp * math.cos(a), rp * math.sin(a)
        # seat arc from the trailing side (beta = a + 270 deg) through the bottom to the leading side (a + 90 deg)
        for j in range(seat_points):
            beta = a + math.radians(270 - 180 * j / (seat_points - 1))
            pts.append((cx + rs * math.cos(beta), cy + rs * math.sin(beta)))
        # flank up to a rounded tip at a + step/2
        for f, frac in ((0.55, 0.22), (0.85, 0.40), (1.0, 0.5), (0.85, 0.60), (0.55, 0.78)):
            ang = a + step * frac
            rr = rp + tip * f
            pts.append((rr * math.cos(ang), rr * math.sin(ang)))
    return [[round(x, 3), round(y, 3)] for x, y in pts]


# ---------------------------------------------------------------- subdivision cages


def ring_cage(rings):
    """Closed tube-like cage through rings [(centre, ex, ey, [(u, v)...])] (same point count, CCW in (ex, ey) seen from +ez,
    rings ordered along +ez): side quads + an n-gon cap at each end, every face CCW seen from outside."""
    k = len(rings[0][3])
    vertices = []
    for centre, ex, ey, shape in rings:
        for u, v in shape:
            vertices.append(rnd(frame_point(centre, ex, ey, u, v), 2))
    faces = []
    for i in range(len(rings) - 1):
        for j in range(k):
            a, b = i * k + j, i * k + (j + 1) % k
            faces.append([a, b, b + k, a + k])
    faces.append(list(range(k))[::-1])
    last = (len(rings) - 1) * k
    faces.append([last + j for j in range(k)])
    return vertices, faces


def ring(a, b, k=8, n=2.6, du=0.0, dv=0.0):
    """Cage ring: k points on a superellipse (CCW)."""
    return [(u, v + dv) for u, v in superellipse(a, b, n, k, du)]
