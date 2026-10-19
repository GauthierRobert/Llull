"""Cervélo S5 (2025, size 56) frameset, bayonet fork, one-piece cockpit and seat, as airfoil lofts (sections normal to
each tube's centre line) that weld.py later fuses into one-piece parts with filleted joints.

Tube centre lines and side-view depths are traced from Cervélo's official size-56 geometry drawing (trace.py style:
frame fill segmented, every station re-centred between its two edges, depth measured normal to the tube); lateral
widths are not in a side drawing and come from photos. Options scale depth (chord) and width for the Aero+ variants.

World frame: +X travel, +Y rider's left, +Z up, ground z = 0, bottom bracket at x = 0. Drive side is -Y."""

import math

from geom import add, sub, mul, norm, lerp, kamm, superellipse, section_frame, ring_cage, ring, rnd
from plan import cd_strut
from options import O

# ---------------------------------------------------------------- geometry (Cervélo, 2025 S5 size 56)
STACK, REACH = 565.0, 392.0
HTA, STA = 73.5, 73.0
CHAINSTAY, WHEELBASE, BB_DROP = 405.0, 982.0, 72.0
HEAD_TUBE = 125.0
SADDLE_HEIGHT = 745.0  # BB -> saddle top along the seat tube (1.80 m rider, same as the earlier study)
R_WHEEL = 339.0  # 700 x 28c
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

# traced side view, (x, z, depth normal to the tube) in mm
TT = [(-150, 734, 30), (-95, 739, 28), (0, 756, 23), (100, 772, 26), (200, 786, 30), (270, 794, 36), (338, 806, 50)]
DT = [(22, 302, 86), (57, 338, 84), (100, 380, 78), (151, 430, 76), (200, 481, 76), (248, 533, 71), (290, 584, 61), (316, 610, 66),
      (348, 652, 70), (366, 670, 66)]
ST = [(-12, 300, 40), (-36, 366, 30), (-45, 396, 30), (-51, 427, 26), (-63, 456, 27), (-73, 486, 24), (-87, 515, 26), (-100, 535, 31),
      (-118, 565, 42), (-142, 600, 56), (-154, 640, 56), (-161, 680, 60), (-163, 712, 62), (-167, 740, 60)]
ST_WIDTH = [44, 30, 28, 26, 26, 25, 25, 26, 28, 32, 33, 34, 34, 34]
SS = [(-394, 376, 22), (-334, 439, 21), (-280, 486, 26), (-227, 534, 29), (-182, 572, 32), (-158, 602, 32)]
SS_Y = [HUB_REAR - 8, 48, 35, 22, 12, 8]
CS = [(-385, 336, 24), (-250, 310, 33), (-120, 288, 42), (-25, 276, 52)]
CS_Y = [HUB_REAR - 8.5, 47, 29, 27]
BLADES = [(466, 640, 66), (490, 570, 62), (530, 470, 52), (578, 352, 47)]
BLADE_Y = [50, 52, 54, 56]
# head block in steering-axis coordinates: front edge u (mm ahead of the axis) at height z; the frame head tube runs
# back to u = -88 (the front corner of the main triangle), the fork's bayonet covers its front
BAYONET = [(658, 54), (680, 60), (710, 63), (770, 58), (818, 52)]
HEAD_BACK = -88.0


def axis_at(z):
    """Point on the steering axis at height z."""
    return [HT_TOP[0] + (HT_TOP[2] - z) * c / s, 0.0, z]


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


def airfoil(depth, width, scale="frame"):
    """Kamm section centred on the traced centre line: `depth` = traced side depth, scaled by the variant options."""
    d, w = depth * O[scale][0], width * O[scale][1]
    chord = d / 0.86
    return kamm(chord, min(w, 0.95 * chord), lead=d / 2)


def traced(rows, y=None):
    return [[x, (y[i] if y else 0.0), z] for i, (x, z, _) in enumerate(rows)]


# ---------------------------------------------------------------- frameset


