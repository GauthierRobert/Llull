"""Variant switches for the S5 generator. `s5` is the stock 2025 bike; `s5x` is the optimised "S5 Aero+" built from the
stock bike's drag ranking (front wheel > cockpit > frame > fork > crankset > seat)."""

STOCK = {
    # frame / fork sections are traced (frame.py); these scale their depth (chord) and width; post = (depth, width)
    "frame": (1.0, 1.0), "fork": (1.0, 1.0), "unit": (1.0, 1.0), "post": (44, 24),
    # cockpit
    "bar_half": 200.0, "stem_deg": 22.0, "spacers": 0.0, "wing": (54, 15, 22), "wing_centre": (60, 24, 26), "hood_width": 1.0,
    # wheels: rim depth, spoke count, tyre width
    "front": (57, 24, 28.0), "rear": (64, 24, 28.0),
    # drivetrain
    "rings": (52, 36), "front_derailleur": True, "ring_cover": False,
    "saddle_width": 72, "fit": False,
}

AERO_PLUS = dict(STOCK)
AERO_PLUS.update({
    "frame": (1.12, 0.85), "fork": (1.15, 0.82), "post": (60, 20),
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
