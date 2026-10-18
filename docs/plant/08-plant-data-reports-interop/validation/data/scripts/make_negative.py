import sys, ifcopenshell, ifcopenshell.api as api
f = ifcopenshell.open(sys.argv[1])
# 1) self-connection: relate a port to itself (violates IfcRelConnectsPorts.NoSelfReference)
p = [x for x in f.by_type('IfcDistributionPort') if x.Name=='P2'][-1]  # S5 outlet (open end)
f.createIfcRelConnectsPorts(ifcopenshell.guid.new(), None, None, None, p, p, None)
# 2) USERDEFINED valve without ObjectType (violates IfcValve.CorrectPredefinedType)
v = [x for x in f.by_type('IfcValve') if x.Tag=='NRV-1002'][0]
v.PredefinedType='USERDEFINED'; v.ObjectType=None
# 3) duplicate tag (not a schema error: llull check must catch it)
[x for x in f.by_type('IfcValve') if x.Tag=='XV-1001'][0].Tag='NRV-1002'
f.write(sys.argv[2])
