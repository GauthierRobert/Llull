"""Cervélo S5 (2023, size 56) frameset, fork, V-stem cockpit and seat, as airfoil lofts (sections normal to each tube's
centre line) that weld.py later fuses into one-piece parts with filleted joints.

World frame: +X travel, +Y rider's left, +Z up, ground z = 0, bottom bracket at x = 0. Drive side is -Y."""

import math

from geom import add, sub, mul, norm, lerp, kamm, superellipse, section_frame, ring_cage, ring, rnd
from plan import cd_strut

# ---------------------------------------------------------------- geometry (Bike Insights, 2023 S5 size 56)
STACK, REACH = 542.0, 384.0
HTA, STA = 73.0, 73.0
CHAINSTAY, WHEELBASE, BB_DROP = 405.0, 975.0, 70.0
HEAD_TUBE = 140.0
SEAT_CLUSTER = 505.0  # BB -> top-tube junction along the seat tube
SADDLE_HEIGHT = 745.0  # BB -> saddle top along the seat tube (1.80 m rider, same as the earlier study)
R_WHEEL = 339.0  # 700 x 28c on a 23 mm internal rim
HUB_REAR, HUB_FRONT = 71.0, 50.0  # half of 142 / 100 mm thru-axle spacing

H_BB = R_WHEEL - BB_DROP
REAR = [-math.sqrt(CHAINSTAY**2 - BB_DROP**2), 0.0, R_WHEEL]
FRONT = [REAR[0] + WHEELBASE, 0.0, R_WHEEL]
BB = [0.0, 0.0, H_BB]
c, s = math.cos(math.radians(HTA)), math.sin(math.radians(HTA))
STEER_UP = [-c, 0.0, s]
STEER_DOWN = [c, 0.0, -s]
SEAT_UP = [-math.cos(math.radians(STA)), 0.0, math.sin(math.radians(STA))]
HT_TOP = [REACH, 0.0, H_BB + STACK]
HT_BOT = add(HT_TOP, mul(STEER_DOWN, HEAD_TUBE))


def on_seat(d):
    return add(BB, mul(SEAT_UP, d))


def on_steer(d):
    """Point on the steering axis, d mm above the head-tube top (negative: below)."""
    return add(HT_TOP, mul(STEER_UP, d))


def fork_numbers():
    axis_x_at_axle = HT_TOP[0] + (HT_TOP[2] - R_WHEEL) / math.tan(math.radians(HTA))
    offset = (FRONT[0] - axis_x_at_axle) * s
    trail = (R_WHEEL * c - offset) / s
    return round(offset, 1), round(trail, 1)


def stations(points, outlines, hints=None):
    """Loft stations with centre-difference tangents."""
    out = []
    for i, (p, o) in enumerate(zip(points, outlines)):
        a, b = points[max(0, i - 1)], points[min(len(points) - 1, i + 1)]
        st = (p, sub(b, a), o)
        if hints:
            st = st + (hints[i],)
        out.append(st)
    return out


def tube(plan, points, outlines, category, cd, material, weld, color, hints=None):
    return plan.loft(stations(points, outlines, hints), category, cd, material, weld, color)


def clearance_back(centre, ex, wanted, axle, min_r):
    """Longest tail (along -ex from centre, up to `wanted`) whose end stays >= min_r from the axle (wheel cut-out)."""
    back = wanted
    while back > 6:
        p = sub(centre, mul(ex, back))
        if math.dist(p, axle) >= min_r:
            return back
        back -= 1.0
    return back


# ---------------------------------------------------------------- frameset


