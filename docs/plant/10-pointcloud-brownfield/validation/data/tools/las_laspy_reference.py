"""Reference values with laspy 2.7.0 (+ lazrs 0.8.2 for LAZ): header fields and values recomputed from the decoded points.
Usage: venv/bin/python -I las_laspy_reference.py FILE..."""
import sys, json
import numpy as np
import laspy

def ref(path):
    las = laspy.read(path)
    h = las.header
    x, y, z = np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)
    r = {'file': path.split('/')[-1], 'version': str(h.version), 'pointFormat': h.point_format.id, 'headerPointCount': int(h.point_count),
         'decodedPoints': int(len(las.points)), 'headerMin': [float(v) for v in h.mins], 'headerMax': [float(v) for v in h.maxs],
         'dataMin': [float(x.min()), float(y.min()), float(z.min())] if len(x) else None,
         'dataMax': [float(x.max()), float(y.max()), float(z.max())] if len(x) else None,
         'centroid': [round(float(v.mean()), 6) for v in (x, y, z)] if len(x) else None,
         'scale': [float(v) for v in h.scales], 'offset': [float(v) for v in h.offsets],
         'vlrCount': len(las.vlrs), 'evlrCount': len(las.evlrs or []),
         'returnNumberHistogram': np.bincount(np.asarray(las.return_number)).tolist(),
         'classificationHistogram': {int(k): int(v) for k, v in zip(*np.unique(np.asarray(las.classification), return_counts=True))}}
    return r

print(json.dumps([ref(p) for p in sys.argv[1:]], indent=1))
