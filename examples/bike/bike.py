"""
Road bike generator for llull: emits a build_project plan (pass 1: geometry) for two variants.

  baseline : a realistic round-tube road bike (box-section rims, 24 round spokes, external cables, 420 mm bars, 2 bottles)
  aero     : the same rider/geometry with every drag item re-designed (see README.md, "Aero optimisation")

World frame: +X = direction of travel, +Y = rider's left, +Z = up, ground at z = 0, bottom bracket at x = 0.
Drive side is -Y. All lengths in mm, angles in degrees here (radians in the plan).

Sources for the dimensions are listed in README.md. Usage:  python3 bike.py baseline > baseline.plan.json
"""

import json
import math
import sys

VARIANT = sys.argv[1] if len(sys.argv) > 1 else "baseline"
AERO = VARIANT in ("aero", "aero_fit")
FIT = VARIANT == "aero_fit"  # aero bike + the lower, narrower position its cockpit allows

# ---------------------------------------------------------------- driving dimensions (Canyon Aeroad CFR, size L)
STACK, REACH = 580.0, 401.0
HTA, STA = 73.3, 73.5
CHAINSTAY, WHEELBASE, BB_DROP = 413.0, 1003.0, 70.0
HEAD_TUBE = 165.0
SEAT_TUBE = 520.0
SADDLE_HEIGHT = 745.0  # BB centre -> saddle top along the seat tube (1.80 m rider)
# 700c: ETRTO 622 mm bead seat diameter, 28 mm tyre
BSD, TYRE = 622.0, 28.0
R_WHEEL = BSD / 2 + TYRE  # 339 mm rolling radius
# drivetrain: 2x12, chain 1/2" pitch
PITCH = 12.7
RING_BIG, RING_SMALL = 52, 36
CASSETTE = [11, 12, 13, 14, 15, 16, 17, 19, 21, 24, 27, 30]
COG_IN_USE = 15  # 52x15 -> 40 km/h at 91 rpm
CRANK = 172.5
PULLEY_TEETH = 13
Q_FACTOR = 148.0
CHAIN_Y = -48.5  # chain plane (outer ring, 15T cog)
CASSETTE_SMALL_Y, COG_SPACING = -63.0, 3.5
HUB_HALF_REAR, HUB_HALF_FRONT = 71.0, 50.0  # 142 / 100 mm thru-axle spacing

# ---------------------------------------------------------------- derived frame points
H_BB = R_WHEEL - BB_DROP
REAR_X = -math.sqrt(CHAINSTAY**2 - BB_DROP**2)
FRONT_X = REAR_X + WHEELBASE
rad = math.radians
STEER_DOWN = (math.cos(rad(HTA)), -math.sin(rad(HTA)))  # (x, z) along the steering axis, going down
SEAT_UP = (-math.cos(rad(STA)), math.sin(rad(STA)))
HT_TOP = (REACH, H_BB + STACK)
HT_BOTTOM = (HT_TOP[0] + HEAD_TUBE * STEER_DOWN[0], HT_TOP[1] + HEAD_TUBE * STEER_DOWN[1])
SEAT_CLUSTER = (SEAT_UP[0] * SEAT_TUBE, H_BB + SEAT_UP[1] * SEAT_TUBE)
SADDLE = (SEAT_UP[0] * SADDLE_HEIGHT, H_BB + SEAT_UP[1] * SADDLE_HEIGHT)


def along(p, d, s):
    return (p[0] + d[0] * s, p[1] + d[1] * s)


def pitch_radius(teeth):
    return PITCH / (2 * math.sin(math.pi / teeth))


def xyz(p, y=0.0):
    return [round(p[0], 3), round(y, 3), round(p[1], 3)]


# ---------------------------------------------------------------- drag coefficients (frontal-area basis, 40 km/h, sea level)
V_REF, NU_AIR = 40 / 3.6, 1.46e-5


def cd_strut(chord, thickness, kamm=False):
    """Hoerner fit for struts / wires: Cd_chord = 2.66/sqrt(Re)(1 + t/c) + (t/c)^2, converted to the frontal area (x c/t).
    A cylinder is t/c = 1 (Cd ~ 1.0-1.1 at bike Reynolds numbers); a truncated (Kamm) tail adds 0.04 base drag."""
    tc = thickness / chord
    re = V_REF * chord / 1000 / NU_AIR
    return round(2.66 / math.sqrt(re) * (1 + tc) / tc + tc + (0.04 if kamm else 0), 4)


def cd_round(diameter):
    return cd_strut(diameter, diameter)


BLUFF = 1.0  # boxes, calipers, pedals, derailleurs, sprockets, chain links (Hoerner: blunt 3D bodies ~0.8-1.2)

# ---------------------------------------------------------------- plan helpers
actions = []
categories = {}  # alias -> category (pass 2 puts each on a layer and measures it)
drag = {}  # alias -> frontal-area drag coefficient (rider: calibrated in analysis)
counter = [0]


def add(command, params, category=None, alias=None, cd=BLUFF):
    counter[0] += 1
    alias = alias or f"e{counter[0]}"
    actions.append({"command": command, "params": params, "as": alias})
    if category:
        categories[alias] = category
        drag[alias] = cd
    return alias


