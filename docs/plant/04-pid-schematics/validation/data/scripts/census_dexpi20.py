"""Census of a DEXPI 2.0 XML file (root <Model>), mapped onto the Proteus census keys."""
import sys, json, hashlib, collections, xml.etree.ElementTree as ET
data = open(sys.argv[1], 'rb').read(); root = ET.fromstring(data)
t = collections.Counter(e.get('type') for e in root.iter('Object'))
def s(*names): return sum(t[n] for n in names)
eq_classes = [k for k in t if k.startswith('Plant/ProcessEquipment.') and not k.endswith('Nozzle')]
sub = ('Plant/ProcessEquipment.Chamber', 'Plant/ProcessEquipment.Displacer', 'Plant/ProcessEquipment.Impeller', 'Plant/ProcessEquipment.TubeBundle')
valves = [k for k in t if k.startswith('Plant/Piping.') and 'Valve' in k]
pnum = []
for o in root.iter('Object'):
    if o.get('type') == 'Plant/Instrumentation.ProcessInstrumentationFunction':
        d = {x.get('property'): (x.find('String').text if x.find('String') is not None else None) for x in o.findall('Data')}
        pnum.append({k: d.get(k) for k in ('ProcessInstrumentationFunctionCategory', 'ProcessInstrumentationFunctions', 'ProcessInstrumentationFunctionNumber')})
out = {'file': sys.argv[1].split('/')[-1], 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
  'imports': [i.attrib for i in root.findall('Import')],
  'counts': {'equipmentTopLevel': sum(t[k] for k in eq_classes if k not in sub), 'equipmentAll': sum(t[k] for k in eq_classes),
   'nozzles': s('Plant/ProcessEquipment.ProcessNozzle', 'Plant/ProcessEquipment.AccessNozzle', 'Plant/ProcessEquipment.InstrumentNozzle', 'Plant/ProcessEquipment.Nozzle'),
   'pipingNetworkSystems': t['Plant/Piping.PipingNetworkSystem'], 'pipingNetworkSegments': t['Plant/Piping.PipingNetworkSegment'],
   'valves': sum(t[k] for k in valves), 'processInstrumentationFunctions': t['Plant/Instrumentation.ProcessInstrumentationFunction'],
   'instrumentationLoopFunctions': t['Plant/Instrumentation.InstrumentationLoopFunction'], 'actuatingSystems': t['Plant/Instrumentation.ActuatingSystem'],
   'processSignalGeneratingFunctions': t['Plant/Instrumentation.ProcessSignalGeneratingFunction'],
   'informationFlows': s('Plant/Instrumentation.MeasuringLineFunction', 'Plant/Instrumentation.SignalConveyingFunction', 'Plant/Instrumentation.SignalLineFunction'),
   'pipeOffPageConnectors': s('Plant/Piping.FlowInPipeOffPageConnector', 'Plant/Piping.FlowOutPipeOffPageConnector'),
   'pipeFlowArrows': t['Core/Diagram.PipeFlowArrow'], 'shapeCatalogueEntries': t['Core/Diagram.Shape']},
  'objectTypes': dict(sorted(t.items())), 'instrumentFunctions': pnum}
json.dump(out, sys.stdout, indent=1)
