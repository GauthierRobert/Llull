"""Independent OpenCascade ground truth for one STEP file (quality gate reference).

Reads the file with plain OCCT readers — NOT the llull bridge's code path — and prints JSON:
  {"solids": int, "faces": int, "volume": float,
   "solidVolumes": [float], "solidBoxes": [[xmin,ymin,zmin,xmax,ymax,zmax]],
   "faceBox": [6 floats], "colors": int, "partNames": [str]}

faceBox is the optimal bounding box of every face (what a tessellation covers); it ignores free
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


def geometry(path):
    reader = STEPControl_Reader()
    if reader.ReadFile(path) != IFSelect_RetDone:
        raise ValueError("STEPControl_Reader could not read %s" % path)
    reader.TransferRoots()
    shape = reader.OneShape()
    solids = sub_shapes(shape, TopAbs_SOLID)
    faces = sub_shapes(shape, TopAbs_FACE)
    volumes = [volume(s) for s in solids]
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound

    builder = BRep_Builder()
    face_compound = TopoDS_Compound()
    builder.MakeCompound(face_compound)
    for face in faces:
        builder.Add(face_compound, face)
    return {
        "solids": len(solids),
        "faces": len(faces),
        "volume": sum(volumes),
        "solidVolumes": volumes,
        "solidBoxes": [optimal_box(s) for s in solids],
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
