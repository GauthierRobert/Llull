"""Pass 2 for the welded S5 document: PBR materials, decals, layers + named groups, the drivetrain animation (Play) and
the physics model of the chain drive carrying the measured road load.

Usage: python3 organize.py [s5 | s5x]  (reads <v>.plan/parts/meta/run/welds/aero json)  -> <v>.organize.json"""

import json
import math
import sys

V = sys.argv[1] if len(sys.argv) > 1 else "s5"
PLAYBACK = 0.25  # the viewport plays at quarter speed; physics runs at real speed
CADENCE_RPM = 90.0

plan = json.load(open(f"{V}.plan.json"))["actions"]
parts = json.load(open(f"{V}.parts.json"))
meta = json.load(open(f"{V}.meta.json"))
steps = json.load(open(f"{V}.run.json"))["data"]["steps"]
welds = json.load(open(f"{V}.welds.json"))
aero = json.load(open(f"{V}.aero.json"))

alias_ids = {a["as"]: s["affected"] for a, s in zip(plan, steps)}
welded = {m: w["id"] for w in welds.values() for m in w["members"]}
ids_by_cat, ids_by_mat = {}, {}
for action in plan:
    alias = action["as"]
    if alias not in parts:
        continue
    info = parts[alias]
    for i in alias_ids[alias]:
        i = welded.get(i, i)
        for table, key in ((ids_by_cat, info["category"]), (ids_by_mat, info["material"])):
            if key and i not in table.setdefault(key, []):
                table[key].append(i)

FRAME_BLUE = "#12668e"  # Reef Blue, as the 2025 S5 Ultegra Di2
MATERIALS = {  # name: (density g/cm3, colour, metalness, roughness, extra)
    "carbon_frame": (1.55, FRAME_BLUE, 0.55, 0.26, {"finish": "carbon_twill", "color2": "#0d5374", "finishScale": 22, "normalStrength": 0.2,
                                                   "clearcoat": 1.0}),
    "carbon_black": (1.55, "#18181a", 0.15, 0.36, {"finish": "carbon_twill", "color2": "#2a2a2d", "finishScale": 16, "clearcoat": 0.9}),
    "carbon_rim": (1.55, "#1a1a1c", 0.1, 0.38, {"finish": "carbon_twill", "color2": "#2c2c2f", "finishScale": 18, "clearcoat": 0.7}),
    "rubber": (1.15, "#1d1d1d", 0.0, 0.88, {}),
    "rubber_hood": (1.1, "#1b1b1b", 0.0, 0.78, {}),
    "bar_tape": (1.0, "#141414", 0.0, 0.92, {}),
    "saddle": (1.0, "#1c1c1c", 0.0, 0.62, {}),
    "alloy": (2.7, "#b8bcc1", 1.0, 0.32, {"finish": "brushed", "finishScale": 30}),
    "black_anod": (2.7, "#202022", 0.6, 0.42, {}),
    "steel": (7.85, "#a3a7ad", 1.0, 0.28, {}),
    "spoke": (7.85, "#141414", 0.5, 0.4, {}),
    "rotor": (7.85, "#c4c8cc", 1.0, 0.3, {"finish": "brushed", "finishScale": 20}),
    "kit": (1.0, "#23324a", 0.0, 0.7, {}),
    "skin": (1.0, "#d2a07c", 0.0, 0.55, {}),
    "shoe": (1.0, "#f0f0f0", 0.0, 0.35, {}),
    "helmet": (1.0, "#f4f4f4", 0.0, 0.3, {}),
    "glove": (1.0, "#1e1e1e", 0.0, 0.8, {}),
}
actions = []
for name, (rho, color, metal, rough, extra) in MATERIALS.items():
    actions.append({"command": "create_material", "params": {"name": name, "density": rho, "densityUnit": "g/cm^3", "color": color,
                                                              "metalness": metal, "roughness": rough, **extra}})
    if ids_by_mat.get(name):
        actions.append({"command": "assign_material", "params": {"materialName": name, "entityIds": ids_by_mat[name]}})

