"""Independent LAS/LAZ public-header reader (ASPRS LAS 1.0-1.4 R15 Table 3/4). Reads files as data only.
Usage: python3 -I las_own_header.py FILE..."""
import sys, struct, json, hashlib

def header(path):
    raw = open(path, 'rb').read(375)
    full = open(path, 'rb').read()
    h = {'file': path.split('/')[-1], 'bytes': len(full), 'sha256': hashlib.sha256(full).hexdigest()}
    assert raw[:4] == b'LASF', raw[:4]
    h['fileSourceId'], h['globalEncoding'] = struct.unpack_from('<HH', raw, 4)
    h['versionMajor'], h['versionMinor'] = raw[24], raw[25]
    h['systemIdentifier'] = raw[26:58].split(b'\0')[0].decode('latin-1').strip()
    h['generatingSoftware'] = raw[58:90].split(b'\0')[0].decode('latin-1').strip()
    h['creationDayOfYear'], h['creationYear'], h['headerSize'] = struct.unpack_from('<HHH', raw, 90)
    h['offsetToPointData'], h['numberOfVlrs'] = struct.unpack_from('<II', raw, 96)
    fmt = raw[104]
    h['pointFormatRaw'] = fmt
    h['compressed'] = bool(fmt & 0x80)  # LAZ convention (LASzip): bit 7 set
    h['pointFormat'] = fmt & 0x3F
    h['pointRecordLength'], h['legacyPointCount'] = struct.unpack_from('<HI', raw, 105)
    h['legacyPointsByReturn'] = list(struct.unpack_from('<5I', raw, 111))
    h['scale'] = list(struct.unpack_from('<3d', raw, 131))
    h['offset'] = list(struct.unpack_from('<3d', raw, 155))
    maxx, minx, maxy, miny, maxz, minz = struct.unpack_from('<6d', raw, 179)
    h['min'] = [minx, miny, minz]; h['max'] = [maxx, maxy, maxz]
    if (h['versionMajor'], h['versionMinor']) >= (1, 4):
        _wf, evlr_start, n_evlr, count = struct.unpack_from('<QQIQ', raw, 227)
        h['startOfFirstEvlr'], h['numberOfEvlrs'], h['pointCount'] = evlr_start, n_evlr, count
        h['pointsByReturn'] = list(struct.unpack_from('<15Q', raw, 255))
    else:
        h['pointCount'] = h['legacyPointCount']
    if not h['compressed']:
        h['pointBytesCheck'] = h['offsetToPointData'] + h['pointCount'] * h['pointRecordLength'] <= len(full)
    return h

print(json.dumps([header(p) for p in sys.argv[1:]], indent=1))
