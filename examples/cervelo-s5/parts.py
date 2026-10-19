"""Wheels (Reserve 52 | 63 style), Dura-Ace R9200 2x12 drivetrain with real tooth profiles, a figure-8-plate chain, the
derailleurs, and a lofted rider. Every part is tagged with its aero category, drag coefficient and material."""

import math

from geom import add, sub, mul, lerp, superellipse, section_frame, ring_cage, ring, rnd, pitch_radius, sprocket_outline
from plan import cd_strut, BLUFF
import frame as F
from options import O

BSD = 622.0
TYRE = 28.0
CHAIN_Y = -48.5
CASSETTE = [11, 12, 13, 14, 15, 17, 19, 21, 24, 27, 30, 34]  # Ultegra R8100 11-34
COG_IN_USE = 15
CASSETTE_SMALL_Y, COG_SPACING = -63.0, 3.5
CRANK = 170.0  # size 56 spec
Q_FACTOR = 148.0
PULLEY_TEETH = 13
PITCH = 12.7
LINK_HALF = PITCH / 2


def wheel_point(axle, r, theta, y):
    """Point at radius r, angle theta (0 = up, + toward travel) in a wheel plane at lateral y."""
    return [axle[0] + r * math.sin(theta), y, axle[2] + r * math.cos(theta)]


# ---------------------------------------------------------------- wheels


def rim_profile(depth, w_bead=15.6, w_max=16.0, w_bed=10.5, n=14):
    """Deep carbon rim cross-section (radial, axial): bead hooks at 314 mm, toroidal flanks, round spoke bed."""
    top = BSD / 2 + 3
    right = []
    for i in range(n):
        d = (depth - w_bed * 0.7) * i / (n - 1)
        k = d / (depth - w_bed * 0.7)
        w = w_bead + (w_max - w_bead) * math.sin(math.pi * min(k, 0.5)) if k < 0.5 else w_max - (w_max - w_bed) * ((k - 0.5) / 0.5) ** 1.4
        right.append((top - d, w))
    rc = top - (depth - w_bed * 0.7)
    bottom = [(rc - w_bed * 0.7 * math.sin(t), w_bed * math.cos(t)) for t in [math.pi * j / 10 for j in range(1, 10)]]
    left = [(r, -w) for r, w in reversed(right)]
    return right + bottom + left


def tyre_profile(width=TYRE):
    """Tyre section of the given width with its tread at the rolling radius (a narrower tyre sits deeper in the rim)."""
    h = width / 2
    rc = F.R_WHEEL - h
    pts = []
    for i in range(40):
        t = -math.pi / 2 + math.pi * 2 * i / 40
        r, a = rc + h * math.cos(t), (h + 0.6) * math.sin(t)
        if r >= BSD / 2 + 1:
            pts.append((r, a))
    pts.sort(key=lambda p: math.atan2(p[1], p[0] - rc))
    return pts


def hub_profile(half, flange_l, flange_r, rf):
    return [(6, -half), (10.5, -half), (10.5, -half + 4), (14, -half + 6), (14, flange_l - 3), (rf - 2, flange_l - 2), (rf, flange_l - 0.5),
            (rf, flange_l + 1.5), (16, flange_l + 3), (15, 0), (16, flange_r - 3), (rf, flange_r - 1.5), (rf, flange_r + 0.5),
            (rf - 2, flange_r + 2), (14, flange_r + 3), (14, half - 6), (10.5, half - 4), (10.5, half), (6, half)]


