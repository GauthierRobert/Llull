"""Reference IFC4X3_ADD2 plant export for plan SC-DAT-01 (tank -> pump transfer, two lines).
Built with IfcOpenShell API (reference implementation); validated with ifcopenshell.validate."""
import sys, json, math
import ifcopenshell, ifcopenshell.api as api, ifcopenshell.guid
out = sys.argv[1]
f = api.run('project.create_file', version='IFC4X3_ADD2')
proj = api.run('root.create_entity', f, ifc_class='IfcProject', name=(sys.argv[2] if len(sys.argv) > 2 else 'sc-dat-02').upper())
api.run('unit.assign_unit', f, length={'is_metric': True, 'raw': 'MILLIMETERS'})
ctx = api.run('context.add_context', f, context_type='Model')
body = api.run('context.add_context', f, context_type='Model', context_identifier='Body', target_view='MODEL_VIEW', parent=ctx)
site = api.run('root.create_entity', f, ifc_class='IfcSite', name='S1')
plant = api.run('root.create_entity', f, ifc_class='IfcFacility', name='P1')
plant.ObjectType = 'PROCESSPLANT'
unit = api.run('root.create_entity', f, ifc_class='IfcFacilityPartCommon', name='U10', predefined_type='USERDEFINED')
unit.ObjectType = 'PROCESSUNIT'
unit.UsageType = 'NOTDEFINED'
api.run('aggregate.assign_object', f, relating_object=proj, products=[site])
api.run('aggregate.assign_object', f, relating_object=site, products=[plant])
api.run('aggregate.assign_object', f, relating_object=plant, products=[unit])

def place(el, origin=(0,0,0), z=(0,0,1), x=(1,0,0)):
    pt = f.createIfcCartesianPoint([float(v) for v in origin])
    ax = f.createIfcAxis2Placement3D(pt, f.createIfcDirection([float(v) for v in z]), f.createIfcDirection([float(v) for v in x]))
    el.ObjectPlacement = f.createIfcLocalPlacement(None, ax)

def cyl_body(el, radius, length):
    prof = f.createIfcCircleProfileDef('AREA', None, None, float(radius))
    solid = f.createIfcExtrudedAreaSolid(prof, None, f.createIfcDirection([0.,0.,1.]), float(length))
    rep = f.createIfcShapeRepresentation(body, 'Body', 'SweptSolid', [solid])
    el.Representation = f.createIfcProductDefinitionShape(None, None, [rep])

def unitv(a,b):
    d=[b[i]-a[i] for i in range(3)]; L=math.sqrt(sum(c*c for c in d)); return [c/L for c in d], L

contained=[]
def element(cls, name, tag, ptype, objtype=None):
    e = api.run('root.create_entity', f, ifc_class=cls, name=name, predefined_type=ptype)
    e.Tag = tag
    if objtype: e.ObjectType = objtype
    contained.append(e); return e

ports_all=[]
def port(el, name, direction, nd=None):
    p = api.run('system.add_port', f, element=el)
    p.Name = name; p.FlowDirection = direction; p.PredefinedType = 'PIPE'; p.SystemType = 'USERDEFINED'
    if nd is not None:
        ps = api.run('pset.add_pset', f, product=p, name='Pset_DistributionPortTypePipe')
        api.run('pset.edit_pset', f, pset=ps, properties={'NominalDiameter': float(nd), 'ConnectionType': 'FLANGED'})
    ports_all.append(p); return p

def segment(name, tag, a, b, od, nd):
    s = element('IfcPipeSegment', name, tag, 'RIGIDSEGMENT')
    d, L = unitv(a,b)
    x = [1,0,0] if abs(d[0])<0.9 else [0,1,0]
    place(s, a, d, [x[1]*d[2]-x[2]*d[1], x[2]*d[0]-x[0]*d[2], x[0]*d[1]-x[1]*d[0]])
    cyl_body(s, od/2, L)
    ps = api.run('pset.add_pset', f, product=s, name='Pset_PipeSegmentTypeCommon')
    api.run('pset.edit_pset', f, pset=ps, properties={'NominalDiameter': float(nd), 'OuterDiameter': float(od), 'Length': float(round(L,3))})
    return s, port(s, 'P1', 'SINK', nd), port(s, 'P2', 'SOURCE', nd)

def inline(cls, name, tag, ptype, at, nd, objtype=None):
    e = element(cls, name, tag, ptype, objtype)
    place(e, at)
    return e, port(e, 'P1', 'SINK', nd), port(e, 'P2', 'SOURCE', nd)