def build_frame(plan, colors):
    m, col, cat = "carbon_frame", colors["frame"], "frame"
    W = "frame"
    # head tube: 110 mm deep truncated airfoil, nose 32 mm ahead of the steering axis
    ht = [on_steer(-HEAD_TUBE - 4), on_steer(-HEAD_TUBE * 0.5), on_steer(14)]
    tube(plan, ht, [kamm(112, 54, 34), kamm(102, 50, 31), kamm(90, 46, 28)], cat, cd_strut(96, 54, True), m, W + "/1", col)
    # top tube: tall and narrow, slight slope, ends buried in the head tube and seat tube
    tt0 = add(on_steer(-30), [-30, 0, 0])
    tt1 = add(on_seat(SEAT_CLUSTER), mul([0.956, 0, 0.292], 4))
    tt = [tt0, lerp(tt0, tt1, 0.5), tt1]
    tube(plan, tt, [superellipse(21, 13, 3), superellipse(18, 12, 3), superellipse(17, 12.5, 3)], cat, cd_strut(36, 25), m, W + "/1", col)
    # down tube: deep at the head tube, slim in the middle, wide at the bottom bracket
    dt0 = add(on_steer(-HEAD_TUBE + 50), [-12, 0, 0])
    dt1 = [2, 0, H_BB - 2]
    dt = [dt0, lerp(dt0, dt1, 0.25), lerp(dt0, dt1, 0.65), dt1]
    tube(plan, dt, [kamm(80, 36, 30), kamm(70, 31, 26), kamm(64, 31, 24), kamm(70, 46, 24)], cat, cd_strut(60, 31, True), m, W + "/1", col)
    # bottom-bracket shell: deep, flat-sided (PF BBright, 79 mm wide body)
    bb = [[-6, -42, H_BB - 4], [-6, 0, H_BB - 4], [-6, 42, H_BB - 4]]
    tube(plan, bb, [superellipse(44, 44, 3.5)] * 3, cat, 1.0, m, W + "/2", col)
    # seat tube: airfoil whose tail is cut back around the rear tyre (12 mm clearance) - the S5 wheel cut-out
    pts, outs = [], []
    for d in (18, 80, 150, 230, 320, 420, SEAT_CLUSTER + 30):
        centre = on_seat(d)
        ex, _, _ = section_frame(SEAT_UP)
        chord, thick, lead = (74, 40, 30) if d < 60 else (66, 28, 27)
        back = clearance_back(centre, ex, 0.86 * chord - lead, REAR, R_WHEEL + 12)
        outs.append(kamm(chord, thick, lead, truncate=max(0.45, (lead + back) / chord)))
        pts.append(centre)
    tube(plan, pts, outs, cat, cd_strut(50, 28, True), m, W + "/3", col)
    # dropped seatstays, meeting the seat tube 165 mm below the top tube
    for side in (1, -1):
        j = add(on_seat(340), [-6, side * 5, 0])
        d = add(REAR, [12, side * (HUB_REAR - 8), 14])
        tube(plan, [j, lerp(j, d, 0.5), d], [kamm(30, 15, 11), kamm(25, 12.5, 9), kamm(21, 11, 8)], cat, cd_strut(24, 12, True), m, W + "/4", col)
    # chainstays: tall near the BB, inboard of the 52T ring, flaring out to the dropouts
    for side in (1, -1):
        path = [[-24, side * 26, H_BB - 6], [-120, side * 32, H_BB + 12], [-262, side * 47, H_BB + 50], [REAR[0] + 14, side * (HUB_REAR - 8.5), R_WHEEL - 2]]
        outs = [superellipse(20, 11.5, 3), superellipse(17, 11, 3), superellipse(13, 9.5, 3), superellipse(10, 6, 3)]
        tube(plan, path, outs, cat, cd_strut(30, 20), m, W + "/2", col, hints=[[0, 0, 1]] * 4)
    # dropouts (flat-mount, 12 mm thru-axle)
    for side in (1, -1):
        y0, y1 = side * (HUB_REAR - 15), side * (HUB_REAR - 2)
        pts = [add(REAR, [6, y0, 6]), add(REAR, [6, y1, 6])]
        tube(plan, pts, [superellipse(22, 25, 3)] * 2, cat, 1.0, m, W + "/2", col)


def build_fork(plan, colors):
    m, col, cat, W = "carbon_frame", colors["frame"], "fork", "fork"
    # crown continues the head-tube airfoil and widens to the blades
    crown = [on_steer(-HEAD_TUBE - 6), on_steer(-HEAD_TUBE - 22), on_steer(-HEAD_TUBE - 40)]
    outs = [superellipse(47, 26, 2.3, du=-14), superellipse(44, 40, 2.5, du=-11), superellipse(36, 63, 3.0, du=-6)]
    tube(plan, crown, outs, cat, cd_strut(80, 70), m, W, col)
    top = on_steer(-HEAD_TUBE - 32)
    for side in (1, -1):
        a = add(top, [0, side * 46, 0])
        b = add(FRONT, [3, side * (HUB_FRONT + 6), 6])
        tube(plan, [a, lerp(a, b, 0.45), b], [kamm(56, 22, 22), kamm(48, 17, 19), kamm(38, 12, 15)], cat, cd_strut(44, 17, True), m, W, col)
        tips = [add(FRONT, [3, side * (HUB_FRONT - 3), 4]), add(FRONT, [3, side * (HUB_FRONT + 13), 4])]
        tube(plan, tips, [superellipse(17, 19, 3)] * 2, cat, 1.0, m, W, col)
    return fork_numbers()


