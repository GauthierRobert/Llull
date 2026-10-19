"""Variant switches for the S5 generator. `s5` is the stock 2023 bike; `s5x` is the optimised "S5 Aero+" built from the
stock bike's drag ranking (front wheel > cockpit > frame > fork > crankset > seat)."""

STOCK = {
    # frame sections: kamm (chord, thickness, lead) per station; top tube superellipse (vertical, lateral) half-sizes
    "ht": [(112, 54, 34), (102, 50, 31), (90, 46, 28)],
    "tt": [(21, 13), (18, 12), (17, 12.5)],
    "dt": [(80, 36, 30), (70, 31, 26), (64, 31, 24), (70, 46, 24)],
    "st": (66, 28, 27), "st_low": (74, 40, 30), "st_clearance": 12,
    "ss": [(30, 15, 11), (25, 12.5, 9), (21, 11, 8)],
    "blades": [(56, 22, 22), (48, 17, 19), (38, 12, 15)],
    "post": [(52, 24, 20), (50, 22, 19)],
    # cockpit
    "bar_half": 200.0, "stem_deg": -10.0, "spacers": 0.0, "wing": (54, 15, 22), "wing_centre": (60, 24, 26), "hood_width": 1.0,
    # wheels: rim depth, spoke count, tyre width
    "front": (52, 24, 28.0), "rear": (63, 24, 28.0),
    # drivetrain
    "rings": (52, 36), "front_derailleur": True, "ring_cover": False,
    "saddle_width": 72, "fit": False,
}

AERO_PLUS = dict(STOCK)
AERO_PLUS.update({
    "ht": [(122, 54, 38), (112, 48, 35), (100, 44, 32)],
    "tt": [(22, 11), (19, 10.5), (18, 11)],
    "dt": [(90, 32, 34), (82, 26, 30), (76, 26, 28), (74, 44, 26)],
    "st": (78, 24, 30), "st_low": (82, 38, 32), "st_clearance": 10,
    "ss": [(32, 12, 12), (27, 10.5, 10), (22, 9.5, 8)],
    "blades": [(66, 18, 26), (58, 15, 22), (46, 12, 18)],
    "post": [(70, 20, 26), (68, 19, 25)],
    "bar_half": 180.0, "stem_deg": -17.0, "wing": (62, 12, 24), "wing_centre": (66, 22, 28), "hood_width": 0.85,
    "front": (65, 18, 25.0),
    "rings": (52,), "front_derailleur": False, "ring_cover": True,
    "saddle_width": 64,
})

# the same Aero+ bike with the position it is built for: 330 mm hoods, forearms level on the hoods, aero road helmet
AERO_PLUS_FIT = dict(AERO_PLUS)
AERO_PLUS_FIT.update({"bar_half": 165.0, "fit": True})

VARIANTS = {"s5": STOCK, "s5x": AERO_PLUS, "s5xf": AERO_PLUS_FIT}
O = dict(STOCK)
NAME = ["s5"]


def use(variant):
    O.clear()
    O.update(VARIANTS[variant])
    NAME[0] = variant