# decals: lime CERVELO on both sides of the down tube, S5 on the seat tube, RESERVE on the rims
frame_id = welds["frame"]["id"]
fork_id = welds["fork"]["id"]
bb, ht_bot = meta["points"]["bb"], meta["points"]["ht_bottom"]
dt_mid = [bb[0] + (ht_bot[0] - bb[0]) * 0.52, 0, bb[2] + (ht_bot[2] - bb[2]) * 0.52]
dt_angle = math.atan2(ht_bot[2] - bb[2], ht_bot[0] - bb[0])
for side in (1, -1):
    actions.append({"command": "add_decal", "params": {"id": frame_id, "text": "CERVELO", "at": [round(dt_mid[0], 2), side * 22.0, round(dt_mid[2], 2)],
                                                       "normal": [0, side, 0], "height": 46, "angle": round(dt_angle if side < 0 else -dt_angle, 4),
                                                       "color": "#c6e43a"}})
    actions.append({"command": "add_decal", "params": {"id": fork_id, "text": "S5", "at": [round(meta["points"]["front_axle"][0] - 62, 2), side * 64.0, 520],
                                                       "normal": [0, side, 0], "height": 22, "angle": round(-1.27 * side, 4), "color": "#f2f2f2"}})
for axle, rim_alias_cat in ((meta["points"]["front_axle"], "wheel_front"), (meta["points"]["rear_axle"], "wheel_rear")):
    rim = [i for i in ids_by_mat["carbon_rim"] if i in ids_by_cat[rim_alias_cat]][0]
    for side in (1, -1):
        actions.append({"command": "add_decal", "params": {"id": rim, "text": "RESERVE", "at": [round(axle[0], 2), side * 16.0, round(axle[2] + 286, 2)],
                                                           "normal": [0, side, 0], "height": 18, "color": "#f2f2f2"}})

LAYERS = {"frame": "Frame", "fork": "Fork", "cockpit": "Cockpit", "seat": "Saddle + post", "wheel_front": "Front wheel",
          "wheel_rear": "Rear wheel", "cassette": "Cassette", "crankset": "Crankset", "derailleur": "Derailleurs", "chain": "Chain",
          "rider": "Rider"}
for cat, name in LAYERS.items():
    if not ids_by_cat.get(cat):
        continue
    actions.append({"command": "add_layer", "params": {"name": name}, "as": f"layer_{cat}"})
    actions += [{"command": "set_entity_layer", "params": {"entityId": i, "layerId": f"$layer_{cat}"}} for i in ids_by_cat[cat]]
actions.append({"command": "add_layer", "params": {"name": "Construction (chain pitch line)"}, "as": "layer_construction"})
actions.append({"command": "set_entity_layer", "params": {"entityId": alias_ids["chainpath"][0], "layerId": "$layer_construction"}})
actions.append({"command": "update_layer", "params": {"id": "$layer_construction", "visible": False}})
actions.append({"command": "set_entity_name", "params": {"id": frame_id, "name": "S5 frame"}})
actions.append({"command": "set_entity_name", "params": {"id": fork_id, "name": "S5 fork"}})
actions.append({"command": "set_entity_name", "params": {"id": welds["stem"]["id"], "name": "One-piece cockpit"}})
actions.append({"command": "assign_material", "params": {"materialName": "carbon_black", "entityIds": [welds["stem"]["id"]]}})

guide_id, tension_id = alias_ids[meta["aliases"]["guide"]][0], alias_ids[meta["aliases"]["tension"]][0]
groups = {"front_wheel": ("Front wheel", ids_by_cat["wheel_front"]), "rear_wheel": ("Rear wheel + cassette", ids_by_cat["wheel_rear"] + ids_by_cat["cassette"]),
          "crankset": ("Crankset", ids_by_cat["crankset"]), "chain": (f"Chain ({meta['links']} links)", ids_by_cat["chain"]),
          "rider": ("Rider", ids_by_cat["rider"])}