def build_cockpit(plan, colors, bar_half=200.0):
    """S5 V-stem (two arms) + HB13-style aero bar, hoods and levers. Returns the hood grip point and bar centre."""
    m, col, cat = "carbon_frame", colors["frame"], "cockpit"
    # top cover / spacer follows the head-tube airfoil
    tube(plan, [on_steer(12), on_steer(24)], [kamm(90, 46, 28), kamm(86, 44, 27)], cat, cd_strut(76, 44, True), m, "stem", col)
    clamp = on_steer(44)
    tube(plan, [on_steer(22), on_steer(66)], [superellipse(26, 19, 3), superellipse(24, 18, 3)], cat, 1.0, m, "stem", col)
    stem_dir = norm([math.cos(math.radians(-10)), 0, math.sin(math.radians(-10))])
    bar = add(clamp, mul(stem_dir, 100))
    for side in (1, -1):  # the V: two thin arms from the steerer clamp to the bar
        a = add(clamp, [8, side * 9, 0])
        b = add(bar, [-12, side * 30, 0])
        tube(plan, [a, lerp(a, b, 0.5), b], [superellipse(17, 7.5, 3)] * 3, cat, cd_strut(34, 15), m, "stem", col, hints=[[0, 0, 1]] * 3)
    # bar clamp fairing: the stem arms end inside it, the bar wing passes through it
    plan.loft(stations([add(bar, [0, -44, 0]), bar, add(bar, [0, 44, 0])], [kamm(66, 44, 30), kamm(70, 48, 32), kamm(66, 44, 30)], [[1, 0, 0]] * 3),
              cat, cd_strut(62, 44, True), m, "stem", col)
    # aero tops: a flat wing, swept 8 mm forward at the ends
    wing = []
    for y in (-(bar_half - 26), -60, 0, 60, bar_half - 26):
        wing.append(add(bar, [8 * abs(y) / bar_half, y, 0]))
    hints = [[1, 0, 0]] * len(wing)
    outs = [kamm(54, 15, 22)] * 2 + [kamm(60, 24, 26)] + [kamm(54, 15, 22)] * 2
    plan.loft(stations(wing, outs, hints), cat, cd_strut(46, 15, True), m, "stem", col)
    bx, bz = bar[0], bar[2]
    hood = None
    for side in (1, -1):
        y = side * bar_half
        drop = [[bx + 8, side * (bar_half - 26), bz], [bx + 42, side * (bar_half - 4), bz + 2], [bx + 76, y, bz - 18],
                [bx + 74, side * (bar_half + 4), bz - 70], [bx + 40, side * (bar_half + 8), bz - 122], [bx - 20, side * (bar_half + 9), bz - 124],
                [bx - 48, side * (bar_half + 9), bz - 112]]
        plan.add("sweep_profile", {"path": [rnd(p) for p in drop], "smooth": True, "stations": [{"at": 0, "radiusX": 7.5, "radiusY": 11.9}, {"at": 0.12, "radiusX": 11.9, "radiusY": 11.9}, {"at": 1, "radiusX": 11.9, "radiusY": 11.9}], "color": colors["tape"]},
                 cat, cd_strut(23.8, 23.8), "bar_tape")
        # brake / shift hood: smooth subdivision body sitting on the ramp, horn rising at the front
        rings = []
        for t, (dx, dz, a, b, n) in enumerate(((54, -18, 19, 14, 2.4), (72, -12, 24, 16, 2.6), (96, -4, 23, 15.5, 2.8), (118, 6, 25, 13, 2.4), (136, 12, 15, 10, 2.2))):
            centre = [bx + dx, y, bz + dz]
            ex, ey, ez = section_frame([1, 0, 0.12], [0, 0, 1])
            rings.append((centre, ex, ey, ring(a, b, 8, n)))
        v, f = ring_cage(rings)
        h = plan.cage(v, f, cat, 0.6, "rubber_hood", colors["hood"])
        hood = [bx + 92, y, bz + 6]
        del h
        lever = [[bx + 128, y, bz - 6], [bx + 132, y, bz - 50], [bx + 118, side * (bar_half + 3), bz - 100]]
        tube(plan, lever, [superellipse(9, 5, 3), superellipse(8, 4.5, 3), superellipse(6, 4, 3)], cat, 1.0, "black_anod", None, colors["lever"],
             hints=[[1, 0, 0]] * 3)
    return {"bar": bar, "hood": hood, "bar_half": bar_half}


def build_seat(plan, colors):
    m, cat = "carbon_frame", "seat"
    post = [on_seat(SEAT_CLUSTER - 30), on_seat(SADDLE_HEIGHT - 48)]
    tube(plan, post, [kamm(52, 24, 20), kamm(50, 22, 19)], cat, cd_strut(44, 22, True), m, None, colors["frame"])
    head = on_seat(SADDLE_HEIGHT - 40)
    tube(plan, [add(head, [-22, 0, 0]), add(head, [22, 0, 0])], [superellipse(12, 16, 3)] * 2, cat, 1.0, "black_anod", None, colors["black"],
         hints=[[0, 0, 1]] * 2)
    saddle_top = on_seat(SADDLE_HEIGHT)
    rings = []
    for x, a, b, dz in ((-118, 16, 70, 2), (-90, 20, 72, 0), (-40, 18, 64, -2), (20, 15, 40, -3), (80, 12, 22, -2), (130, 11, 17, 0), (152, 8, 10, 1)):
        centre = add(saddle_top, [x + 15, 0, dz - 12])
        ex, ey, ez = section_frame([1, 0, 0], [0, 0, 1])
        rings.append((centre, ex, ey, ring(a, b, 10, 2.8)))
    v, f = ring_cage(rings)
    plan.cage(v, f, cat, 0.5, "saddle", colors["saddle"])
    return saddle_top