COLORS = {
    "frame": "#c8102e" if not AERO else "#1d1f24",
    "fork": "#c8102e" if not AERO else "#1d1f24",
    "rubber": "#202020",
    "rim": "#2b2b2b",
    "alloy": "#a9adb3",
    "steel": "#6e7074",
    "chain": "#8c8f94",
    "black": "#151515",
    "saddle": "#222222",
    "bottle": "#e8e8e8",
    "cable": "#303030",
    "skin": "#d9a882",
    "kit": "#1f4e79",
    "helmet": "#f2f2f2",
}


def tube(category, a, b, radius, ya=0.0, yb=None, color=None, r_end=None):
    yb = ya if yb is None else yb
    path = [xyz(a, ya), xyz(b, yb)]
    params = {"path": path, "color": color or COLORS.get(category, "#777777")}
    if r_end is None:
        params["radius"] = radius
    else:
        params["stations"] = [{"at": 0, "radius": radius}, {"at": 1, "radius": r_end}]
    return add("sweep_profile", params, category, cd=cd_round(radius + (r_end or radius)))


def kammtail(chord, thickness, lead_sign, truncate=0.85, n=14):
    """Truncated NACA 00xx section in sweep section coords: x = half-thickness (lateral), y = chord axis (+y = toward world +Z)."""
    t = thickness / chord
    xs = [truncate * (1 - math.cos(math.pi * i / (n - 1))) / 2 for i in range(n)]
    half = [5 * t * chord * (0.2969 * math.sqrt(x) - 0.1260 * x - 0.3516 * x**2 + 0.2843 * x**3 - 0.1015 * x**4) for x in xs]
    centre = truncate * chord / 2
    upper = [[round(h, 3), round(lead_sign * (centre - x * chord), 3)] for x, h in zip(xs, half)]
    lower = [[-p[0], p[1]] for p in reversed(upper[1:])]
    return upper + lower


def lead_sign(a, b):
    """Sign of the section +y axis along the travel direction for a 2-point sweep in the XZ plane."""
    tx, tz = b[0] - a[0], b[1] - a[1]
    n = math.hypot(tx, tz)
    tx, tz = tx / n, tz / n
    yx = -tz * tx  # Z minus its tangent component, x part
    return 1.0 if yx >= 0 else -1.0


def aero_tube(category, a, b, chord, thickness, ya=0.0, yb=None, color=None):
    yb = ya if yb is None else yb
    section = kammtail(chord, thickness, lead_sign(a, b))
    return add("sweep_profile", {"path": [xyz(a, ya), xyz(b, yb)], "section": section, "color": color or COLORS[category]}, category,
               cd=cd_strut(chord * 0.85, thickness, kamm=True))


def ellipse_tube(category, a, b, rx, ry, ya=0.0, yb=None, color=None):
    yb = ya if yb is None else yb
    stations = [{"at": 0, "radiusX": rx, "radiusY": ry}, {"at": 1, "radiusX": rx, "radiusY": ry}]
    return add("sweep_profile", {"path": [xyz(a, ya), xyz(b, yb)], "stations": stations, "color": color or COLORS[category]}, category,
               cd=cd_strut(2 * ry, 2 * rx))


def revolve(category, centre, y, profile, color, segments=64, cd=BLUFF):
    """Solid of revolution about the wheel/BB axis (world Y) at (centre x, y, centre z); profile [[radial, axial]]."""
    return add(
        "revolve_profile",
        {"profile": profile, "axis": "y", "position": xyz(centre, y), "segments": segments, "color": color},
        category,
        cd=cd,
    )


GEAR_MODULE = PITCH / math.pi


def sprocket(category, centre, y, teeth, width, color):
    """Chainring / cog: involute stand-in with the chain pitch (module = p / pi), axis along -Y, centred on y."""
    return add(
        "add_spur_gear",
        {
            "module": round(GEAR_MODULE, 5),
            "teeth": teeth,
            "faceWidth": width,
            "bore": round(min(GEAR_MODULE * teeth / 2 * 0.55, 30), 2),
            "position": xyz(centre, y + width / 2),
            "rotation": [round(math.pi / 2, 6), 0, 0],
            "color": color,
        },
        category,
    )


# ---------------------------------------------------------------- setup
add("set_units", {"units": "mm"})
for name, value in [
    ("stack", STACK), ("reach", REACH), ("head_angle", HTA), ("seat_angle", STA), ("chainstay", CHAINSTAY),
    ("wheelbase", WHEELBASE), ("bb_drop", BB_DROP), ("wheel_radius", R_WHEEL), ("crank_length", CRANK),
    ("chainring", RING_BIG), ("cog", COG_IN_USE), ("chain_pitch", PITCH),
]:
    add("set_parameter", {"name": name, "expression": str(value)})
add("create_material", {"name": "carbon", "density": 1.55, "densityUnit": "g/cm^3", "color": COLORS["frame"], "roughness": 0.35,
                        "finish": "carbon_twill", "color2": "#2a2a2a", "finishScale": 24, "clearcoat": 0.8})