def build_wheel(plan, axle, depth, half, flanges, spokes, rotor_r, rotor_y, category, colors, tyre=TYRE):
    plan.revolve(axle, tyre_profile(tyre), category, cd_strut(tyre, tyre), "rubber", colors["tyre"], 160)
    # a rim wider than the tyre (31 mm vs a 25c) carries the flow off the tyre: the rim+tyre section is one airfoil
    plan.revolve(axle, rim_profile(depth), category, cd_strut(depth + tyre, max(tyre, 31.0 if tyre < 28 else tyre)), "carbon_rim", colors["rim"], 160)
    plan.revolve(axle, hub_profile(half, flanges[0], flanges[1], 24), category, BLUFF, "alloy", colors["hub"], 64)
    r_in = BSD / 2 + 3 - depth + 4
    spokes_per_side = spokes // 2
    step = 2 * math.pi / spokes_per_side
    for k, y_f in enumerate(flanges):
        y_r = 2.5 if y_f > 0 else -2.5
        for sign in (1, -1):  # 2-cross: leading and trailing spokes, rim hole 60 deg from the hub hole
            th = (k * 0.5 + (0 if sign > 0 else 1)) * step
            a = wheel_point(axle, 21.5, th, y_f)
            b = wheel_point(axle, r_in, th + sign * 2 * step, y_r)
            tangent = sub(b, a)
            perp = [math.cos(th), 0, -math.sin(th)]  # in-plane, perpendicular to the radius: the blade faces the travel
            st = [(a, tangent, superellipse(1.2, 0.5, 4, 8), perp), (b, tangent, superellipse(1.1, 0.45, 4, 8), perp)]
            sp = plan.loft(st, category, cd_strut(2.3, 0.9), "spoke", color=colors["spoke"], ruled=True)
            plan.add("array_polar", {"id": f"${sp}", "count": spokes_per_side // 2, "center": rnd(axle), "axis": [0, 1, 0]},
                     category, cd_strut(2.3, 0.9), "spoke")
    # centre-lock rotor: braking band + 6-arm spider + carrier
    plan.revolve(axle, [(rotor_r - 17, -0.9), (rotor_r, -0.9), (rotor_r, 0.9), (rotor_r - 17, 0.9)], category, BLUFF, "rotor", colors["rotor"], 96)
    plan.revolve(axle, [(17, rotor_y - 2), (25, rotor_y - 2), (25, rotor_y + 2), (17, rotor_y + 2)], category, BLUFF, "black_anod", colors["black"], 48)
    a = wheel_point(axle, 22, 0, rotor_y)
    b = wheel_point(axle, rotor_r - 15, 0, rotor_y)
    arm = plan.loft([(a, sub(b, a), superellipse(6, 1.4, 4, 8), [1, 0, 0]), (b, sub(b, a), superellipse(4.5, 1.2, 4, 8), [1, 0, 0])],
                    category, BLUFF, "black_anod", color=colors["black"])
    plan.add("array_polar", {"id": f"${arm}", "count": 6, "center": rnd(axle), "axis": [0, 1, 0]}, category, BLUFF, "black_anod")
    # 12 mm thru-axle with its lever cap on the non-drive side
    plan.add("add_cylinder", {"radius": 6, "height": 2 * half + 18, "position": rnd(axle), "axis": [0, 1, 0], "color": colors["black"]},
             category, BLUFF, "black_anod")
    plan.revolve(add(axle, [0, half + 9, 0]), [(0, 0), (11, 0), (11, 4), (8, 7), (0, 7)], category, BLUFF, "black_anod", colors["black"], 32)


def caliper(plan, axle, theta, rotor_r, y, category, colors):
    """Flat-mount caliper straddling the rotor at angle theta: a smooth block, rounded by subdivision."""
    c = wheel_point(axle, rotor_r - 6, theta, y)
    t = [math.cos(theta), 0, -math.sin(theta)]  # tangential
    rings = []
    for s, a, b in ((-34, 12, 12), (-20, 17, 16), (0, 19, 17), (20, 17, 16), (34, 12, 12)):
        centre = add(c, mul(t, s))
        ex, ey, ez = section_frame(t, [math.sin(theta), 0, math.cos(theta)])
        rings.append((centre, ex, ey, ring(a, b, 8, 3)))
    v, f = ring_cage(rings)
    plan.cage(v, f, category, BLUFF, "black_anod", colors["black"])


def build_wheels(plan, colors):
    (fd, fs, ft), (rd, rs, rt) = O["front"], O["rear"]
    build_wheel(plan, F.FRONT, fd, F.HUB_FRONT, (-35, 35), fs, 80, 44, "wheel_front", colors, ft)
    build_wheel(plan, F.REAR, rd, F.HUB_REAR, (-22, 34), rs, 70, 47, "wheel_rear", colors, rt)
    caliper(plan, F.FRONT, math.radians(-62), 80, 50, "fork", colors)
    caliper(plan, F.REAR, math.radians(108), 70, 52, "frame", colors)


# ---------------------------------------------------------------- drivetrain


def sprocket(plan, centre, y, teeth, thickness, category, material, color, cd=BLUFF):
    """Tooth-profile plate in the wheel plane (outline u = +X, v = +Z), extruded toward -Y, centred on y."""
    return plan.plate(sprocket_outline(teeth), [centre[0], y + thickness / 2, centre[2]], [1, 0, 0], [0, 0, 1], thickness, category,
                      material, color, cd)


def hull2(c1, c2, r, k=12):
    """Outline (u, v) around two equal circles (pulley cage plate), CCW."""
    d = sub2(c2, c1)
    ang = math.atan2(d[1], d[0])
    pts = []
    for i in range(k + 1):
        a = ang + math.pi / 2 + math.pi * i / k
        pts.append([round(c1[0] + r * math.cos(a), 3), round(c1[1] + r * math.sin(a), 3)])
    for i in range(k + 1):
        a = ang - math.pi / 2 + math.pi * i / k
        pts.append([round(c2[0] + r * math.cos(a), 3), round(c2[1] + r * math.sin(a), 3)])
    return pts


def sub2(a, b):
    return [a[0] - b[0], a[1] - b[1]]


def chain_loop_length(circles):
    n, total, outs = len(circles), 0.0, []
    for i in range(n):
        (x1, z1, r1), (x2, z2, r2) = circles[i], circles[(i + 1) % n]
        d = math.hypot(x2 - x1, z2 - z1)
        total += math.sqrt(d * d - (r1 - r2) ** 2)
        outs.append(math.atan2(z2 - z1, x2 - x1) - math.acos((r1 - r2) / d))
    for i in range(n):
        total += circles[i][2] * ((outs[i] - outs[i - 1]) % (2 * math.pi))
    return total


def plate_outline(r_lobe, waist, k=10):
    """Figure-8 chain plate: two lobes of radius r_lobe at +-pitch/2 joined by a waist, CCW."""
    pts = []
    for i in range(k + 1):  # right lobe, -100..100 deg
        a = math.radians(-100 + 200 * i / k)
        pts.append((LINK_HALF + r_lobe * math.cos(a), r_lobe * math.sin(a)))
    pts.append((0, waist))
    for i in range(k + 1):  # left lobe, 80..280 deg
        a = math.radians(80 + 200 * i / k)
        pts.append((-LINK_HALF + r_lobe * math.cos(a), r_lobe * math.sin(a)))
    pts.append((0, -waist))
    return [[round(u, 3), round(v, 3)] for u, v in pts]


def build_drivetrain(plan, colors):
    bb, rear = F.BB, F.REAR
    # chainrings: 52 / 36 (or a single 52), the big ring a solid hollow-forged face like the R9200
    sprocket(plan, bb, CHAIN_Y, 52, 1.9, "crankset", "black_anod", colors["ring"])
    if O["ring_cover"]:  # flush outboard disc over the crank spider, out to the chain's pitch line
        plan.revolve(bb, [(0, CHAIN_Y - 3.2), (pitch_radius(52) - 8, CHAIN_Y - 3.2), (pitch_radius(52) - 8, CHAIN_Y - 1.0), (0, CHAIN_Y - 1.0)],
                     "crankset", 0.3, "carbon_black", colors["ring"], 96)
    plan.revolve(bb, [(0, CHAIN_Y + 1.0), (pitch_radius(52) - 7, CHAIN_Y + 1.0), (pitch_radius(52) - 7, CHAIN_Y + 4.5), (0, CHAIN_Y + 4.5)],
                 "crankset", BLUFF, "black_anod", colors["ring"], 96)
    if 36 in O["rings"]:
        sprocket(plan, bb, CHAIN_Y + 7.4, 36, 1.9, "crankset", "black_anod", colors["ring"])
    plan.add("add_cylinder", {"radius": 12, "height": Q_FACTOR - 18, "position": rnd(bb), "axis": [0, 1, 0], "color": colors["alloy"]},
             "crankset", BLUFF, "alloy")
    pedals = []
    for side, x in ((-1, CRANK), (1, -CRANK)):  # cranks at 3 / 9 o'clock (the wind-tunnel reference pose)
        y0, y1 = side * (Q_FACTOR / 2 - 20), side * (Q_FACTOR / 2 - 6)
        pts = [[bb[0], y0, bb[2]], [bb[0] + x * 0.35, side * (Q_FACTOR / 2 - 16), bb[2]], [bb[0] + x * 0.75, side * (Q_FACTOR / 2 - 10), bb[2]],
               [bb[0] + x, y1, bb[2]]]
        outs = [superellipse(22, 10, 3), superellipse(18, 9, 3), superellipse(14.5, 8, 3), superellipse(13, 8, 3)]
        F.tube(plan, pts, outs, "crankset", BLUFF, "black_anod", None, colors["crank"], hints=[[0, 0, 1]] * 4)
        # pedal: spindle + smooth body
        pc = [bb[0] + x, side * (Q_FACTOR / 2 + 30), bb[2] - 2]
        plan.add("add_cylinder", {"radius": 6, "height": 34, "position": rnd([bb[0] + x, side * (Q_FACTOR / 2 + 12), bb[2]]), "axis": [0, 1, 0],
                                  "color": colors["alloy"]}, "crankset", BLUFF, "alloy")
        rings = []
        for dx, a, b in ((-44, 6, 22), (-30, 8, 30), (0, 9, 32), (30, 8, 30), (44, 6, 22)):
            ex, ey, ez = section_frame([1, 0, 0], [0, 0, 1])
            rings.append((add(pc, [dx, 0, 0]), ex, ey, ring(a, b, 8, 3)))
        v, f = ring_cage(rings)
        pedals.append(plan.cage(v, f, "crankset", BLUFF, "black_anod", colors["pedal"]))
    # cassette 11-34 on the freehub, tooth profiles
    plan.revolve(rear, [(0, -64), (17, -64), (17, -24), (0, -24)], "cassette", BLUFF, "black_anod", colors["black"], 48)
    for i, teeth in enumerate(CASSETTE):
        sprocket(plan, rear, CASSETTE_SMALL_Y + i * COG_SPACING, teeth, 1.6, "cassette", "steel", colors["cog"])
    plan.revolve(rear, [(14, -67), (22, -67), (22, -64.5), (14, -64.5)], "cassette", BLUFF, "black_anod", colors["black"], 48)

    # rear derailleur: tension-pulley position solved so the chain is a whole number of links
    r_ring, r_cog, r_pul = pitch_radius(52), pitch_radius(COG_IN_USE), pitch_radius(PULLEY_TEETH)
    guide = [rear[0] - 6, rear[2] - (r_cog + r_pul + 9)]
    cage = 74.0

    def circles(angle):
        tension = [guide[0] + cage * math.sin(angle), guide[1] - cage * math.cos(angle)]
        return [(bb[0], bb[2], r_ring), (rear[0], rear[2], r_cog), (guide[0], guide[1], r_pul), (tension[0], tension[1], r_pul)], tension

    links = 2 * round(chain_loop_length(circles(0.3)[0]) / PITCH / 2 + 0.5)
    lo, hi = -0.6, 1.2
    for _ in range(80):
        mid = (lo + hi) / 2
        if (chain_loop_length(circles(lo)[0]) - links * PITCH > 0) == (chain_loop_length(circles(mid)[0]) - links * PITCH > 0):
            lo = mid
        else:
            hi = mid
    loop, tension = circles((lo + hi) / 2)
    gp = [guide[0], 0, guide[1]]
    tp = [tension[0], 0, tension[1]]
    guide_id = sprocket(plan, gp, CHAIN_Y, PULLEY_TEETH, 2.6, "derailleur", "black_anod", colors["pulley"])
    tension_id = sprocket(plan, tp, CHAIN_Y, PULLEY_TEETH, 2.6, "derailleur", "black_anod", colors["pulley"])
    outer = hull2([0, 0], [tension[0] - guide[0], tension[1] - guide[1]], 31)
    inner = hull2([0, 0], [tension[0] - guide[0], tension[1] - guide[1]], 26)
    plan.plate(outer, [guide[0], CHAIN_Y - 5.0, guide[1]], [1, 0, 0], [0, 0, 1], 2.2, "derailleur", "black_anod", colors["rd"])
    plan.plate(inner, [guide[0], CHAIN_Y + 7.2, guide[1]], [1, 0, 0], [0, 0, 1], 1.8, "derailleur", "black_anod", colors["rd"])
    # parallelogram + knuckles: one smooth body from the hanger (behind the axle) to the guide-pulley pivot
    hanger = [rear[0] - 6, -(F.HUB_REAR + 6), rear[2] - 14]
    pivot = [guide[0] + 4, CHAIN_Y - 14, guide[1] + 30]
    rings = []
    for t, a, b in ((0.0, 11, 7), (0.3, 14, 9), (0.65, 13, 8.5), (1.0, 10, 7)):
        centre = lerp(hanger, pivot, t)
        centre = add(centre, [-18 * math.sin(math.pi * t), -6 * math.sin(math.pi * t), 0])
        ex, ey, ez = section_frame(sub(pivot, hanger), [0, -1, 0])
        rings.append((centre, ex, ey, ring(b, a, 8, 3)))
    v, f = ring_cage(rings)
    plan.cage(v, f, "derailleur", BLUFF, "black_anod", colors["rd"])
    # front derailleur: braze-on body and a cage arc over the big ring (none on a 1x drivetrain)
    if O["front_derailleur"]:
        fd = F.on_seat(r_ring + 60)
        arc = []
        for deg in (104, 122, 140, 158):
            a = math.radians(deg)
            arc.append([bb[0] + (r_ring + 13) * math.cos(a), CHAIN_Y - 5, bb[2] + (r_ring + 13) * math.sin(a)])
        plan.add("sweep_profile", {"path": [rnd(p) for p in arc], "smooth": True, "section": [[-1, -9], [1, -9], [1, 9], [-1, 9]], "color": colors["rd"]},
                 "derailleur", BLUFF, "black_anod")
        rings = []
        for t, a, b in ((0, 10, 12), (0.5, 14, 15), (1, 10, 12)):
            centre = lerp(add(fd, [10, -30, -6]), add(arc[1], [0, -6, 8]), t)
            ex, ey, ez = section_frame([0.2, -1, -0.3], [0, 0, 1])
            rings.append((centre, ex, ey, ring(a, b, 8, 3)))
        v, f = ring_cage(rings)
        plan.cage(v, f, "derailleur", BLUFF, "black_anod", colors["rd"])

    # chain: pitch line round the four pitch circles, then 54 inner + 54 outer links (figure-8 plates, rollers, pins)
    plan.raw("draw_belt_around", {"pulleys": [{"center": [round(x, 3), round(z, 3)], "radius": round(r, 4)} for x, z, r in loop],
                                  "arcSamples": 32, "position": [0, CHAIN_Y, 0], "rotation": [round(math.pi / 2, 8), 0, 0],
                                  "name": "chain pitch line", "color": "#444444"}, alias="chainpath")
    inner_plate, outer_plate = plate_outline(4.55, 3.55), plate_outline(4.75, 3.75)
    parts_in, parts_out = [], []
    for z in (1.5, -1.5):
        parts_in.append(plan.raw("extrude_profile", {"profile": inner_plate, "depth": 0.8, "position": [0, 0, round(z - 0.4, 3)], "color": colors["chain_in"]}))
    for x in (-LINK_HALF, LINK_HALF):
        parts_in.append(plan.raw("add_cylinder", {"radius": 3.87, "height": 2.3, "position": [x, 0, 0], "color": colors["roller"]}))
    for z in (2.6, -2.6):
        parts_out.append(plan.raw("extrude_profile", {"profile": outer_plate, "depth": 0.8, "position": [0, 0, round(z - 0.4, 3)], "color": colors["chain_out"]}))
    for x in (-LINK_HALF, LINK_HALF):
        parts_out.append(plan.raw("add_cylinder", {"radius": 1.83, "height": 6.4, "position": [x, 0, 0], "color": colors["pin"]}))
    plan.raw("create_component", {"name": "chain inner link", "entityIds": [f"${a}" for a in parts_in], "componentId": "comp-chain-inner"}, alias="inner_inst")
    plan.raw("create_component", {"name": "chain outer link", "entityIds": [f"${a}" for a in parts_out], "componentId": "comp-chain-outer"}, alias="outer_inst")
    plan.raw("delete_entities", {"ids": ["$inner_inst", "$outer_inst"]})
    plan.add("pattern_along_path", {"componentId": "comp-chain-inner", "count": links // 2, "pathId": "$chainpath"}, "chain", BLUFF, "steel")
    plan.add("pattern_along_path", {"componentId": "comp-chain-outer", "count": links // 2, "pathId": "$chainpath", "startOffset": PITCH},
             "chain", BLUFF, "steel")
    return {"links": links, "chain_length_mm": round(links * PITCH, 1), "guide": gp, "tension": tp, "guide_id": guide_id,
            "tension_id": tension_id, "pedals": pedals, "radii": {"ring": r_ring, "cog": r_cog, "pulley": r_pul, "wheel": F.R_WHEEL}}


# ---------------------------------------------------------------- rider (1.80 m, 75 kg), hands on the hoods


def limb(plan, a, b, ra, rb, color, material, mid=None):
    pts = [a, lerp(a, b, 0.5), b]
    rm = mid if mid is not None else (ra + rb) / 2
    outs = [superellipse(ra, ra * 0.92, 2.0), superellipse(rm, rm * 0.9, 2.0), superellipse(rb, rb * 0.92, 2.0)]
    F.tube(plan, pts, outs, "rider", None, material, None, color)


def joint(plan, p, r, color, material):
    plan.add("add_sphere", {"radius": r, "position": rnd(p), "color": color}, "rider", None, material)


def build_rider(plan, colors, saddle_top, hood, bar_half, drivetrain_pedals=None):
    thigh, shank = 440.0, 430.0
    hip = add(saddle_top, [30, 0, 70])
    # torso angle: shoulders where the hands reach the hoods with elbows slightly bent (shoulder-grip 560 mm)
    best = None
    for deg in range(10, 70):
        a = math.radians(deg)
        sh = add(hip, [560 * math.cos(a), 0, 560 * math.sin(a)])
        err = abs(math.dist([sh[0], sh[2]], [hood[0], hood[2]]) - 520)
        if best is None or err < best[0]:
            best = (err, deg, sh)
    torso_deg, shoulder = best[1], best[2]
    fit = O.get("fit", False)
    if fit:  # "aero hoods": torso 17 deg, elbows bent so the forearms run about level onto the hoods
        torso_deg = 17.0
        a = math.radians(torso_deg)
        shoulder = add(hip, [560 * math.cos(a), 0, 560 * math.sin(a)])
    kit, skin = colors["kit"], colors["skin"]
    # legs: thigh / shank solved for cranks at 3 and 9 o'clock
    for side, x in ((-1, F.BB[0] + CRANK), (1, F.BB[0] - CRANK)):
        pedal = [x, side * (Q_FACTOR / 2 + 30), F.BB[2]]
        ankle = add(pedal, [-28, 0, 88])
        h = add(hip, [0, side * 95, 0])
        dx, dz = ankle[0] - h[0], ankle[2] - h[2]
        d = min(math.hypot(dx, dz), thigh + shank - 2)
        ang = math.atan2(dz, dx) + math.acos((thigh**2 + d * d - shank**2) / (2 * thigh * d))
        knee = [h[0] + thigh * math.cos(ang), side * 100, h[2] + thigh * math.sin(ang)]
        limb(plan, h, knee, 82, 56, kit, "kit", 72)
        joint(plan, knee, 55, skin, "skin")
        limb(plan, knee, ankle, 54, 37, skin, "skin", 56)
        # shoe: smooth body from heel to toe on the pedal
        rings = []
        for s, a, b in ((-0.05, 38, 36), (0.25, 44, 42), (0.6, 36, 46), (0.9, 26, 40), (1.05, 14, 26)):
            p = lerp(add(ankle, [-50, 0, -18]), add(pedal, [120, 0, 18]), s)
            ex, ey, ez = section_frame(sub(add(pedal, [120, 0, 18]), add(ankle, [-50, 0, -18])), [0, 0, 1])
            rings.append((p, ex, ey, ring(a, b, 8, 2.6)))
        v, f = ring_cage(rings)
        plan.cage(v, f, "rider", None, "shoe", colors["shoe"])
        joint(plan, h, 82, kit, "kit")
    # torso: pelvis -> chest -> shoulders, sections normal to the spine
    spine = sub(shoulder, hip)
    torso = []
    for t, a, b in ((0.0, 105, 165), (0.3, 100, 150), (0.62, 118, 175), (0.88, 112, 195), (1.0, 92, 175)):
        p = add(hip, mul(spine, t))
        torso.append((p, spine, superellipse(a, b, 2.3), [0, 0, 1]))
    plan.loft(torso, "rider", None, "kit", color=kit)
    neck = add(shoulder, [80, 0, 38]) if fit else add(shoulder, [70, 0, 55])
    head = add(neck, [82, 0, 46]) if fit else add(neck, [75, 0, 62])
    limb(plan, add(shoulder, [-10, 0, 0]), neck, 60, 52, skin, "skin")
    joint(plan, head, 96, skin, "skin")
    # road helmet (aero road helmet with the fit package: closed shell, tail running onto the back)
    rings = []
    shell = ((-138, 14, 10, 18), (-112, 30, 52, 74), (-50, 52, 82, 100), (30, 60, 86, 104), (98, 44, 58, 86), (128, 32, 14, 24))
    if fit:
        shell = ((-196, -2, 8, 14), (-150, 18, 42, 60), (-80, 44, 74, 92), (10, 56, 84, 100), (88, 44, 62, 88), (124, 30, 18, 28))
    for dx, dz, a, b in shell:
        ex, ey, ez = section_frame([1, 0, 0], [0, 0, 1])
        rings.append((add(head, [dx, 0, dz]), ex, ey, ring(a, b, 10, 2.4)))
    v, f = ring_cage(rings)
    plan.cage(v, f, "rider", None, "helmet", colors["helmet"])
    # arms to the hoods
    for side in (1, -1):
        sh = add(shoulder, [0, side * (175 if fit else 180), 0])
        joint(plan, sh, 56, kit, "kit")
        grip = [hood[0] + 8, side * bar_half, hood[2] + 16]
        mid = lerp(sh, grip, 0.5)
        ua, fa = 320.0, 300.0
        half = math.dist(sh, grip) / 2
        bend = math.sqrt(max(0.0, ((ua + fa) / 2) ** 2 - half**2))
        if fit:  # two-link arm: elbow on the circle of points 320 mm from the shoulder and 300 mm from the grip, lowest one
            d = math.dist(sh, grip)
            u = [(grip[i] - sh[i]) / d for i in range(3)]
            along = (ua**2 - fa**2 + d * d) / (2 * d)
            r = math.sqrt(max(0.0, ua**2 - along**2))
            down = [0, 0, -1.0]  # elbows bend straight down: in line between shoulder and hand, not flared
            k = sum(down[i] * u[i] for i in range(3))
            perp = [down[i] - k * u[i] for i in range(3)]
            n = math.sqrt(sum(c * c for c in perp))
            elbow = [sh[i] + u[i] * along + perp[i] / n * r for i in range(3)]
        else:
            elbow = add(mid, [0, side * bend * 0.45, -bend * 0.85])
        limb(plan, sh, elbow, 50, 40, kit, "kit", 46)
        joint(plan, elbow, 40, skin, "skin")
        limb(plan, elbow, grip, 39, 28, skin, "skin", 36)
        rings = []
        for t, a, b in ((0, 26, 30), (0.5, 30, 36), (1, 22, 26)):
            ex, ey, ez = section_frame([1, 0, -0.1], [0, 0, 1])
            rings.append((add(grip, [-10 + 50 * t, 0, -6]), ex, ey, ring(a, b, 8, 2.6)))
        v, f = ring_cage(rings)
        plan.cage(v, f, "rider", None, "glove", colors["glove"])
    return {"torso_deg": torso_deg}


