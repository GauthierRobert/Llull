import sys, json, collections, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
sc = root.find('ShapeCatalogue'); scids = set(id(e) for e in sc.iter()) if sc is not None else set()
byid = {e.get('ID'): e for e in root.iter() if e.get('ID') and id(e) not in scids}
conns = [c for c in root.iter('Connection')]
ends = collections.Counter()
refs = set()
for c in conns:
    for side in ('FromID', 'ToID'):
        i = c.get(side)
        if i is None: ends[(side, 'open')] += 1; continue
        refs.add(i); ends[(side, byid[i].tag + ':' + (byid[i].get('ComponentClass') or ''))] += 1
nozzles = [e for e in byid.values() if e.tag == 'Nozzle']
unconnected = sorted(n.get('ID') for n in nozzles if n.get('ID') not in refs)
# segment item chains: count of piping components and segments with at least one item
segs = [e for e in byid.values() if e.tag == 'PipingNetworkSegment']
items = collections.Counter(ch.tag for s in segs for ch in s if ch.tag in ('PipingComponent','PipeOffPageConnector','CenterLine','PipeFlowArrow'))
print(json.dumps({'connections': len(conns), 'endpointTypes': {f'{k[0]} {k[1]}': v for k, v in sorted(ends.items())},
  'nozzlesTotal': len(nozzles), 'nozzlesReferencedByConnection': len(nozzles) - len(unconnected), 'nozzlesNotReferenced': unconnected,
  'segmentChildren': dict(items)}, indent=1))
