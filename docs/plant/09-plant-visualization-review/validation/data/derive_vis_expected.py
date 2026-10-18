"""Closed-form expectations of the 09 VIS pack (run: python3 -I derive_vis_expected.py).

Everything printed here is derived from (a) the synthetic benchmark definition in synthetic_pipe_rack_benchmark.json
(llull's own synthetic fixture, not a catalogue), (b) the three.js r186 source facts in threejs_r186_facts.json, and
(c) the BCF 3.0 example viewpoint in bcf_3_0/example_viewpoint_orthogonal.bcfv. No value is measured.
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
bench = json.load(open(os.path.join(HERE, 'synthetic_pipe_rack_benchmark.json')))

# 1. Component count N(n) = perBay * n + valvesPer4Bays * floor(n / 4)
per_bay = sum(p['perBay'] for p in bench['prototypes'].values())
valves_per_4 = sum(p.get('per4Bays', 0) for p in bench['prototypes'].values())


def components(n: int) -> int:
    return per_bay * n + valves_per_4 * (n // 4)


print('perBay', per_bay, 'valvesPer4Bays', valves_per_4)
for n in bench['sizes']['bays']:
    print('bays', n, 'components', components(n))

# 2. Draw-call upper bound (opaque model pass): LOD0 + LOD1 per prototype, LOD2 = one unit-box bucket per material class
prototypes = len(bench['prototypes'])
classes = len({p['materialClass'] for p in bench['prototypes'].values()})
print('prototypes', prototypes, 'materialClasses', classes, 'maxOpaqueCalls', 2 * prototypes + classes)

# 3. LOD switch distances: projected bbox diagonal p = D * H / (2 d tan(fov/2))  ->  d = D * H / (2 p tan(fov/2))
H = bench['lod']['viewportHeightPx']
fov = bench['lod']['fovDeg']
k = H / (2 * math.tan(math.radians(fov / 2)))
print('k', k)
for name, p in bench['prototypes'].items():
    D = math.sqrt(sum(x * x for x in p['bboxMm']))
    d = {t: k * D / px for t, px in bench['lod']['thresholdsPx'].items()}
    print(name, 'diag', round(D, 4), {t: round(v, 1) for t, v in d.items()})

# 4. GPU memory per instance (three r186 facts T1, T2)
for n_inst in (100_000, 1_000_000):
    instanced = n_inst * (64 + 12)
    side_m = max(4, math.ceil(math.sqrt(4 * n_inst) / 4) * 4)
    side_c = math.ceil(math.sqrt(n_inst))
    print(n_inst, 'InstancedMesh bytes', instanced, 'BatchedMesh tex sides', side_m, side_c,
          'bytes', side_m * side_m * 16 + side_c * side_c * 16 + side_c * side_c * 4)

# 5. BCF example camera -> llull CameraState angles (eye = target + dist * (sin p sin a, sin p cos a, cos p))
direction = (-0.8050867319107056, 0.5154458284378052, -0.29351478815078735)
up = (-0.24719256162643433, 0.15826167166233063, 0.9559545516967773)
norm = math.sqrt(sum(c * c for c in direction))
offset = [-c / norm for c in direction]
polar = math.acos(offset[2])
azimuth = math.atan2(offset[0], offset[1])
print('|dir|', norm, '|up|', math.sqrt(sum(c * c for c in up)), 'dir.up', sum(a * b for a, b in zip(direction, up)))
print('polar rad', polar, 'azimuth rad', azimuth)
print('eye mm', [c * 1000 for c in (18.674638207107783, -19.54805982455614, 10.538476791232824)], 'viewHeight mm', 9.673289179801941 * 1000)
