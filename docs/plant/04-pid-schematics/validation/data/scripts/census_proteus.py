"""Independent census of a DEXPI Proteus XML file (instances only; ShapeCatalogue excluded)."""
import sys, json, hashlib, collections, xml.etree.ElementTree as ET

def attrs(el):
    ga = el.find('GenericAttributes')
    out = {}
    if ga is None: return out
    for g in el.findall('GenericAttributes'):
        for a in g.findall('GenericAttribute'):
            out[a.get('Name')] = a.get('Value')
    return out

def census(path):
    data = open(path, 'rb').read()
    root = ET.fromstring(data)
    sc = root.find('ShapeCatalogue')
    sc_ids = set(id(e) for e in sc.iter()) if sc is not None else set()
    inst = [e for e in root.iter() if id(e) not in sc_ids]
    by = collections.defaultdict(list)
    for e in inst: by[e.tag].append(e)
    pinfo = root.find('PlantInformation')
    cls = lambda tag: dict(sorted(collections.Counter(e.get('ComponentClass') for e in by[tag]).items()))
    eq_top = [e for e in root.findall('Equipment')]
    pcs = by['PipingComponent']
    valves = [e for e in pcs if 'Valve' in (e.get('ComponentClass') or '')]
    pifs = []
    for e in by['ProcessInstrumentationFunction']:
        a = attrs(e)
        pifs.append({'id': e.get('ID'), 'category': a.get('ProcessInstrumentationFunctionCategoryAssignmentClass'),
                     'functions': a.get('ProcessInstrumentationFunctionsAssignmentClass'),
                     'number': a.get('ProcessInstrumentationFunctionNumberAssignmentClass'),
                     'location': a.get('LocationSpecialization')})
    lines = []
    for e in by['PipingNetworkSystem']:
        a = attrs(e)
        lines.append({'id': e.get('ID'), 'lineNumber': a.get('LineNumberAssignmentClass'), 'fluidCode': a.get('FluidCodeAssignmentClass'),
                      'nominalDiameter': a.get('NominalDiameterRepresentationAssignmentClass'), 'pipingClass': a.get('PipingClassCodeAssignmentClass'),
                      'segments': len(e.findall('PipingNetworkSegment'))})
    eq_tags = []
    for e in eq_top:
        a = attrs(e)
        eq_tags.append({'id': e.get('ID'), 'class': e.get('ComponentClass'), 'tagName': a.get('TagNameAssignmentClass'),
                        'nozzles': len(e.findall('Nozzle')), 'subEquipment': len(e.findall('Equipment'))})
    valve_rows = []
    for e in valves:
        a = attrs(e)
        valve_rows.append({'id': e.get('ID'), 'class': e.get('ComponentClass'), 'number': a.get('PipingComponentNumberAssignmentClass')})
    conns = by['Connection']
    ids = {e.get('ID') for e in inst if e.get('ID')}
    dangling = [c.attrib for c in conns if (c.get('FromID') and c.get('FromID') not in ids) or (c.get('ToID') and c.get('ToID') not in ids)]
    return {
        'file': path.split('/')[-1], 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
        'plantInformation': {k: pinfo.get(k) for k in ['SchemaVersion', 'OriginatingSystem', 'ApplicationVersion', 'Units']} if pinfo is not None else None,
        'counts': {
            'equipmentTopLevel': len(eq_top), 'equipmentAll': len(by['Equipment']), 'nozzles': len(by['Nozzle']),
            'pipingNetworkSystems': len(by['PipingNetworkSystem']), 'pipingNetworkSegments': len(by['PipingNetworkSegment']),
            'pipingComponents': len(pcs), 'valves': len(valves),
            'processInstrumentationFunctions': len(by['ProcessInstrumentationFunction']),
            'instrumentationLoopFunctions': len(by['InstrumentationLoopFunction']),
            'actuatingSystems': len(by['ActuatingSystem']), 'processSignalGeneratingFunctions': len(by['ProcessSignalGeneratingFunction']),
            'informationFlows': len(by['InformationFlow']), 'pipeOffPageConnectors': len(by['PipeOffPageConnector']),
            'pipeFlowArrows': len(by['PipeFlowArrow']), 'connections': len(conns), 'danglingConnections': len(dangling),
            'shapeCatalogueEntries': len(list(sc)) if sc is not None else 0,
        },
        'equipmentByClass': cls('Equipment'), 'pipingComponentsByClass': cls('PipingComponent'), 'informationFlowsByClass': cls('InformationFlow'),
        'equipment': eq_tags, 'lines': lines, 'valves': valve_rows, 'instrumentFunctions': pifs,
        'loops': [attrs(e).get('InstrumentationLoopFunctionNumberAssignmentClass') for e in by['InstrumentationLoopFunction']],
    }

out = [census(p) for p in sys.argv[1:]]
json.dump(out, sys.stdout, indent=1)