conns=[]
def connect(p1, p2):
    # One relationship per physical connection, RelatingPort = SOURCE, RelatedPort = SINK (IfcDistributionPort, Port Connectivity concept).
    assert p1.FlowDirection == 'SOURCE' and p2.FlowDirection == 'SINK'
    f.createIfcRelConnectsPorts(ifcopenshell.guid.new(), None, None, None, p1, p2, None)
    conns.append((p1,p2))

# Equipment
tank = element('IfcTank', 'Feed tank', 'T-101', 'STORAGE'); place(tank, (0,0,0)); cyl_body(tank, 1500, 4000)
tank_n1 = port(tank, 'N1', 'SOURCE', 150)
pump = element('IfcPump', 'Transfer pump', 'P-101', 'ENDSUCTION'); place(pump, (6000,0,0))
pump_s = port(pump, 'N1', 'SINK', 150); pump_d = port(pump, 'N2', 'SOURCE', 100)

od150, od100 = 168.3, 114.3
scenario = sys.argv[2] if len(sys.argv) > 2 else 'sc-dat-02'
if scenario == 'sc-dat-01':
    # MVP mapping of add_pipe_run: one IfcPipeSegment per straight, one IfcPipeFitting BEND per interior vertex (no body).
    def run(points, od, nd, line, start_port, end_port):
        members, prev = [], start_port
        for i in range(len(points) - 1):
            s, a, b = segment(f'S{i+1}', f'{line}-S{i+1}', points[i], points[i+1], od, nd)
            connect(prev, a); members.append(s); prev = b
            if i < len(points) - 2:
                e, ea, eb = inline('IfcPipeFitting', 'Bend', f'{line}-B{i+1}', 'BEND', points[i+1], nd)
                connect(prev, ea); members.append(e); prev = eb
        if end_port is not None: connect(prev, end_port)
        return members
    L1 = run([(1400,0,500),(3000,0,500),(3000,0,300),(5600,0,300)], od150, 150, '150-P-1001-A1A', tank_n1, pump_s)
    L2 = run([(6000,0,700),(6000,0,3500),(9000,0,3500)], od100, 100, '100-P-1002-A1A', pump_d, None)
    lines = [('150-P-1001-A1A', L1), ('100-P-1002-A1A', L2)]
else:
    # V1: explicit inline components from 02 RTE / 01 PSC (valves, elbow).
    s1,s1a,s1b = segment('S1','150-P-1001-A1A-S1',(1500,0,500),(2500,0,500),od150,150)
    v1,v1a,v1b = inline('IfcValve','Gate valve','XV-1001','ISOLATING',(2500,0,500),150)
    s2,s2a,s2b = segment('S2','150-P-1001-A1A-S2',(2800,0,500),(4000,0,500),od150,150)
    e1,e1a,e1b = inline('IfcPipeFitting','Elbow 90 LR','150-P-1001-A1A-E1','BEND',(4000,0,500),150)
    s3,s3a,s3b = segment('S3','150-P-1001-A1A-S3',(4000,0,500),(4000,0,200),od150,150)
    for a,b in [(tank_n1,s1a),(s1b,v1a),(v1b,s2a),(s2b,e1a),(e1b,s3a),(s3b,pump_s)]: connect(a,b)
    s4,s4a,s4b = segment('S4','100-P-1002-A1A-S4',(6000,0,800),(6000,0,2000),od100,100)
    v2,v2a,v2b = inline('IfcValve','Check valve','NRV-1002','CHECK',(6000,0,2000),100)
    s5,s5a,s5b = segment('S5','100-P-1002-A1A-S5',(6000,0,2300),(6000,0,3500),od100,100)
    for a,b in [(pump_d,s4a),(s4b,v2a),(v2b,s5a)]: connect(a,b)
    lines = [('150-P-1001-A1A', [s1,v1,s2,e1,s3]), ('100-P-1002-A1A', [s4,v2,s5])]
api.run('spatial.assign_container', f, relating_structure=unit, products=contained)

def system(name, members):
    sy = api.run('system.add_system', f, ifc_class='IfcDistributionSystem')
    sy.Name = name; sy.PredefinedType = 'USERDEFINED'; sy.ObjectType = 'PIPELINE'
    api.run('system.assign_system', f, products=members, system=sy)
    return sy
for name, members in lines: system(name, members)
f.write(out)
print(json.dumps({'ports': len(ports_all), 'connections': len(conns)}))