# ---------------------------------------------------------------- frame
BB_Y = 86 / 2
add("add_cylinder", {"radius": 23, "height": 86, "position": xyz((0, H_BB)), "axis": [0, 1, 0], "color": COLORS["frame"]}, "frame")
ht_top_cap = along(HT_TOP, STEER_DOWN, -8)
ht_bot_cap = along(HT_BOTTOM, STEER_DOWN, 8)
tt_front = along(HT_TOP, STEER_DOWN, 20)
dt_front = along(HT_BOTTOM, STEER_DOWN, -35)
st_top = SEAT_CLUSTER
if not AERO:
    tube("frame", ht_top_cap, ht_bot_cap, 24, color=COLORS["frame"], r_end=28)  # tapered 1 1/8" - 1.5" head tube
    tube("frame", tt_front, st_top, 16)                                          # top tube
    tube("frame", dt_front, (0, H_BB), 23)                                       # down tube
    tube("frame", (0, H_BB), along(st_top, SEAT_UP, 25), 16)                     # seat tube
    for side in (1, -1):
        cs_end = (REAR_X, R_WHEEL)
        tube("frame", (12, H_BB), cs_end, 11, ya=side * 38, yb=side * (HUB_HALF_REAR - 5), r_end=8)  # chainstays
        tube("frame", along(st_top, SEAT_UP, -10), cs_end, 8, ya=side * 14, yb=side * (HUB_HALF_REAR - 5), r_end=6)  # seatstays
else:
    aero_tube("frame", ht_top_cap, ht_bot_cap, 70, 34)                            # narrow, deep head tube
    ellipse_tube("frame", tt_front, st_top, 12, 22)                              # tall narrow top tube
    aero_tube("frame", dt_front, (0, H_BB), 72, 26)                              # 2.8:1 truncated-airfoil down tube
    # seat tube hugs the rear wheel: straight airfoil, then a fairing that follows the tyre at 12 mm clearance
    aero_tube("frame", (0, H_BB), along(st_top, SEAT_UP, 25), 62, 24)
    for side in (1, -1):
        cs_end = (REAR_X, R_WHEEL)
        ellipse_tube("frame", (12, H_BB), cs_end, 8, 13, ya=side * 38, yb=side * (HUB_HALF_REAR - 5))
        aero_tube("frame", along(st_top, SEAT_UP, -150), cs_end, 26, 10, ya=side * 12, yb=side * (HUB_HALF_REAR - 5))  # dropped stays
    # out-of-the-box 1: integrated bottle/storage fairing fills the down-tube / seat-tube gap (no bottles in the wind)
    dt_mid = along(dt_front, ((0 - dt_front[0]), (H_BB - dt_front[1])), 0.55)
    st_low = along((0, H_BB), SEAT_UP, 170)
    add("sweep_profile", {"path": [xyz((dt_mid[0] - 10, dt_mid[1] + 25)), xyz((st_low[0] + 20, st_low[1]))],
                          "stations": [{"at": 0, "radiusX": 13, "radiusY": 30}, {"at": 0.45, "radiusX": 19, "radiusY": 75},
                                       {"at": 1, "radiusX": 12, "radiusY": 45}], "color": COLORS["frame"]}, "frame", cd=cd_strut(150, 38))

# seatpost + saddle
post_top = along(SADDLE, SEAT_UP, -35)
if AERO:
    aero_tube("seat", along(st_top, SEAT_UP, -60), post_top, 50, 20, color=COLORS["black"])
else:
    tube("seat", along(st_top, SEAT_UP, -60), post_top, 13.6, color=COLORS["black"])
saddle_z = SADDLE[1] - 12
sad_x = SADDLE[0]
add("loft_sections", {"sections": [
    {"center": [round(sad_x - 110, 2), 0, round(saddle_z + 4, 2)], "rotation": [0, round(math.pi / 2, 6), 0], "radiusX": 22, "radiusY": 70},
    {"center": [round(sad_x - 40, 2), 0, round(saddle_z, 2)], "rotation": [0, round(math.pi / 2, 6), 0], "radiusX": 18, "radiusY": 62},
    {"center": [round(sad_x + 60, 2), 0, round(saddle_z - 2, 2)], "rotation": [0, round(math.pi / 2, 6), 0], "radiusX": 14, "radiusY": 25},
    {"center": [round(sad_x + 150, 2), 0, round(saddle_z + 2, 2)], "rotation": [0, round(math.pi / 2, 6), 0], "radiusX": 12, "radiusY": 16},
], "color": COLORS["saddle"]}, "seat", cd=0.5)

# ---------------------------------------------------------------- fork + steerer + cockpit
crown = along(HT_BOTTOM, STEER_DOWN, 18)
axle_on_steer = (FRONT_X, R_WHEEL)
if AERO:
    add("add_box", {"size": [60, 120, 26], "position": xyz(crown), "rotation": [0, round(rad(90 - HTA), 6), 0], "color": COLORS["fork"]}, "fork")
    for side in (1, -1):  # wide-stance blades: 18 mm more air between blade and spokes (track-bike trick)
        aero_tube("fork", along(crown, STEER_DOWN, 10), axle_on_steer, 50, 18, ya=side * 62, yb=side * (HUB_HALF_FRONT + 10))
