"""
Pass 2 plan for a built bike document: layers + named groups, the viewport animation of the drivetrain (Play button) and
the physics model of the chain drive (simulate_motion / render_motion).

  crank speed      w_c = 90 rpm x PLAYBACK            (rider cadence)
  chain speed      v_chain = w_c * r_ring             (pitch radius of the 52T ring), links travel round the pitch line
  rear wheel       w_r = w_c * 52 / 15                (the chain couples ring and cog: same linear speed at both pitch circles)
  front wheel      w_f = w_r                          (same rolling radius)
  pulleys          w_p = v_chain / r_pulley

Usage: python3 organize.py <variant> > <variant>.organize.json
"""

import json
import math
import sys

variant = sys.argv[1]
PLAYBACK = 0.25  # viewport plays at quarter speed so spokes and links stay readable; physics runs at real speed
CADENCE_RPM = 90.0
plan = json.load(open(f"{variant}.plan.json"))["actions"]
meta = json.load(open(f"{variant}.meta.json"))
run = json.load(open(f"{variant}.run.json"))["data"]
solids = {e["id"] for e in run["scene"]["entities"]}

ids_by_category = {}
alias_ids = {}
for action, step in zip(plan, run["steps"]):
    alias = action.get("as")
    alias_ids[alias] = step["affected"]
    category = meta["categories"].get(alias)
    if category:
        ids_by_category.setdefault(category, []).extend(i for i in step["affected"] if i in solids)

LAYERS = {
    "frame": ("Frame", "#c8102e"), "fork": ("Fork", "#c8102e"), "seat": ("Saddle + post", "#222222"), "cockpit": ("Cockpit", "#333333"),
    "wheel_front": ("Front wheel", "#2b2b2b"), "wheel_rear": ("Rear wheel", "#2b2b2b"), "cassette": ("Cassette", "#9a9ea4"),
    "crankset": ("Crankset", "#2e2e2e"), "derailleur": ("Derailleurs", "#151515"), "chain": ("Chain", "#8c8f94"),
    "bottles": ("Bottles", "#e8e8e8"), "rider": ("Rider", "#1f4e79"),
}
pts, radii = meta["points"], meta["radii"]
xyz = lambda p, y=0.0: [round(p[0], 3), round(y, 3), round(p[1], 3)]
actions = []
for category, (name, color) in LAYERS.items():
    if category not in ids_by_category:
        continue
    key = f"layer_{category}"
    actions.append({"command": "add_layer", "params": {"name": name, "color": color}, "as": key})
    actions += [{"command": "set_entity_layer", "params": {"entityId": i, "layerId": f"${key}"}} for i in ids_by_category[category]]

# the chain pitch line is construction geometry: the links and the follow_path animation already carry it
actions.append({"command": "add_layer", "params": {"name": "Construction (chain pitch line)"}, "as": "layer_construction"})
actions.append({"command": "set_entity_layer", "params": {"entityId": alias_ids["chainpath"][0], "layerId": "$layer_construction"}})
actions.append({"command": "update_layer", "params": {"id": "$layer_construction", "visible": False}})

guide_alias, tension_alias = [a["as"] for a in plan if a["command"] == "add_spur_gear" and meta["categories"].get(a["as"]) == "derailleur"]
guide_ids, tension_ids = alias_ids[guide_alias], alias_ids[tension_alias]
groups = {
    "front_wheel": ("Front wheel", ids_by_category["wheel_front"]),
    "rear_wheel": ("Rear wheel + cassette", ids_by_category["wheel_rear"] + ids_by_category["cassette"]),
    "crankset": ("Crankset", ids_by_category["crankset"]),
    "chain": ("Chain (%d links)" % meta["links"], ids_by_category["chain"]),
    "rider": ("Rider", ids_by_category["rider"]),
}
for key, (name, ids) in groups.items():
    actions.append({"command": "group_entities", "params": {"ids": ids, "name": name}, "as": f"g_{key}"})
