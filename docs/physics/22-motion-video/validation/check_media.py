"""PHY-22 MOV independent container check (Python 3 standard library only).

Usage: python3 -I check_media.py <file.png|file.apng|file.gif|file.mp4> [more files]
Prints one JSON object per file: the facts VC-MOV-09 / 10 / 11 assert (frame count, size, per-frame delays, loop, codec,
timescale). It shares no code with llull's encoders, so it is an independent oracle; it never decodes pixels.
Exit code 1 when a file is not a well-formed container of its kind.
"""

import json
import struct
import sys
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class MediaError(Exception):
    pass


def png_chunks(data):
    if not data.startswith(PNG_SIGNATURE):
        raise MediaError("not a PNG signature")
    pos = len(PNG_SIGNATURE)
    while pos < len(data):
        if pos + 12 > len(data):
            raise MediaError("truncated chunk header")
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        (crc,) = struct.unpack(">I", data[pos + 8 + length : pos + 12 + length])
        if zlib.crc32(kind + body) & 0xFFFFFFFF != crc:
            raise MediaError(f"bad CRC in chunk {kind!r}")
        yield kind, body
        pos += 12 + length
        if kind == b"IEND":
            return
    raise MediaError("no IEND chunk")


def check_png(data):
    width = height = None
    animation = None
    seen_idat = False
    delays = []
    sequence = []
    for kind, body in png_chunks(data):
        if kind == b"IHDR":
            width, height = struct.unpack(">II", body[:8])
        elif kind == b"IDAT":
            seen_idat = True
        elif kind == b"acTL":
            if seen_idat:
                raise MediaError("acTL after IDAT (PNG-3: acTL must precede the first IDAT)")
            frames, plays = struct.unpack(">II", body)
            animation = {"numFrames": frames, "numPlays": plays}
        elif kind == b"fcTL":
            seq, w, h, x, y, num, den = struct.unpack(">IIIIIHH", body[:24])
            sequence.append(seq)
            delays.append(num / (den or 100))
            if x + w > width or y + h > height:
                raise MediaError(f"fcTL {seq} outside the canvas")
        elif kind == b"fdAT":
            sequence.append(struct.unpack(">I", body[:4])[0])
    if animation is None:
        return {"format": "png", "width": width, "height": height, "frames": 1, "animated": False}
    if sequence != list(range(len(sequence))):
        raise MediaError("APNG sequence numbers are not 0, 1, 2, ...")
    if len(delays) != animation["numFrames"]:
        raise MediaError(f"acTL says {animation['numFrames']} frames, found {len(delays)} fcTL")
    return {"format": "apng", "width": width, "height": height, "frames": len(delays), "loop": animation["numPlays"] == 0,
            "delaysS": [round(d, 6) for d in delays]}


def skip_gif_sub_blocks(data, pos):
    while True:
        size = data[pos]
        pos += 1
        if size == 0:
            return pos
        pos += size


def check_gif(data):
    if data[:6] not in (b"GIF87a", b"GIF89a"):
        raise MediaError("not a GIF header")
    width, height, flags = struct.unpack("<HHB", data[6:11])
    pos = 13 + (3 * (2 ** ((flags & 7) + 1)) if flags & 0x80 else 0)
    frames, delays, loop = 0, [], None
    pending_delay = None
    while pos < len(data):
        marker = data[pos]
        if marker == 0x3B:
            return {"format": "gif", "width": width, "height": height, "frames": frames, "loop": loop == 0, "delaysCs": delays}
        if marker == 0x21:
            label = data[pos + 1]
            if label == 0xF9:
                pending_delay = struct.unpack("<H", data[pos + 4 : pos + 6])[0]
            elif label == 0xFF and data[pos + 3 : pos + 14] == b"NETSCAPE2.0":
                loop = struct.unpack("<H", data[pos + 16 : pos + 18])[0]
            pos = skip_gif_sub_blocks(data, pos + 2)
        elif marker == 0x2C:
            local = data[pos + 9]
            pos += 10 + (3 * (2 ** ((local & 7) + 1)) if local & 0x80 else 0)
            pos = skip_gif_sub_blocks(data, pos + 1)
            frames += 1
            delays.append(pending_delay)
            pending_delay = None
        else:
            raise MediaError(f"unexpected GIF block 0x{marker:02x} at {pos}")
    raise MediaError("no GIF trailer")


def mp4_boxes(data, start, end):
    pos = start
    while pos < end:
        size, kind = struct.unpack(">I4s", data[pos : pos + 8])
        header = 8
        if size == 1:
            (size,) = struct.unpack(">Q", data[pos + 8 : pos + 16])
            header = 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            raise MediaError(f"box {kind!r} overruns its parent")
        yield kind.decode("latin-1"), pos + header, pos + size
        pos += size


def find_box(data, start, end, path):
    for kind, body, stop in mp4_boxes(data, start, end):
        if kind == path[0]:
            return (body, stop) if len(path) == 1 else find_box(data, body, stop, path[1:])
    return None


def check_mp4(data):
    top = {kind: (body, stop) for kind, body, stop in mp4_boxes(data, 0, len(data))}
    if "ftyp" not in top or "moov" not in top or "mdat" not in top:
        raise MediaError(f"missing top-level box (have {sorted(top)})")
    major = data[top["ftyp"][0] : top["ftyp"][0] + 4].decode("latin-1")
    moov_body, moov_end = top["moov"]
    traks = [(b, s) for kind, b, s in mp4_boxes(data, moov_body, moov_end) if kind == "trak"]
    if len(traks) != 1:
        raise MediaError(f"expected one video track, found {len(traks)}")
    trak_body, trak_end = traks[0]
    mdhd = find_box(data, trak_body, trak_end, ["mdia", "mdhd"])
    stsd = find_box(data, trak_body, trak_end, ["mdia", "minf", "stbl", "stsd"])
    stsz = find_box(data, trak_body, trak_end, ["mdia", "minf", "stbl", "stsz"])
    if mdhd is None or stsd is None or stsz is None:
        raise MediaError("track lacks mdhd / stsd / stsz")
    version = data[mdhd[0]]
    if version == 1:
        timescale, duration = struct.unpack(">IQ", data[mdhd[0] + 20 : mdhd[0] + 32])
    else:
        timescale, duration = struct.unpack(">II", data[mdhd[0] + 12 : mdhd[0] + 20])
    entry = stsd[0] + 8
    codec = data[entry + 4 : entry + 8].decode("latin-1")
    width, height = struct.unpack(">HH", data[entry + 32 : entry + 36])
    config = {"av01": "av1C", "avc1": "avcC", "hvc1": "hvcC"}.get(codec)
    has_config = config is not None and find_box(data, entry + 86, stsd[1], [config]) is not None
    samples = struct.unpack(">I", data[stsz[0] + 8 : stsz[0] + 12])[0]
    return {"format": "mp4", "brand": major, "codec": codec, "codecConfig": has_config, "width": width, "height": height,
            "frames": samples, "timescale": timescale, "durationS": round(duration / timescale, 6) if timescale else None}


def check(path):
    with open(path, "rb") as handle:
        data = handle.read()
    if data.startswith(PNG_SIGNATURE):
        return check_png(data)
    if data[:3] == b"GIF":
        return check_gif(data)
    if data[4:8] == b"ftyp":
        return check_mp4(data)
    raise MediaError("unknown container")


def main(paths):
    failed = False
    for path in paths:
        try:
            print(json.dumps({"file": path, **check(path)}))
        except (MediaError, struct.error, IndexError) as error:
            failed = True
            print(json.dumps({"file": path, "error": str(error)}))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