else:
    add("add_box", {"size": [40, 100, 30], "position": xyz(crown), "rotation": [0, round(rad(90 - HTA), 6), 0], "color": COLORS["fork"]}, "fork")
    for side in (1, -1):
        tube("fork", along(crown, STEER_DOWN, 10), axle_on_steer, 16, ya=side * 48, yb=side * (HUB_HALF_FRONT + 6), r_end=10)

SPACERS = 0 if FIT else 15
steer_top = along(HT_TOP, STEER_DOWN, -(15 + SPACERS + 20))  # headset cap + spacers + stem clamp centre
tube("cockpit", along(HT_TOP, STEER_DOWN, -8), steer_top, 15.9, color=COLORS["black"])
stem_dir = (math.cos(rad(-17 if FIT else -6)), math.sin(rad(-17 if FIT else -6)))  # stem angle (from horizontal), 110 mm
bar_c = along(steer_top, stem_dir, 110)
BAR_HALF = 180 if AERO else 210
hood = (bar_c[0] + 75, bar_c[1] + 10)
if AERO:
    aero_tube("cockpit", steer_top, bar_c, 50, 22, color=COLORS["black"])  # integrated bar-stem, cables inside
    for side in (1, -1):
        add("sweep_profile", {"path": [[round(bar_c[0], 2), 0, round(bar_c[1], 2)], [round(bar_c[0], 2), side * (BAR_HALF - 25), round(bar_c[1], 2)]],
                              "section": [[-6, -22], [6, -22], [6, 10], [3, 22], [-3, 22], [-6, 10]], "color": COLORS["black"]}, "cockpit",
            cd=cd_strut(44, 12, kamm=True))
else:
    tube("cockpit", steer_top, bar_c, 17, color=COLORS["black"])
    add("add_cylinder", {"radius": 15.9, "height": 2 * (BAR_HALF - 25), "position": xyz(bar_c), "axis": [0, 1, 0], "color": COLORS["black"]}, "cockpit")
for side in (1, -1):
    y = side * BAR_HALF
    drop_path = [
        [round(bar_c[0], 2), side * (BAR_HALF - 25 if AERO else BAR_HALF - 25), round(bar_c[1], 2)],
        [round(bar_c[0] + 45, 2), y, round(bar_c[1] + 2, 2)],
        [round(hood[0] + 10, 2), y, round(bar_c[1] - 40, 2)],
        [round(bar_c[0] + 60, 2), y, round(bar_c[1] - 110, 2)],
        [round(bar_c[0] + 5, 2), y, round(bar_c[1] - 125, 2)],
        [round(bar_c[0] - 40, 2), y, round(bar_c[1] - 115, 2)],
    ]
    add("sweep_profile", {"path": drop_path, "smooth": True, "radius": 11.9, "color": "#3a3a3a"}, "cockpit", cd=cd_round(23.8))
    add("loft_sections", {"sections": [  # brake/shift hood
        {"center": [round(hood[0] - 20, 2), y, round(hood[1] - 8, 2)], "rotation": [0, round(math.pi / 2, 6), 0], "radiusX": 20, "radiusY": 16},
        {"center": [round(hood[0] + 30, 2), y, round(hood[1] + 6, 2)], "rotation": [0, round(math.pi / 2, 6), 0], "radiusX": 24, "radiusY": 17},
        {"center": [round(hood[0] + 55, 2), y, round(hood[1] + 12, 2)], "rotation": [0, round(math.pi / 2, 6), 0], "radiusX": 14, "radiusY": 12},
    ], "color": COLORS["black"]}, "cockpit", cd=0.6)
    tube("cockpit", (hood[0] + 50, hood[1]), (hood[0] + 40, hood[1] - 95), 6, ya=y, color=COLORS["black"])  # lever blade
    if not AERO:  # external brake / shift housings: the classic "cable loops"
        add("sweep_profile", {"path": [
            [round(hood[0] - 10, 2), side * (BAR_HALF - 10), round(hood[1] - 15, 2)],
            [round(hood[0] - 40, 2), side * (BAR_HALF - 60), round(bar_c[1] - 30, 2)],
            [round(bar_c[0] - 10, 2), side * 120, round(bar_c[1] - 90, 2)],
            [round(HT_TOP[0] + 60, 2), side * 60, round(HT_TOP[1] - 40, 2)],
            [round(HT_TOP[0] - 10, 2), side * 30, round(HT_TOP[1] - 60, 2)],
        ], "smooth": True, "radius": 2.5, "color": COLORS["cable"]}, "cockpit", cd=cd_round(5))

# ---------------------------------------------------------------- wheels
FRONT = (FRONT_X, R_WHEEL)
REAR = (REAR_X, R_WHEEL)
RIM_DEPTH = (65, None) if AERO else (25, 25)  # (front, rear) rim depth; None = disc


def rim_profile(depth, width=21.0):
    r0 = BSD / 2 + 4  # bead hook top
    return [[r0, -width / 2], [r0, width / 2], [r0 - depth + 4, width / 2 - 1], [r0 - depth, 4], [r0 - depth, -4], [r0 - depth + 4, -width / 2 + 1]]