for key, (name, ids) in groups.items():
    actions.append({"command": "group_entities", "params": {"ids": ids, "name": name}, "as": f"g_{key}"})
actions.append({"command": "set_entity_name", "params": {"id": guide_id, "name": "Guide pulley 13T"}})
actions.append({"command": "set_entity_name", "params": {"id": tension_id, "name": "Tension pulley 13T"}})

pts, radii = meta["points"], meta["radii"]
w_crank = CADENCE_RPM * 2 * math.pi / 60
w_wheel = w_crank * 52 / 15
v_chain = w_crank * radii["ring"]
xyz = lambda p: [round(p[0], 3), 0, round(p[2], 3)]
for target, w, centre in (("$g_front_wheel", w_wheel, pts["front_axle"]), ("$g_rear_wheel", w_wheel, pts["rear_axle"]), ("$g_crankset", w_crank, pts["bb"]),
                          (guide_id, v_chain / radii["pulley"], pts["guide"]), (tension_id, v_chain / radii["pulley"], pts["tension"])):
    actions.append({"command": "animate", "params": {"targetId": target, "mode": "spin", "speed": round(w * PLAYBACK, 5), "axis": [0, 1, 0], "pivot": xyz(centre)}})
actions.append({"command": "animate", "params": {"targetId": "$g_chain", "mode": "follow_path", "pathId": alias_ids["chainpath"][0],
                                                "speed": round(-v_chain * PLAYBACK, 4)}})

# physics: frame on the ground, rider holds 90 rpm, chain = coupling crank -> rear (+52/15), road = rear -> front (1:1),
# road load at 40 km/h (aero + rolling + bearings of this bike) as the equivalent damping on the rear wheel joint
road = aero["breakdownAt40kmh"]
w_road = 40 / 3.6 / (radii["wheel"] / 1000)
load_damping = (road["aeroW"] + road["rollingW"] + road["bearingW"]) / w_road**2
fixed = [i for c in ("frame", "fork", "cockpit", "seat", "derailleur") for i in ids_by_cat.get(c, [])]
for key, ids, extra in (("frame", fixed, {"fixed": True, "massKg": 1.9}), ("crank", ids_by_cat["crankset"], {"massKg": 0.7}),
                        ("rear", ids_by_cat["wheel_rear"] + ids_by_cat["cassette"], {"massKg": 1.6}), ("front", ids_by_cat["wheel_front"], {"massKg": 0.85})):
    actions.append({"command": "add_rigid_body", "params": {"entityIds": ids, "name": key, "id": f"body-{key}", **extra}})
for key, centre, damping in (("crank", pts["bb"], 0.002), ("rear", pts["rear_axle"], load_damping), ("front", pts["front_axle"], 0.002)):
    actions.append({"command": "add_body_joint", "params": {"kind": "revolute", "child": f"body-{key}", "anchor": xyz(centre), "axis": [0, 1, 0],
                                                           "id": f"joint-{key}", "damping": round(damping, 6)}})
actions.append({"command": "add_gear_coupling", "params": {"driver": "joint-crank", "driven": "joint-rear", "ratio": round(52 / 15, 6), "id": "chain-drive"}})
actions.append({"command": "add_gear_coupling", "params": {"driver": "joint-rear", "driven": "joint-front", "ratio": 1, "id": "road-contact"}})
actions.append({"command": "add_motor", "params": {"joint": "joint-crank", "kind": "speed", "rpm": CADENCE_RPM, "maxTorque": 80, "id": "rider-legs"}})
json.dump({"actions": actions}, open(f"{V}.organize.json", "w"), indent=1)
print(f"{len(actions)} organize actions; road-load damping {load_damping:.4f} N m s/rad")