def build_frame(plan, colors):
    m, col, cat, W = "carbon_frame", colors["frame"], "frame", "frame"
    # head tube: from the fork crown to the top cap, its front hidden under the bayonet, its back the triangle's front corner
    hz = [650, 700, 770, 826]
    widths = [56, 52, 48, 46]
    outs = []
    for z, w in zip(hz, widths):
        chord = (10 - HEAD_BACK) / 0.86 * O["frame"][0]
        outs.append(kamm(chord, w * O["frame"][1], lead=10))
    tube(plan, [axis_at(z) for z in hz], outs, cat, cd_strut(90, 50, True), m, W + "/1", col)
    # top tube: shallow (23 mm) and flat, flaring into the head tube
    tt_half = [16, 16, 17, 19, 21, 23, 24]
    outs = [superellipse(d / 2 * O["frame"][0], h * O["frame"][1], 3) for (_, _, d), h in zip(TT, tt_half)]
    tube(plan, traced(TT), outs, cat, cd_strut(26, 36), m, W + "/1", col)
    # down tube: 76-86 mm deep and narrow, nose forward-down
    dt_w = [58, 54, 46, 40, 38, 38, 40, 44, 46, 46]
    tube(plan, traced(DT), [airfoil(d, w) for (_, _, d), w in zip(DT, dt_w)], cat, cd_strut(76 / 0.86, 40, True), m, W + "/1", col)
    # bottom-bracket shell: deep, flat-sided (BB shell 79 mm wide body)
    bb = [[-2, -42, H_BB + 4], [-2, 0, H_BB + 4], [-2, 42, H_BB + 4]]
    tube(plan, bb, [superellipse(36, 34, 3.5)] * 3, cat, 1.0, m, W + "/2", col)
    # seat tube: slim and curved round the rear tyre from the BB, then the seat mast up into the cluster
    tube(plan, traced(ST), [airfoil(d, w) for (_, _, d), w in zip(ST, ST_WIDTH)], cat, cd_strut(30 / 0.86, 26, True), m, W + "/3", col)
    # dropped seatstays, straight, meeting the mast 160 mm below the top tube
    for side in (1, -1):
        y = [side * v for v in SS_Y]
        outs = [airfoil(d, w) for (_, _, d), w in zip(SS, (18, 16, 16, 17, 18, 18))]
        tube(plan, traced(SS, y), outs, cat, cd_strut(26 / 0.86, 16, True), m, W + "/4", col)
    # chainstays: deep and flat-sided, inboard of the 52T ring, flaring out to the dropouts
    for side in (1, -1):
        y = [side * v for v in CS_Y]
        outs = [superellipse(d / 2, b, 3) for (_, _, d), b in zip(CS, (9, 10.5, 11, 13))]
        tube(plan, traced(CS, y), outs, cat, cd_strut(34, 21), m, W + "/2", col, hints=[[0, 0, 1]] * 4)
    # dropouts (flat-mount, 12 mm thru-axle)
    for side in (1, -1):
        y0, y1 = side * (HUB_REAR - 15), side * (HUB_REAR - 2)
        pts = [add(REAR, [4, y0, 8]), add(REAR, [4, y1, 8])]
        tube(plan, pts, [superellipse(22, 26, 3)] * 2, cat, 1.0, m, W + "/2", col)


def build_fork(plan, colors):
    m, col, cat, W = "carbon_frame", colors["frame"], "fork", "fork"
    # bayonet: the fork's crown runs up the front of the head tube to the top cap (the S5's steering "bayonet")
    outs = []
    for z, front in BAYONET:
        chord = 150 * O["fork"][0]
        outs.append(kamm(chord, 50 * O["fork"][1], lead=front, truncate=(front - 4) / chord))
    tube(plan, [axis_at(z) for z, _ in BAYONET], outs, cat, cd_strut(60, 50), m, W, col)
    # crown: widens from the bayonet to the blades, its back stepped under the down tube
    crown = [axis_at(z) for z in (690, 668, 646)]
    outs = [superellipse(34, 27, 2.3, du=28), superellipse(33, 46, 2.6, du=24), superellipse(32, 64, 3.0, du=20)]
    tube(plan, crown, outs, cat, cd_strut(80, 70), m, W, col)
    for side in (1, -1):
        y = [side * v for v in BLADE_Y]
        outs = [airfoil(d, w, "fork") for (_, _, d), w in zip(BLADES, (24, 21, 17, 14))]
        tube(plan, traced(BLADES, y), outs, cat, cd_strut(55 / 0.86, 18, True), m, W, col)
        tips = [add(FRONT, [0, side * (HUB_FRONT - 3), 4]), add(FRONT, [0, side * (HUB_FRONT + 13), 4])]
        tube(plan, tips, [superellipse(17, 19, 3)] * 2, cat, 1.0, m, W, col)
    return fork_numbers()