def tyre_profile():
    r_c = BSD / 2 + TYRE / 2 - 1
    pts = []
    for i in range(24):
        a = 2 * math.pi * i / 24
        pts.append([round(r_c + (TYRE / 2 + 0.5) * math.cos(a), 3), round((TYRE / 2) * math.sin(a), 3)])
    return pts


def wheel(category, centre, depth, half, spokes, bladed):
    revolve(category, centre, 0, tyre_profile(), COLORS["rubber"], 72, cd=cd_round(TYRE))
    if depth is None:  # disc wheel: lenticular, 44 mm thick at the hub; frontal drag of a 2:1 lens, sides are skin friction only
        revolve(category, centre, 0, [[BSD / 2 + 4, -10.5], [BSD / 2 + 4, 10.5], [40, 22], [0, 22], [0, -22], [40, -22]], COLORS["rim"], 72,
                cd=cd_strut(BSD, 44))
        revolve(category, centre, 0, [[0, -half], [22, -half], [22, half], [0, half]], COLORS["alloy"])
        return
    # rim + tyre act as one section: box rim (depth 25) blunt; deep rim (65) a 3.3:1 tyre-led profile
    revolve(category, centre, 0, rim_profile(depth), COLORS["rim"], 72, cd=0.8 if depth < 40 else cd_strut(depth + TYRE, TYRE))
    revolve(category, centre, 0, [[6, -half], [28, -half], [28, -half + 4], [13, -half + 8], [13, half - 8], [28, half - 4], [28, half], [6, half]],
            COLORS["alloy"])  # hub with flanges
    r_in = BSD / 2 + 4 - depth + 1
    per_side = spokes // 2
    for k, side in enumerate((1, -1)):
        start = (centre[0], centre[1] + 26)
        end = (centre[0], centre[1] + r_in)
        rot0 = k * math.pi / per_side
        ys, ye = side * (half - 4), side * 3
        a = (centre[0] + 26 * math.sin(rot0), centre[1] + 26 * math.cos(rot0))
        b = (centre[0] + r_in * math.sin(rot0), centre[1] + r_in * math.cos(rot0))
        if bladed:
            sp = add("sweep_profile", {"path": [xyz(a, ys), xyz(b, ye)], "section": [[-0.45, -1.15], [0.45, -1.15], [0.45, 1.15], [-0.45, 1.15]],
                                       "color": COLORS["black"]}, category, cd=cd_strut(2.3, 0.9))
            cd = cd_strut(2.3, 0.9)
        else:
            sp = add("sweep_profile", {"path": [xyz(a, ys), xyz(b, ye)], "radius": 1.0, "color": COLORS["steel"]}, category, cd=cd_round(2))
            cd = cd_round(2)
        add("array_polar", {"id": f"${sp}", "count": per_side, "center": xyz(centre), "axis": [0, 1, 0]}, category, cd=cd)


wheel("wheel_front", FRONT, RIM_DEPTH[0], HUB_HALF_FRONT - 5, 24 if not AERO else 20, AERO)
wheel("wheel_rear", REAR, RIM_DEPTH[1], HUB_HALF_REAR - 8, 28, False)

# disc brakes: 160 mm rotors front and rear
for centre, y, cat in ((FRONT, HUB_HALF_FRONT - 12, "wheel_front"), (REAR, HUB_HALF_REAR - 14, "wheel_rear")):
    revolve(cat, centre, y, [[45, -0.9], [80, -0.9], [80, 0.9], [45, 0.9]], "#b8bcc2")
    add("add_box", {"size": [60, 28, 34], "position": xyz((centre[0] - 50, centre[1] + 50), y + 10), "rotation": [0, round(-0.5, 4), 0],
                    "color": COLORS["black"]}, "frame" if cat == "wheel_rear" else "fork")

# ---------------------------------------------------------------- drivetrain
BB = (0, H_BB)
ring_y = CHAIN_Y
sprocket("crankset", BB, ring_y, RING_BIG, 1.8, "#2e2e2e")
sprocket("crankset", BB, ring_y + 7, RING_SMALL, 1.8, "#2e2e2e")
if AERO:  # out-of-the-box 2: chainring disc cover (no spider windows) + full chain fairing on the top run
    revolve("crankset", BB, ring_y - 2.5, [[0, -1.2], [pitch_radius(RING_BIG) - 9, -1.2], [pitch_radius(RING_BIG) - 9, 1.2], [0, 1.2]], "#1d1f24",
            cd=0.3)
add("add_cylinder", {"radius": 12, "height": Q_FACTOR - 20, "position": xyz(BB), "axis": [0, 1, 0], "color": COLORS["alloy"]}, "crankset")
pedal_front = (BB[0] + CRANK, BB[1])
pedal_back = (BB[0] - CRANK, BB[1])
for p, y in ((pedal_front, -1), (pedal_back, 1)):  # cranks at 3 / 9 o'clock (the wind-tunnel reference pose)
    add("sweep_profile", {"path": [xyz(BB, y * (Q_FACTOR / 2 - 14)), xyz(p, y * (Q_FACTOR / 2 - 4))],
                          "stations": [{"at": 0, "radiusX": 9, "radiusY": 20}, {"at": 1, "radiusX": 7, "radiusY": 12}], "color": "#2e2e2e"}, "crankset")
    add("add_box", {"size": [90, 60, 14], "position": xyz((p[0], p[1] - 4), y * (Q_FACTOR / 2 + 30)), "color": COLORS["black"]}, "crankset")
