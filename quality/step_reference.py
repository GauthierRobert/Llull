"""Independent OpenCascade ground truth for one STEP file (quality gate reference).

Reads the file with plain OCCT readers — NOT the llull bridge's code path — and prints JSON:
  {"solids": int, "freeShells": int, "closedShells": int, "faces": int, "area": float, "volume": float,
   "solidVolumes": [float], "solidBoxes": [[xmin,ymin,zmin,xmax,ymax,zmax]],
   "faceBox": [6 floats], "colors": int, "partNames": [str]}

Shells outside any solid count in freeShells; the CLOSED ones (no free edge) are bodies too (some
exporters write parts that way) and count in closedShells, volume, solidVolumes and solidBoxes.
area is the total area of every face (what a tessellation must cover). faceBox is the optimal bounding box of every face (what a tessellation covers); it ignores free
wires/points that a plain compound bbox would include. colors / partNames come from the XDE
(STEPCAFControl) document: the colours the file defines and its non-default product names.

Usage: python3 quality/step_reference.py <file.step>
"""

import json
import sys

from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.STEPControl import STEPControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_LabelSequence
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.XCAFDoc import XCAFDoc_DocumentTool


GENERIC_NAMES = ("SOLID", "COMPOUND", "DOCUMENT", "OPEN CASCADE STEP TRANSLATOR")


def optimal_box(shape):
    """[xmin,ymin,zmin,xmax,ymax,zmax], or None for an empty shape (void box)."""
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    return None if box.IsVoid() else list(box.Get())


def sub_shapes(shape, kind):
    found = []
    explorer = TopExp_Explorer(shape, kind)
    while explorer.More():
        found.append(explorer.Current())
        explorer.Next()
    return found


def volume(solid):
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(solid, props)
    return props.Mass()


def free_shells(shape):
    """Shells that belong to no solid (some exporters write parts this way)."""
    from OCP.TopAbs import TopAbs_SHELL
    from OCP.TopoDS import TopoDS_Iterator

    found = []

    def walk(node):
        if node.ShapeType() == TopAbs_SOLID:
            return
        if node.ShapeType() == TopAbs_SHELL:
            found.append(node)
            return
        children = TopoDS_Iterator(node)
        while children.More():
            walk(children.Value())
            children.Next()

    walk(shape)
    return found


def is_closed(shell):
    """No free boundary edge: the shell encloses a volume."""
    from OCP.ShapeAnalysis import ShapeAnalysis_FreeBounds
    from OCP.TopAbs import TopAbs_EDGE

    bounds = ShapeAnalysis_FreeBounds(shell, 1e-4, False, False)
    return not sub_shapes(bounds.GetClosedWires(), TopAbs_EDGE) and not sub_shapes(bounds.GetOpenWires(), TopAbs_EDGE)


def area(shape):
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, props)
    return props.Mass()


def geometry(path):
    reader = STEPControl_Reader()
    if reader.ReadFile(path) != IFSelect_RetDone:
        raise ValueError("STEPControl_Reader could not read %s" % path)
    reader.TransferRoots()
    shape = reader.OneShape()
    solids = sub_shapes(shape, TopAbs_SOLID)
    shells = free_shells(shape)
    closed = [shell for shell in shells if is_closed(shell)]
    faces = sub_shapes(shape, TopAbs_FACE)
    volumes = [abs(volume(s)) for s in solids + closed]
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound

    builder = BRep_Builder()
    face_compound = TopoDS_Compound()
    builder.MakeCompound(face_compound)
    for face in faces:
        builder.Add(face_compound, face)
    return {
        "solids": len(solids),
        "freeShells": len(shells),
        "closedShells": len(closed),
        "faces": len(faces),
        "area": area(face_compound),
        "volume": sum(volumes),
        "solidVolumes": volumes,
        "solidBoxes": [optimal_box(s) for s in solids + closed],
        "faceBox": optimal_box(face_compound),
    }


def metadata(path):
    document = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)
    reader.SetNameMode(True)
    if reader.ReadFile(path) != IFSelect_RetDone or not reader.Transfer(document):
        return {"colors": 0, "partNames": []}
    main = document.Main()
    colors = TDF_LabelSequence()
    XCAFDoc_DocumentTool.ColorTool_s(main).GetColors(colors)
    shapes = TDF_LabelSequence()
    XCAFDoc_DocumentTool.ShapeTool_s(main).GetShapes(shapes)
    names = set()
    for index in range(1, shapes.Length() + 1):
        attribute = TDataStd_Name()
        if shapes.Value(index).FindAttribute(TDataStd_Name.GetID_s(), attribute):
            name = attribute.Get().ToExtString().strip()
            if name and not name.startswith("=>") and name.upper() not in GENERIC_NAMES:
                names.add(name)
    return {"colors": colors.Length(), "partNames": sorted(names)}


def main():
    path = sys.argv[1]
    reference = geometry(path)
    reference.update(metadata(path))
    sys.stdout.write(json.dumps(reference))


if __name__ == "__main__":
    main()