for alias, label in ((guide_ids[0], "Guide pulley 13T"), (tension_ids[0], "Tension pulley 13T")):
    actions.append({"command": "set_entity_name", "params": {"id": alias, "name": label}})

w_crank = CADENCE_RPM * 2 * math.pi / 60
w_wheel = w_crank * 52 / 15
v_chain = w_crank * radii["ring"]  # mm/s
axis = [0, 1, 0]  # +Y: wheels and cranks turn forward for travel along +X
spins = [("$g_front_wheel", w_wheel, pts["front_axle"]), ("$g_rear_wheel", w_wheel, pts["rear_axle"]), ("$g_crankset", w_crank, pts["bb"]),
         (guide_ids[0], v_chain / radii["pulley"], pts["guide"]), (tension_ids[0], v_chain / radii["pulley"], pts["tension"])]
for target, w, centre in spins:
    actions.append({"command": "animate", "params": {"targetId": target, "mode": "spin", "speed": round(w * PLAYBACK, 5), "axis": axis,
                                                    "pivot": xyz(centre, 0)}})
# the pitch-line polyline runs counter-clockwise (backward along the top run): the chain moves forward on top, so speed < 0
actions.append({"command": "animate", "params": {"targetId": "$g_chain", "mode": "follow_path", "pathId": alias_ids["chainpath"][0],
                                                "speed": round(-v_chain * PLAYBACK, 4)}})

# physics: frame welded to ground, crankset driven at 90 rpm, chain = gear coupling ring -> rear wheel (+52/15, same direction)
frame_ids = [i for c in ("frame", "fork", "seat", "cockpit", "derailleur") for i in ids_by_category.get(c, [])]
bodies = [
    ("frame", frame_ids, {"fixed": True, "massKg": 1.6}),
    ("crank", ids_by_category["crankset"], {"massKg": 0.7}),
    ("rear", ids_by_category["wheel_rear"] + ids_by_category["cassette"], {"massKg": 1.75}),
    ("front", ids_by_category["wheel_front"], {"massKg": 0.85}),
]
for key, ids, extra in bodies:
    actions.append({"command": "add_rigid_body", "params": {"entityIds": ids, "name": key, "id": f"body-{key}", **extra}})
# road load at 40 km/h (aero + rolling + bearings, from aero.py / road_load_power) as an equivalent viscous damping on the
# rear wheel: c = P_wheel / w^2, so the motor holding 90 rpm delivers the variant's real power at the cranks (exact at 40 km/h)
road = json.load(open("aero_results.json"))[variant]["breakdownAt40kmh"]
w_road = 40 / 3.6 / (radii["wheel"] / 1000)
load_damping = (road["aeroW"] + road["rollingW"] + road["bearingW"]) / w_road**2
for key, centre, damping in (("crank", pts["bb"], 0.002), ("rear", pts["rear_axle"], load_damping), ("front", pts["front_axle"], 0.002)):
    actions.append({"command": "add_body_joint", "params": {"kind": "revolute", "child": f"body-{key}", "anchor": xyz(centre), "axis": axis,
                                                           "id": f"joint-{key}", "damping": round(damping, 6)}})
actions.append({"command": "add_gear_coupling", "params": {"driver": "joint-crank", "driven": "joint-rear", "ratio": round(52 / 15, 6),
                                                          "id": "chain-drive"}})
# rolling without slip on the road: both wheels share the ground speed (same rolling radius) -> 1:1
actions.append({"command": "add_gear_coupling", "params": {"driver": "joint-rear", "driven": "joint-front", "ratio": 1, "id": "road-contact"}})
actions.append({"command": "add_motor", "params": {"joint": "joint-crank", "kind": "speed", "rpm": CADENCE_RPM, "maxTorque": 80, "id": "rider-legs"}})
json.dump({"actions": actions}, sys.stdout, indent=1)
