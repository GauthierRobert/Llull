#!/usr/bin/env python3
"""Fetch the NIST PMI STEP files (R20) that nist_occt_reference.json was measured on, for the VC-KRN-25 native kernel suite.

Downloads the pinned zip (usnistgov/SFA commit 72375d17), checks its sha256, unzips it into a fresh directory and checks every
file against the sha256 recorded in nist_occt_reference.json. Default target: ~/.cache/llull/nist-pmi-step-files (what
server/tests/nativeKernelReferenceNist.test.ts reads; override both with LLULL_NIST_STEP_DIR). Nothing is committed: the files
are NIST's (public domain in the U.S.) and 42 MB unzipped.

Usage: python3 -I fetch_nist_step_files.py [TARGET_DIR]
"""

import hashlib
import json
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "https://raw.githubusercontent.com/usnistgov/SFA/72375d17c09cf7072c30d9393b5c08b7aa272285/Release/NIST-PMI-STEP-Files.zip"
SHA256 = "1fb91bb8ff0fe02032b948fda0775bc74591cd0bebc0988347d32574e5884f90"


def default_target():
    return os.environ.get("LLULL_NIST_STEP_DIR") or os.path.join(os.path.expanduser("~"), ".cache", "llull", "nist-pmi-step-files")


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else default_target()
    with open(os.path.join(HERE, "nist_occt_reference.json"), encoding="utf-8") as handle:
        expected = {row["file"]: row.get("sha256") for row in json.load(handle)["files"]}
    work = tempfile.mkdtemp(prefix="nist-step-")
    try:
        archive = os.path.join(work, "NIST-PMI-STEP-Files.zip")
        urllib.request.urlretrieve(URL, archive)
        if sha256_of(archive) != SHA256:
            raise SystemExit(f"sha256 mismatch for {URL}")
        unpacked = os.path.join(work, "unpacked")
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(unpacked)
        os.makedirs(target, exist_ok=True)
        found = 0
        for root, _dirs, files in os.walk(unpacked):
            for name in files:
                if name not in expected:
                    continue
                source = os.path.join(root, name)
                digest = sha256_of(source)
                if expected[name] and digest != expected[name]:
                    raise SystemExit(f"{name}: sha256 {digest} differs from nist_occt_reference.json")
                shutil.copyfile(source, os.path.join(target, name))
                found += 1
        print(f"{found} of {len(expected)} reference files in {target}")
        if found != len(expected):
            raise SystemExit("some reference files are missing from the archive")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
