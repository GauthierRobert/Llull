"""Minimal independent E57 (ASTM E2807) reader: physical header + paged XML section -> per-scan recordCount, guid, bounds.
Reads files as data only. Usage: python3 -I e57_own_reader.py FILE..."""
import sys, struct, json, zlib, hashlib, re
import xml.etree.ElementTree as ET

def _table():
    t = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = (c >> 1) ^ (0x82F63B78 & -(c & 1))
        t.append(c)
    return t
_T = _table()

def crc32c(data):
    """CRC-32C (Castagnoli), as required for E57 pages (ASTM E2807 section 9)."""
    crc = 0xFFFFFFFF
    for b in data:
        crc = _T[(crc ^ b) & 0xFF] ^ (crc >> 8)
    return crc ^ 0xFFFFFFFF

def read(path):
    raw = open(path, 'rb').read()
    sig, major, minor, phys_len, xml_off, xml_len, page = struct.unpack_from('<8sIIQQQQ', raw, 0)
    assert sig == b'ASTM-E57', sig
    payload = page - 4
    # check CRC of the first page (big-endian CRC-32C stored after 1020 payload bytes)
    crc_ok = []
    for p in range(len(raw) // page):
        chunk = raw[p*page:(p+1)*page]
        stored = struct.unpack('>I', chunk[payload:])[0]
        crc_ok.append(stored == crc32c(chunk[:payload]))
    def logical(off_phys, n):
        out = bytearray(); pos = off_phys
        while len(out) < n:
            pg, inpage = divmod(pos, page)
            take = min(payload - inpage, n - len(out))
            out += raw[pos:pos+take]
            pos = (pg+1)*page
        return bytes(out)
    xml = logical(xml_off, xml_len)
    ns = {'e': 'http://www.astm.org/COMMIT/E57/2010-e57-v1.0'}
    root = ET.fromstring(xml)
    def txt(node, name):
        c = node.find('e:'+name, ns)
        return None if c is None else (c.text or '').strip()
    scans = []
    d3 = root.find('e:data3D', ns)
    for s in (list(d3) if d3 is not None else []):
        pts = s.find('e:points', ns)
        fields = [c.tag.split('}')[-1] for c in pts.find('e:prototype', ns)] if pts is not None else []
        scans.append({'guid': txt(s, 'guid'), 'recordCount': int(pts.get('recordCount')) if pts is not None else None, 'fields': fields})
    i2d = root.find('e:images2D', ns)
    return {'file': path.split('/')[-1], 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'versionMajor': major, 'versionMinor': minor,
            'filePhysicalLength': phys_len, 'pageSize': page, 'xmlLogicalLength': xml_len, 'allPageCrcOk': all(crc_ok), 'badCrcPages': crc_ok.count(False),
            'fileGuid': txt(root, 'guid'), 'formatName': txt(root, 'formatName'), 'data3DCount': len(scans), 'images2DCount': len(list(i2d)) if i2d is not None else 0, 'scans': scans}

if __name__ == '__main__':
    print(json.dumps([read(p) for p in sys.argv[1:]], indent=1))