for i, teeth in enumerate(CASSETTE):
    sprocket("cassette", REAR, CASSETTE_SMALL_Y + i * COG_SPACING, teeth, 1.6, "#9a9ea4")

# rear derailleur: guide + tension pulleys; tension pulley position solves a whole number of links
r_ring, r_cog, r_pul = pitch_radius(RING_BIG), pitch_radius(COG_IN_USE), pitch_radius(PULLEY_TEETH)
guide = (REAR[0] - 8, REAR[1] - (r_cog + r_pul + 10))
CAGE = 72.0


def tangent_loop_length(circles):
    """Length of the CCW outer belt around circles (x, z, r) in order (open-belt tangents + wrap arcs)."""
    n = len(circles)
    total = 0.0
    out_angles = []
    for i in range(n):
        (x1, z1, r1), (x2, z2, r2) = circles[i], circles[(i + 1) % n]
        dx, dz = x2 - x1, z2 - z1
        d = math.hypot(dx, dz)
        phi = math.atan2(dz, dx)
        beta = math.acos((r1 - r2) / d)
        ang = phi - beta  # touch angle on circle 1 (right-hand outer tangent for CCW travel)
        total += math.sqrt(d * d - (r1 - r2) ** 2)
        out_angles.append((ang, i))
    for i in range(n):
        leave = out_angles[i][0]
        arrive = out_angles[i - 1][0]
        sweep = (leave - arrive) % (2 * math.pi)
        total += circles[i][2] * sweep
    return total


def loop_circles(cage_angle):
    tension = (guide[0] + CAGE * math.sin(cage_angle), guide[1] - CAGE * math.cos(cage_angle))
    return [(BB[0], BB[1], r_ring), (REAR[0], REAR[1], r_cog), (guide[0], guide[1], r_pul), (tension[0], tension[1], r_pul)], tension


# CCW order (x forward = right, z up): chainring -> cog (over the top) -> guide -> tension -> chainring (under)
def length_at(a):
    circles, _ = loop_circles(a)
    return tangent_loop_length([circles[0], circles[1], circles[2], circles[3]])


base_len = length_at(0.3)
links = 2 * round(base_len / PITCH / 2 + 0.5)
lo, hi = -0.6, 1.2  # cage angle (rad, + swings the tension pulley forward)
target = links * PITCH
f = lambda a: length_at(a) - target
for _ in range(80):
    mid = (lo + hi) / 2
    if (f(lo) > 0) == (f(mid) > 0):
        lo = mid
    else:
        hi = mid
CAGE_ANGLE = (lo + hi) / 2
circles, tension = loop_circles(CAGE_ANGLE)
for c in (guide, tension):
    sprocket("derailleur", c, CHAIN_Y, PULLEY_TEETH, 2.4, COLORS["black"])
for dy in (-4.5, 4.5):
    add("sweep_profile", {"path": [xyz(guide, CHAIN_Y + dy), xyz(tension, CHAIN_Y + dy)], "section": [[-1, -14], [1, -14], [1, 14], [-1, 14]],
                          "color": "#2a2a2a"}, "derailleur")
add("add_box", {"size": [40, 30, 50], "position": xyz((REAR[0] - 10, REAR[1] - 30), CHAIN_Y - 22), "color": COLORS["black"]}, "derailleur")
add("add_box", {"size": [50, 22, 25], "position": xyz(along(SEAT_CLUSTER, SEAT_UP, -SEAT_TUBE + r_ring + 70), CHAIN_Y - 10),
                "color": COLORS["black"]}, "derailleur")  # front derailleur

# chain centreline (pitch line) + one link of each kind, laid round it, link count printed in the summary
# CCW loop (ring -> cog over the top -> guide -> tension -> ring): the polyline runs backward along the top run
add("draw_belt_around", {"pulleys": [{"center": [round(x, 3), round(z, 3)], "radius": round(r, 4)} for x, z, r in circles],
                                "arcSamples": 24, "position": [0, CHAIN_Y, 0], "rotation": [round(math.pi / 2, 8), 0, 0],
                                "name": "chain pitch line", "color": "#444444"}, None, "chainpath")
half = PITCH / 2
plate = [[-half - 3.6, -3.7], [half + 3.6, -3.7], [half + 3.6, 3.7], [-half - 3.6, 3.7]]
# link frame: +X along the chain, +Y in the chain plane, +Z = plane normal (world -Y). Inner link: plates + rollers (7.75 mm).
inner_parts = []
for z in (1.45, -1.45):
    inner_parts.append(add("extrude_profile", {"profile": plate, "depth": 0.8, "position": [0, 0, round(z - 0.4, 3)], "color": COLORS["chain"]}))
