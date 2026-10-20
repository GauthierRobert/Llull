"""Stub: regenerate oracle expected.json values with FreeCAD (run through FreeCADCmd). Not implemented; see README.md."""

import sys


def main(argv):
    try:
        import FreeCAD  # noqa: F401  (only importable inside FreeCAD's interpreter)
    except ImportError:
        sys.stderr.write("regenerate.py must run inside FreeCAD (FreeCADCmd regenerate.py -- <case dir>); FreeCAD is not installed here.\n")
        return 2
    sys.stderr.write("regenerate.py is a stub: no FreeCAD recipes are implemented, nothing written.\n")
    return 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
