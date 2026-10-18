"""Reference values with pye57 0.4.19 (libE57Format) for E57 files: scans, point counts, header bounds, pose, data bounds/centroid
(local and transformed to the file frame). Usage: venv/bin/python -I e57_pye57_reference.py FILE..."""
import sys, json, hashlib
import numpy as np
import pye57

def ref(path):
    out = {'file': path.split('/')[-1], 'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest(), 'scans': []}
    try:
        e = pye57.E57(path)
    except Exception as exc:
        out['error'] = type(exc).__name__ + ': ' + str(exc)[:200]
        return out
    out['scanCount'] = e.scan_count
    for i in range(e.scan_count):
        h = e.get_header(i)
        s = {'pointCount': int(h.point_count), 'fields': list(h.point_fields)}
        try:
            s['rotationWXYZ'] = [float(v) for v in h.rotation]; s['translation'] = [float(v) for v in h.translation]
        except Exception:
            pass
        if h.point_count > 0 and 'cartesianX' in h.point_fields:
            d = e.read_scan(i, ignore_missing_fields=True, intensity=False, colors=False, row_column=False, transform=False)
            p = np.column_stack([d['cartesianX'], d['cartesianY'], d['cartesianZ']]).astype(float)
            s['localMin'] = p.min(0).round(6).tolist(); s['localMax'] = p.max(0).round(6).tolist(); s['localCentroid'] = p.mean(0).round(6).tolist()
            d2 = e.read_scan(i, ignore_missing_fields=True, intensity=False, colors=False, row_column=False, transform=True)
            q = np.column_stack([d2['cartesianX'], d2['cartesianY'], d2['cartesianZ']]).astype(float)
            s['fileFrameCentroid'] = q.mean(0).round(6).tolist()
        out['scans'].append(s)
    return out

print(json.dumps([ref(p) for p in sys.argv[1:]], indent=1))
