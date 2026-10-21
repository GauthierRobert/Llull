#!/usr/bin/env python3
"""VLM input for HALO in cruise (llull analyze_vortex_lattice): the ring wing as a closed loop of sections plus the
exit vanes as four full-span surfaces through the axis (0, 45, 90, 135 deg). Frame: x downstream from the ring LE.

    python3 make_vlm.py ringLe ringChord vaneX vaneChord vaneTipR cgX > vlm.json
"""
import json
import math
import sys

ring_le, ring_chord, vane_x, vane_chord, vane_tip, cg_x = map(float, sys.argv[1:7])
n = 32
ring = [{"leadingEdge": [0, round(ring_le * math.cos(2 * math.pi * k / n), 4), round(ring_le * math.sin(2 * math.pi * k / n), 4)], "chord": ring_chord} for k in range(n + 1)]
surfaces = [{"name": "ring", "sections": ring, "mirror": False, "spanwisePanels": 96, "chordwisePanels": 6}]
for deg in (0, 45, 90, 135):
    t = math.radians(deg)
    secs = [{"leadingEdge": [vane_x, round(r * math.cos(t), 4), round(r * math.sin(t), 4)], "chord": vane_chord} for r in (-vane_tip, vane_tip)]
    surfaces.append({"name": f"vanes_{deg}", "sections": secs, "mirror": False, "spanwisePanels": 12, "chordwisePanels": 3, "naca": "0010"})
print(json.dumps({"surfaces": surfaces, "alphasDeg": [0, 2, 4], "referenceArea": 2 * ring_le * ring_chord, "referenceChord": ring_chord, "referencePoint": [cg_x, 0, 0]}, indent=1))
