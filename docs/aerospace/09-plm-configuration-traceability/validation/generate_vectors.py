#!/usr/bin/env python3
"""
Generate PLM / configuration-management validation vectors for gap 09 (PLM).

Run:  python3 -I generate_vectors.py            (from this directory, or pass --out <dir>)
Needs: Python >= 3.9 and the `cryptography` package (Ed25519). Tested with cryptography 50.0.1, Python 3.13.

Outputs (all deterministic, re-running yields byte-identical files):
  vectors/hash_vectors.json           SHA-256 of canonical (RFC 8785-style) JSON, incl. release-scope hash of sample_document.json
  vectors/ed25519_vectors.json        RFC 8032 section 7.1 TEST 1-3 (re-verified here) + manifest signature + negative cases
  vectors/revision_sequence.json      revision-letter sequences for the default 'asme-alpha' scheme and the numeric scheme
  vectors/effectivity_resolution.json which revision applies to a unit (serial / MSN / date) after ECO-0002
  release_package_manifest.sample.json  sample immutable release package manifest, signed with the RFC 8032 TEST 1 key

The RFC 8032 TEST 1 key is a PUBLIC test key. It must never be accepted by a production trust store.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

HERE = os.path.dirname(os.path.abspath(__file__))

# --------------------------------------------------------------------------------------------------------------------
# Canonical JSON (RFC 8785 JCS subset): keys sorted by UTF-16 code units, no insignificant whitespace, UTF-8 output.
# Restriction (asserted): numbers must be integers or floats whose repr equals the ECMAScript Number.toString form;
# the inputs used here satisfy that, so Python and JavaScript (JSON.stringify on key-sorted objects) agree byte for byte.
# --------------------------------------------------------------------------------------------------------------------


def _utf16_key(s: str) -> list[int]:
    return list(s.encode("utf-16-be"))


def _check_number(x: Any) -> None:
    if isinstance(x, bool) or x is None:
        return
    if isinstance(x, float):
        if x != x or x in (float("inf"), float("-inf")):
            raise ValueError("NaN/Infinity are not I-JSON")
        if x.is_integer():
            raise ValueError(f"float {x!r} would serialize differently in Python ('{x!r}') and JS; use an int")


def canonical(value: Any) -> str:
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: _utf16_key(kv[0]))
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical(v) for k, v in items) + "}"
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    _check_number(value)
    return json.dumps(value, ensure_ascii=False)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# Fields excluded from the release content hash: view/session state, and the PLM record itself (it holds the hash).
RELEASE_SCOPE_EXCLUDED = ("selection", "camera", "plm")


def release_scope(envelope: dict) -> dict:
    doc = {k: v for k, v in envelope["document"].items() if k not in RELEASE_SCOPE_EXCLUDED}
    return {"format": envelope["format"], "version": envelope["version"], "document": doc}


# --------------------------------------------------------------------------------------------------------------------
# Revision schemes
# --------------------------------------------------------------------------------------------------------------------

ASME_EXCLUDED = set("IOQSXZ")  # per secondary sources quoting ASME Y14.35M-1997 (see sources.md R26); configurable
ASME_LETTERS = [c for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if c not in ASME_EXCLUDED]


def asme_alpha(n: int) -> str:
    """n-th revision (1-based) in the 'asme-alpha' scheme: A..Y (20 letters), then AA..AY, BA..; max two characters."""
    k = len(ASME_LETTERS)
    if n < 1 or n > k + k * k:
        raise ValueError("out of range for a two-character scheme")
    if n <= k:
        return ASME_LETTERS[n - 1]
    m = n - k - 1
    return ASME_LETTERS[m // k] + ASME_LETTERS[m % k]


def numeric(n: int) -> str:
    return f"{n:02d}"


# --------------------------------------------------------------------------------------------------------------------
# Effectivity
# --------------------------------------------------------------------------------------------------------------------

# Item P/N LL-1001: rev A released under ECO-0001, effective serial 1..open; ECO-0002 introduces rev B effective serial
# >= 5, closing rev A at serial 4 (serial effectivity), and for the MSN view the same change is cut in at MSN 0012.
EFFECTIVITY = {
    "serial": [
        {"revision": "A", "from": 1, "to": 4},
        {"revision": "B", "from": 5, "to": None},
    ],
    "msn": [
        {"revision": "A", "from": 1, "to": 11},
        {"revision": "B", "from": 12, "to": None},
    ],
    "date": [
        {"revision": "A", "from": "2026-11-02", "to": "2027-02-28"},
        {"revision": "B", "from": "2027-03-01", "to": None},
    ],
}


def resolve(kind: str, unit: Any) -> str | None:
    for r in EFFECTIVITY[kind]:
        lo, hi = r["from"], r["to"]
        if unit >= lo and (hi is None or unit <= hi):
            return r["revision"]
    return None


# --------------------------------------------------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=HERE)
    out = ap.parse_args().out
    os.makedirs(os.path.join(out, "vectors"), exist_ok=True)

    def write(rel: str, obj: Any) -> None:
        with open(os.path.join(out, rel), "w", encoding="utf-8", newline="\n") as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)
            f.write("\n")

    # ---------------- hash vectors ----------------
    with open(os.path.join(HERE, "sample_document.json"), encoding="utf-8") as f:
        envelope = json.load(f)
    full_canon = canonical(envelope)
    scope_canon = canonical(release_scope(envelope))
    # Moving the camera / selection must NOT change the release hash; editing a parameter MUST.
    moved = json.loads(json.dumps(envelope))
    moved["document"]["camera"]["position"] = [1, 2, 3]
    moved["document"]["selection"] = []
    edited = json.loads(json.dumps(envelope))
    edited["document"]["parameters"]["t"] = {"name": "t", "expression": "5", "value": 5}
    reordered = json.loads(json.dumps(envelope), object_pairs_hook=lambda p: dict(reversed(p)))

    hash_vectors = {
        "algorithm": "SHA-256 (FIPS 180-4) over UTF-8 bytes of canonical JSON (RFC 8785 JCS; numbers restricted, see generator)",
        "fips_known_answer": [
            {"input_utf8": "abc", "sha256": sha256_hex(b"abc"), "source": "NIST example for FIPS 180-x SHA-256 ('abc')"},
            {"input_utf8": "", "sha256": sha256_hex(b""), "source": "SHA-256 of the empty string (derived; widely published)"},
        ],
        "canonicalization_cases": [
            {"name": "key order", "input": {"b": 1, "a": [2, {"d": True, "c": None}]}, "canonical": canonical({"b": 1, "a": [2, {"d": True, "c": None}]})},
            {"name": "unicode passthrough", "input": {"title": "Ferrure éclisse", "é": 1, "z": 2}, "canonical": canonical({"title": "Ferrure éclisse", "é": 1, "z": 2})},
            {"name": "decimal", "input": {"density": 0.00278, "r": 3.3}, "canonical": canonical({"density": 0.00278, "r": 3.3})},
        ],
        "sample_document": {
            "file": "sample_document.json",
            "full_canonical_sha256": sha256_hex(full_canon.encode()),
            "full_canonical_length_bytes": len(full_canon.encode()),
            "release_scope_excluded_fields": list(RELEASE_SCOPE_EXCLUDED),
            "release_scope_canonical_sha256": sha256_hex(scope_canon.encode()),
            "release_scope_canonical_length_bytes": len(scope_canon.encode()),
            "release_scope_after_camera_and_selection_change_sha256": sha256_hex(canonical(release_scope(moved)).encode()),
            "release_scope_after_key_reordering_sha256": sha256_hex(canonical(release_scope(reordered)).encode()),
            "release_scope_after_parameter_t_edit_sha256": sha256_hex(canonical(release_scope(edited)).encode()),
            "expect": {
                "camera_selection_change_keeps_hash": True,
                "key_reordering_keeps_hash": True,
                "parameter_edit_changes_hash": True,
            },
        },
    }
    sd = hash_vectors["sample_document"]
    assert sd["release_scope_after_camera_and_selection_change_sha256"] == sd["release_scope_canonical_sha256"]
    assert sd["release_scope_after_key_reordering_sha256"] == sd["release_scope_canonical_sha256"]
    assert sd["release_scope_after_parameter_t_edit_sha256"] != sd["release_scope_canonical_sha256"]
    assert hash_vectors["fips_known_answer"][0]["sha256"] == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    write("vectors/hash_vectors.json", hash_vectors)

    # ---------------- Ed25519 vectors ----------------
    # RFC 8032 section 7.1 TEST 1..3, transcribed from the djb/SUPERCOP 'sign.input' file shipped in the PyPI package
    # cryptography_vectors 44.0.0 (asymmetric/Ed25519/sign.input lines 1-3, identical to RFC 8032 TEST 1-3).
    rfc = [
        ("TEST 1", "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
         "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
         "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
        ("TEST 2", "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
         "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
         "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
        ("TEST 3", "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
         "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
         "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"),
    ]
    ed_vectors: dict[str, Any] = {"algorithm": "Ed25519 (RFC 8032 PureEdDSA; FIPS 186-5 EdDSA)", "rfc8032": [], "derived": [], "negative": []}
    for name, sk, pk, msg, sig in rfc:
        key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(sk))
        derived_pk = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
        derived_sig = key.sign(bytes.fromhex(msg)).hex()
        assert derived_pk == pk, name
        assert derived_sig == sig, name
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(pk)).verify(bytes.fromhex(sig), bytes.fromhex(msg))
        ed_vectors["rfc8032"].append({"name": name, "secretKey": sk, "publicKey": pk, "messageHex": msg, "signature": sig, "verified": True})

    # ---------------- release package manifest ----------------
    sheet_svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 420 297">'
        '<text x="300" y="285">LL-1001 REV A</text></svg>\n'
    )
    members = [
        {"path": "model/LL-1001_A.llull.json", "role": "native-definition", "mediaType": "application/json",
         "canonical": True, "sha256": sd["release_scope_canonical_sha256"], "bytes": sd["release_scope_canonical_length_bytes"]},
        {"path": "drawings/LL-1001_A_sheet1.svg", "role": "drawing", "mediaType": "image/svg+xml", "canonical": False,
         "sha256": sha256_hex(sheet_svg.encode()), "bytes": len(sheet_svg.encode())},
    ]
    manifest_body = {
        "schema": "llull-release-manifest/0.1",
        "item": {"partNumber": "LL-1001", "name": "Bracket, hinge fitting", "revision": "A", "iteration": 2},
        "lifecycleState": "released",
        "change": {"eco": "ECO-0001", "classification": "initial-release"},
        "effectivity": [{"kind": "serial", "from": 1, "to": None}],
        "baseline": {"id": "BL-PBL-0001", "kind": "product"},
        "marking": {"exportControl": "NLR-EXAMPLE", "notice": "Example marking only; classification is a user/legal decision"},
        "releasedAt": "2026-11-02T09:30:00Z",
        "releasedBy": {"userId": "u-0007", "name": "J. Example", "role": "design-authority"},
        "members": members,
        "documentContentHash": sd["release_scope_canonical_sha256"],
        "tool": {"name": "llull", "version": "TBD", "kernel": "occt", "schemaVersion": 2},
    }
    body_canon = canonical(manifest_body)
    manifest_hash = sha256_hex(body_canon.encode())
    test1_key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(rfc[0][1]))
    signed_bytes = body_canon.encode()
    manifest_sig = test1_key.sign(signed_bytes).hex()
    manifest = {
        **manifest_body,
        "manifestSha256": manifest_hash,
        "signatures": [
            {"alg": "Ed25519", "keyId": "rfc8032-test-1", "publicKey": rfc[0][2], "meaning": "approval",
             "signedAt": "2026-11-02T09:30:00Z", "signer": {"userId": "u-0007", "name": "J. Example"},
             "signedContent": "UTF-8 canonical JSON of the manifest without manifestSha256 and signatures",
             "signature": manifest_sig, "WARNING": "RFC 8032 public TEST 1 key - test only, never trust in production"}
        ],
    }
    write("release_package_manifest.sample.json", manifest)

    Ed25519PublicKey.from_public_bytes(bytes.fromhex(rfc[0][2])).verify(bytes.fromhex(manifest_sig), signed_bytes)
    ed_vectors["derived"].append({
        "name": "release manifest signed with RFC 8032 TEST 1 key",
        "publicKey": rfc[0][2], "messageSha256": manifest_hash, "messageLengthBytes": len(signed_bytes),
        "messageFile": "release_package_manifest.sample.json (canonical form of body)", "signature": manifest_sig, "verified": True,
    })

    def verifies(pk_hex: str, sig_hex: str, msg: bytes) -> bool:
        try:
            Ed25519PublicKey.from_public_bytes(bytes.fromhex(pk_hex)).verify(bytes.fromhex(sig_hex), msg)
            return True
        except InvalidSignature:
            return False

    tampered_body = dict(manifest_body, item=dict(manifest_body["item"], revision="B"))
    flipped = bytearray(bytes.fromhex(manifest_sig))
    flipped[0] ^= 0x01
    neg = [
        ("tampered manifest (revision A->B)", rfc[0][2], manifest_sig, canonical(tampered_body).encode()),
        ("signature bit flip", rfc[0][2], flipped.hex(), signed_bytes),
        ("wrong public key (RFC TEST 2 key)", rfc[1][2], manifest_sig, signed_bytes),
        ("RFC TEST 2 signature over TEST 3 message", rfc[1][2], rfc[1][4], bytes.fromhex(rfc[2][3])),
    ]
    for name, pk, sig, msg in neg:
        ok = verifies(pk, sig, msg)
        assert ok is False, name
        ed_vectors["negative"].append({"name": name, "publicKey": pk, "signature": sig, "messageSha256": sha256_hex(msg), "expectVerified": False})
    write("vectors/ed25519_vectors.json", ed_vectors)

    # ---------------- revision sequences ----------------
    seq = {
        "schemes": {
            "asme-alpha": {
                "excludedLetters": sorted(ASME_EXCLUDED),
                "rule": "single letters A..Y without I,O,Q,S,X,Z (20), then two letters AA..YY with the same alphabet, max 2 chars",
                "source": "secondary sources quoting ASME Y14.35M-1997; verify against the purchased ASME Y14.35 edition",
                "first25": [asme_alpha(i) for i in range(1, 26)],
                "checkpoints": {str(i): asme_alpha(i) for i in (1, 8, 9, 14, 15, 16, 20, 21, 40, 41, 420)},
                "capacity": len(ASME_LETTERS) + len(ASME_LETTERS) ** 2,
            },
            "numeric-2": {"rule": "zero-padded integer", "checkpoints": {str(i): numeric(i) for i in (1, 9, 10, 99)}},
            "iteration": {"rule": "<revision>.<iteration>, iteration restarts at 1 on each new revision (Windchill-style)",
                          "examples": ["A.1", "A.2", "A.3", "B.1"]},
        }
    }
    assert asme_alpha(20) == "Y" and asme_alpha(21) == "AA" and asme_alpha(420) == "YY"
    write("vectors/revision_sequence.json", seq)

    # ---------------- effectivity resolution ----------------
    cases = []
    for kind, units in (("serial", [1, 4, 5, 37]), ("msn", [1, 11, 12, 250]), ("date", ["2026-11-01", "2026-11-02", "2027-02-28", "2027-03-01"])):
        for u in units:
            cases.append({"kind": kind, "unit": u, "expectRevision": resolve(kind, u)})
    write("vectors/effectivity_resolution.json", {"item": "LL-1001", "ranges": EFFECTIVITY, "cases": cases,
                                                  "note": "null = no released revision effective (e.g. date before first release)"})
    print("ok:", manifest_hash)
    return 0


if __name__ == "__main__":
    sys.exit(main())