def build_cockpit(plan, colors):
    """One-piece carbon cockpit (HB19 style), proportions from the side photo: a slim stem blade rising from the top cap into
    the centre of flat aero tops that sweep forward to the hoods, compact drops tucked under the hoods. Returns the hood grip
    point and bar centre."""
    bh = O["bar_half"]
    m, col, cat = "carbon_black", colors["black"], "cockpit"
    # top cap / spacer follows the head-block airfoil
    tube(plan, [on_steer(-6), on_steer(8 + O["spacers"])], [kamm(150, 46, 52, truncate=(52 + 86) / 150)] * 2, cat, cd_strut(76, 44, True), m, "stem", col)
    root = on_steer(10 + O["spacers"])
    fwd = norm([math.cos(math.radians(O["stem_deg"])), 0, math.sin(math.radians(O["stem_deg"]))])
    up = [-fwd[2], 0, fwd[0]]

    def at(x, y, z):
        """Point x along the stem, y lateral, z normal to the stem (in its vertical plane), from the bar centre."""
        return add(add(add(bar, mul(fwd, x)), mul(up, z)), [0, y, 0])

    bar = add(root, mul(fwd, 140))
    # stem: a 22 mm tall blade, narrow from the front, from inside the top cap into the bar centre
    pts = [add(on_steer(2 + O["spacers"]), mul(fwd, -14)), add(root, mul(fwd, 24)), add(root, mul(fwd, 80)), add(bar, mul(fwd, 4))]
    outs = [superellipse(7, 15, 2.6), superellipse(11.5, 15, 3), superellipse(10.5, 14.5, 3), superellipse(10, 17, 3)]
    tube(plan, pts, outs, cat, cd_strut(30, 22), m, "stem", col, hints=[up] * 4)
    # aero tops: a flat wing swept forward and slightly up to the hoods
    wing = [at(70, -(bh - 30), 6), at(18, -60, 1), at(0, 0, 0), at(18, 60, 1), at(70, bh - 30, 6)]
    outs = [kamm(*O["wing"])] * 2 + [kamm(*O["wing_centre"])] + [kamm(*O["wing"])] * 2
    plan.loft(stations(wing, outs, [fwd] * 5), cat, cd_strut(O["wing"][0] * 0.86, O["wing"][1], True), m, "stem", col)
    hood = None
    for side in (1, -1):
        y = side * bh
        drop = [at(62, side * (bh - 34), 5), at(88, side * (bh - 10), 4), at(98, y, -12), at(86, side * (bh + 3), -48), at(60, side * (bh + 9), -100),
                at(22, side * (bh + 15), -134), at(-30, side * (bh + 20), -140), at(-86, side * (bh + 20), -136)]
        plan.add("sweep_profile", {"path": [rnd(p) for p in drop], "smooth": True, "stations": [{"at": 0, "radiusX": 7.5, "radiusY": 11.9}, {"at": 0.15, "radiusX": 11.9, "radiusY": 11.9}, {"at": 1, "radiusX": 11.9, "radiusY": 11.9}], "color": colors["tape"]},
                 cat, cd_strut(23.8, 23.8), "bar_tape")
        # Di2 hood: long body on the ramp, tall horn at the front
        rings = []
        for dx, dz, a, b, n in ((80, 3, 12, 13, 2.6), (94, 9, 16, 15, 3), (110, 13, 18, 15.5, 3), (124, 17, 19, 15, 3), (136, 25, 15, 13, 2.8),
                                (143, 34, 10, 10, 2.5), (146, 42, 5, 6.5, 2.3)):
            ex, ey, ez = section_frame(fwd, up)
            rings.append((at(dx, y, dz), ex, ey, ring(a, b * O["hood_width"], 8, n)))
        v, f = ring_cage(rings)
        plan.cage(v, f, cat, 0.6, "rubber_hood", colors["hood"])
        hood = at(112, y, 34)
        lever = [at(136, y, 4), at(144, y, -50), at(140, side * (bh + 5), -112)]
        tube(plan, lever, [superellipse(10, 5, 3), superellipse(9, 4.5, 3), superellipse(6, 4, 3)], cat, 1.0, "black_anod", None, colors["lever"],
             hints=[fwd] * 3)
    return {"bar": bar, "hood": hood, "bar_half": bh}


def build_seat(plan, colors):
    """Black aero seatpost (D-shaped, steeper than the effective seat angle in the drawing), clamp head and saddle."""
    m, cat = "carbon_black", "seat"
    saddle_top = on_seat(SADDLE_HEIGHT)
    head = on_seat(SADDLE_HEIGHT - 40)
    post = [[-166, 0, 700], lerp([-166, 0, 700], add(head, [8, 0, -8]), 0.5), add(head, [8, 0, -8])]
    d, w = O["post"]
    tube(plan, post, [airfoil(d, w, "unit")] * 3, cat, cd_strut(d / 0.86, w, True), m, None, colors["black"])
    tube(plan, [add(head, [-22, 0, 0]), add(head, [22, 0, 0])], [superellipse(12, 16, 3)] * 2, cat, 1.0, "black_anod", None, colors["black"],
         hints=[[0, 0, 1]] * 2)
    rings = []
    sw = O["saddle_width"] / 72
    for x, a, b, dz in ((-118, 16, 70 * sw, 2), (-90, 20, 72 * sw, 0), (-40, 18, 64 * sw, -2), (20, 15, 40, -3), (80, 12, 22, -2), (130, 11, 17, 0), (152, 8, 10, 1)):
        centre = add(saddle_top, [x + 15, 0, dz - 12])
        ex, ey, ez = section_frame([1, 0, 0], [0, 0, 1])
        rings.append((centre, ex, ey, ring(a, b, 10, 2.8)))
    v, f = ring_cage(rings)
    plan.cage(v, f, cat, 0.5, "saddle", colors["saddle"])
    return saddle_top
