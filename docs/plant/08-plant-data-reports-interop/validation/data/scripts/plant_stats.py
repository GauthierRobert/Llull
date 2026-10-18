import sys, json, collections, ifcopenshell
f = ifcopenshell.open(sys.argv[1])
types = ['IfcPipeSegment','IfcPipeFitting','IfcValve','IfcTank','IfcPump','IfcBuildingElementProxy','IfcDistributionPort','IfcRelConnectsPorts','IfcRelNests','IfcDistributionSystem','IfcRelAssignsToGroup','IfcPropertySet','IfcRelDefinesByProperties','IfcFacility','IfcFacilityPartCommon','IfcSite','IfcRelContainedInSpatialStructure','IfcRelAggregates','IfcCableCarrierSegment','IfcBuildingStorey']
counts = {t: len(f.by_type(t, include_subtypes=False)) for t in types}
ports = f.by_type('IfcDistributionPort')
connected = set()
for r in f.by_type('IfcRelConnectsPorts'):
    connected.add(r.RelatingPort.id()); connected.add(r.RelatedPort.id())
nested_ports = sum(1 for r in f.by_type('IfcRelNests') for o in r.RelatedObjects if o.is_a('IfcDistributionPort'))
pred = collections.Counter(f"{e.is_a()}.{e.PredefinedType}" for e in f.by_type('IfcDistributionFlowElement'))
tags = [e.Tag for e in f.by_type('IfcElement') if getattr(e,'Tag',None)]
dup = sorted(t for t,c in collections.Counter(tags).items() if c>1)
systems = {s.Name: len([o for r in s.IsGroupedBy for o in r.RelatedObjects]) for s in f.by_type('IfcDistributionSystem')}
print(json.dumps({'schema': f.schema_identifier if hasattr(f,'schema_identifier') else f.schema, 'counts': counts, 'ports': len(ports), 'portsNestedInElements': nested_ports,
  'connectedPorts': len(connected), 'openPorts': len(ports)-len(connected), 'predefinedTypes': dict(sorted(pred.items())), 'duplicateTags': dup, 'systemMembers': systems}, indent=1))
