"""Cervélo S5 (2023, size 56, Dura-Ace Di2, Reserve 52 | 63) with a working chain drive: pass-1 build plan.

Writes s5.plan.json (geometry, as a build_project plan), s5.parts.json (per-part aero category, drag coefficient,
material, weld group) and s5.meta.json (key points, chain data). weld.py then fuses the frame, fork and stem;
organize.py adds materials, decals, layers, animation and physics; aero.py measures. Run everything with ./build.sh."""

import json

import frame as F
import parts as P
from plan import Plan

COLORS = {
    "frame": "#8a2116", "tape": "#121212", "hood": "#1b1b1b", "lever": "#2b2b2d", "black": "#141414", "saddle": "#1e1e1e",
    "tyre": "#1c1c1c", "rim": "#18181a", "hub": "#1f1f1f", "spoke": "#101010", "rotor": "#b9bdc2", "ring": "#2a2a2c",
    "crank": "#2a2a2c", "pedal": "#1a1a1a", "cog": "#9da1a7", "pulley": "#1b1b1b", "rd": "#26262a", "alloy": "#b4b8bd",
    "chain_in": "#8d9196", "chain_out": "#b3b6ba", "roller": "#6f7378", "pin": "#d0d2d5",
    "kit": "#23324a", "skin": "#d2a07c", "shoe": "#efefef", "helmet": "#f4f4f4", "glove": "#202020",
}


def main():
    plan = Plan()
    plan.raw("set_units", {"units": "mm"})
    for name, value in [("stack", F.STACK), ("reach", F.REACH), ("head_angle", F.HTA), ("seat_angle", F.STA), ("chainstay", F.CHAINSTAY),
                        ("wheelbase", F.WHEELBASE), ("bb_drop", F.BB_DROP), ("wheel_radius", F.R_WHEEL), ("crank_length", P.CRANK),
                        ("chainring", 52), ("cog", P.COG_IN_USE), ("chain_pitch", P.PITCH)]:
        plan.raw("set_parameter", {"name": name, "expression": str(value)})
    F.build_frame(plan, COLORS)
    offset, trail = F.build_fork(plan, COLORS)
    cockpit = F.build_cockpit(plan, COLORS)
    saddle = F.build_seat(plan, COLORS)
    P.build_wheels(plan, COLORS)
    drive = P.build_drivetrain(plan, COLORS)
    rider = P.build_rider(plan, COLORS, saddle, cockpit["hood"], cockpit["bar_half"])
    json.dump({"actions": plan.actions}, open("s5.plan.json", "w"), indent=1)
    json.dump(plan.parts, open("s5.parts.json", "w"), indent=1)
    meta = {
        "links": drive["links"], "chain_length_mm": drive["chain_length_mm"], "radii": drive["radii"], "chain_y": P.CHAIN_Y,
        "fork_offset_mm": offset, "trail_mm": trail, "torso_deg": rider["torso_deg"],
        "points": {"bb": F.BB, "rear_axle": F.REAR, "front_axle": F.FRONT, "guide": drive["guide"], "tension": drive["tension"],
                   "ht_top": F.HT_TOP, "ht_bottom": F.HT_BOT, "bar": cockpit["bar"], "hood": cockpit["hood"], "saddle": saddle},
        "aliases": {"guide": drive["guide_id"], "tension": drive["tension_id"], "chainpath": "chainpath"},
        "geometry": {"stack": F.STACK, "reach": F.REACH, "hta": F.HTA, "sta": F.STA, "chainstay": F.CHAINSTAY, "wheelbase": F.WHEELBASE,
                     "bb_drop": F.BB_DROP, "head_tube": F.HEAD_TUBE},
    }
    json.dump(meta, open("s5.meta.json", "w"), indent=1)
    print(f"{len(plan.actions)} actions, {drive['links']} links ({drive['chain_length_mm']} mm), offset {offset} trail {trail}, torso {rider['torso_deg']} deg")


if __name__ == "__main__":
    main()