for x in (-half, half):
    inner_parts.append(add("add_cylinder", {"radius": 3.87, "height": 2.2, "position": [x, 0, 0], "color": "#6a6d72"}))
outer_parts = []
for z in (2.45, -2.45):
    outer_parts.append(add("extrude_profile", {"profile": plate, "depth": 0.8, "position": [0, 0, round(z - 0.4, 3)], "color": "#b5b8bd"}))
for x in (-half, half):
    outer_parts.append(add("add_cylinder", {"radius": 1.85, "height": 5.6, "position": [x, 0, 0], "color": "#d0d2d5"}))
add("create_component", {"name": "chain inner link", "entityIds": [f"${a}" for a in inner_parts], "componentId": "comp-chain-inner"}, alias="innerinst")
add("create_component", {"name": "chain outer link", "entityIds": [f"${a}" for a in outer_parts], "componentId": "comp-chain-outer"}, alias="outerinst")
add("delete_entities", {"ids": ["$innerinst", "$outerinst"]})
add("pattern_along_path", {"componentId": "comp-chain-inner", "count": links // 2, "pathId": "$chainpath"}, "chain", "chain_inner")
add("pattern_along_path", {"componentId": "comp-chain-outer", "count": links // 2, "pathId": "$chainpath", "startOffset": PITCH}, "chain", "chain_outer")
if AERO:  # chain fairing over the top run (out-of-the-box 2, cont.)
    top_a = (BB[0] - 20, BB[1] + r_ring + 6)
    top_b = (REAR[0] + 45, REAR[1] + r_cog + 6)
    add("sweep_profile", {"path": [xyz(top_a, CHAIN_Y), xyz(top_b, CHAIN_Y)], "section": [[-9, -12], [9, -12], [9, 12], [-9, 12]], "color": "#1d1f24"},
        "frame", cd=0.3)

# ---------------------------------------------------------------- bottles
if not AERO:
    dt_dir = ((0 - dt_front[0]), (H_BB - dt_front[1]))
    n = math.hypot(*dt_dir)
    dt_dir = (dt_dir[0] / n, dt_dir[1] / n)
    normal = (-dt_dir[1], dt_dir[0])  # points up-back from the down tube
    for s0, off, ref, d in ((0.35, 50, dt_front, dt_dir), (0.30, 45, (0, H_BB), SEAT_UP)):
        length = n if ref is dt_front else SEAT_TUBE
        c = along(ref, d, s0 * length + 110)
        nn = normal if ref is dt_front else (SEAT_UP[1], -SEAT_UP[0])
        c = (c[0] + nn[0] * off, c[1] + nn[1] * off)
        a = along(c, d, -105)
        b = along(c, d, 105)
        add("sweep_profile", {"path": [xyz(a), xyz(b)], "radius": 37, "color": COLORS["bottle"]}, "bottles", cd=cd_round(74))
else:
    # aero bottle tucked behind the seat tube in the wheel cut-out shadow (behind and below the saddle, in the frame's wake)
    pass

# ---------------------------------------------------------------- rider (1.80 m, 75 kg), hands on the hoods, cranks horizontal
THIGH, SHANK = 440.0, 430.0
hip = (SADDLE[0] + 35, SADDLE[1] + 65)


def knee_of(hip_p, ankle_p):
    dx, dz = ankle_p[0] - hip_p[0], ankle_p[1] - hip_p[1]
    d = min(math.hypot(dx, dz), THIGH + SHANK - 1)
    a = math.atan2(dz, dx)
    cos_h = (THIGH**2 + d**2 - SHANK**2) / (2 * THIGH * d)
    h = math.acos(max(-1, min(1, cos_h)))
    ang = a + h  # knee bends forward/up
    return (hip_p[0] + THIGH * math.cos(ang), hip_p[1] + THIGH * math.sin(ang))


torso_angle = rad(26 if FIT else 38)  # hip -> shoulder, from horizontal (hoods, bent elbows / forearms flat)
shoulder = (hip[0] + 560 * math.cos(torso_angle), hip[1] + 560 * math.sin(torso_angle))
neck = (shoulder[0] + 80, shoulder[1] + (40 if FIT else 60))
head = (neck[0] + 75, neck[1] + (55 if FIT else 70))
rider = "rider"
for pedal, y in ((pedal_front, -1), (pedal_back, 1)):
    ankle = (pedal[0] - 20, pedal[1] + 85)
    hy = y * 95
    kn = knee_of(hip, ankle)
    add("sweep_profile", {"path": [xyz(hip, hy), xyz(kn, y * 105)], "stations": [{"at": 0, "radius": 82}, {"at": 1, "radius": 52}], "color": COLORS["kit"]}, rider)
    add("sweep_profile", {"path": [xyz(kn, y * 105), xyz(ankle, y * (Q_FACTOR / 2 + 25))], "stations": [{"at": 0, "radius": 52}, {"at": 0.35, "radius": 56}, {"at": 1, "radius": 36}], "color": COLORS["skin"]}, rider)
    add("sweep_profile", {"path": [xyz((ankle[0] - 40, ankle[1] - 20), y * (Q_FACTOR / 2 + 30)), xyz((pedal[0] + 110, pedal[1] + 12), y * (Q_FACTOR / 2 + 30))],
                          "stations": [{"at": 0, "radiusX": 42, "radiusY": 38}, {"at": 1, "radiusX": 40, "radiusY": 22}], "color": COLORS["helmet"]}, rider)
spine = (shoulder[0] - hip[0], shoulder[1] - hip[1])
sec_rot = [0, round(math.pi / 2 - torso_angle, 6), 0]
torso_sections = []
for t, rx, ry in ((0.0, 110, 165), (0.45, 115, 160), (0.85, 120, 195), (1.0, 100, 175)):
    c = (hip[0] + spine[0] * t, hip[1] + spine[1] * t)
    torso_sections.append({"center": xyz(c), "rotation": sec_rot, "radiusX": rx, "radiusY": ry})
add("loft_sections", {"sections": torso_sections, "color": COLORS["kit"]}, rider)
tube(rider, shoulder, neck, 55, color=COLORS["skin"])
add("add_sphere", {"radius": 95, "position": xyz(head), "color": COLORS["skin"]}, rider)
ROT_X = [0, round(math.pi / 2, 6), 0]  # section plane facing the travel direction: radiusX = height, radiusY = width
add("loft_sections", {"sections": [  # road helmet, 270 x 210 mm
    {"center": xyz((head[0] + 128, head[1] + 30)), "rotation": ROT_X, "radiusX": 12, "radiusY": 20},
    {"center": xyz((head[0] + 100, head[1] + 40)), "rotation": ROT_X, "radiusX": 55, "radiusY": 80},
    {"center": xyz((head[0] + 30, head[1] + 55)), "rotation": ROT_X, "radiusX": 85, "radiusY": 105},
    {"center": xyz((head[0] - 50, head[1] + 45)), "rotation": ROT_X, "radiusX": 80, "radiusY": 100},
    {"center": xyz((head[0] - 115, head[1] + 25)), "rotation": ROT_X, "radiusX": 40, "radiusY": 65},
    {"center": xyz((head[0] - 135, head[1] + 15)), "rotation": ROT_X, "radiusX": 8, "radiusY": 15},
], "color": COLORS["helmet"]}, rider)
UPPER_ARM, FOREARM = 320.0, 300.0
for y in (1, -1):
    sh = (shoulder[0], shoulder[1])
    hand = (hood[0] + 10, hood[1] + 15)
    shy, hy = y * 185, y * BAR_HALF
    d3 = math.sqrt((hand[0] - sh[0]) ** 2 + (hand[1] - sh[1]) ** 2 + (hy - shy) ** 2)
    # elbow: bend down/out so that |shoulder-elbow| = upper arm, |elbow-hand| = forearm
    mid = ((sh[0] + hand[0]) / 2, (sh[1] + hand[1]) / 2)
    reach_half = d3 / 2
    drop = math.sqrt(max(0.0, ((UPPER_ARM + FOREARM) / 2) ** 2 - reach_half**2))
    dx, dz = hand[0] - sh[0], hand[1] - sh[1]
    nrm = math.hypot(dx, dz)
    elbow = (mid[0] + drop * dz / nrm * 0.6, mid[1] - drop * dx / nrm * 0.6)
    ey = y * (max(abs(shy), abs(hy)) + 0.4 * drop)
    add("sweep_profile", {"path": [xyz(sh, shy), xyz(elbow, ey)], "stations": [{"at": 0, "radius": 50}, {"at": 1, "radius": 40}], "color": COLORS["kit"]}, rider)
    add("sweep_profile", {"path": [xyz(elbow, ey), xyz(hand, hy)], "stations": [{"at": 0, "radius": 40}, {"at": 1, "radius": 30}], "color": COLORS["skin"]}, rider)

plan = {"actions": actions}
meta = {
    "variant": VARIANT,
    "categories": categories,
    "drag": drag,
    "links": links,
    "chain_length_mm": round(links * PITCH, 1),
    "cage_angle_deg": round(math.degrees(CAGE_ANGLE), 2),
    "points": {
        "bb": BB, "rear_axle": REAR, "front_axle": FRONT, "ht_top": HT_TOP, "ht_bottom": HT_BOTTOM, "saddle": SADDLE,
        "guide": guide, "tension": tension, "bar": bar_c, "hood": hood,
    },
    "radii": {"ring": r_ring, "cog": r_cog, "pulley": r_pul, "wheel": R_WHEEL},
    "chain_y": CHAIN_Y,
    "trail_mm": round((R_WHEEL * math.cos(rad(HTA)) - (FRONT_X - (HT_TOP[0] + (HT_TOP[1] - R_WHEEL) / math.tan(rad(HTA)))) * math.sin(rad(HTA))) / math.sin(rad(HTA)), 1),
    "fork_offset_mm": round((FRONT_X - (HT_TOP[0] + (HT_TOP[1] - R_WHEEL) / math.tan(rad(HTA)))) * math.sin(rad(HTA)), 1),
}
json.dump(plan, sys.stdout, indent=1)
with open(f"{VARIANT}.meta.json", "w") as fh:
    json.dump(meta, fh, indent=1)
