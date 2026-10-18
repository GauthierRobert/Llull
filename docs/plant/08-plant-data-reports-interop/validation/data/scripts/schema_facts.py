import ifcopenshell, ifcopenshell.util.pset as up, json
s = ifcopenshell.schema_by_name('IFC4X3_ADD2') if hasattr(ifcopenshell,'schema_by_name') else ifcopenshell.ifcopenshell_wrapper.schema_by_name('IFC4X3_ADD2')
out={}
def enum_items(name):
    return list(s.declaration_by_name(name).enumeration_items())
for e in ['IfcPipeSegmentTypeEnum','IfcPipeFittingTypeEnum','IfcValveTypeEnum','IfcDistributionSystemEnum','IfcFlowDirectionEnum','IfcDistributionPortTypeEnum','IfcTankTypeEnum','IfcPumpTypeEnum','IfcHeatExchangerTypeEnum','IfcFlowInstrumentTypeEnum','IfcSensorTypeEnum','IfcCompressorTypeEnum','IfcFlowMeterTypeEnum','IfcCableCarrierSegmentTypeEnum','IfcBuildingElementProxyTypeEnum','IfcFacilityPartCommonTypeEnum','IfcInterceptorTypeEnum','IfcActuatorTypeEnum','IfcControllerTypeEnum']:
    try: out[e]=enum_items(e)
    except Exception as ex: out[e]=str(ex)
def attrs(name):
    d=s.declaration_by_name(name)
    return [(a.name(), str(a.type_of_attribute()).split('\n')[0][:60], a.optional()) for a in d.all_attributes()]
ents={}
for n in ['IfcPipeSegment','IfcPipeFitting','IfcValve','IfcDistributionPort','IfcRelConnectsPorts','IfcRelNests','IfcDistributionSystem','IfcRelAssignsToGroup','IfcRelServicesBuildings','IfcTank','IfcPump','IfcFacility','IfcFacilityPart','IfcSite','IfcRelDefinesByProperties','IfcFlowInstrument','IfcRelAssociatesClassification','IfcClassificationReference']:
    try: ents[n]={'supertype': s.declaration_by_name(n).supertype().name() if s.declaration_by_name(n).supertype() else None,'attributes':[{'name':a,'type':t,'optional':o} for a,t,o in attrs(n)]}
    except Exception as ex: ents[n]=str(ex)
out['entities']=ents
# subtypes of IfcFlowController etc in 4x3
def subs(name):
    return [x.name() for x in s.declaration_by_name(name).subtypes()]
out['subtypes']={n:subs(n) for n in ['IfcDistributionFlowElement','IfcFlowSegment','IfcFlowFitting','IfcFlowController','IfcFlowStorageDevice','IfcFlowMovingDevice','IfcEnergyConversionDevice','IfcFlowTerminal','IfcFlowTreatmentDevice','IfcDistributionControlElement','IfcPort']}
psets={}
tmpl = up.get_template('IFC4X3')
for p in ['Pset_PipeSegmentTypeCommon','Pset_PipeFittingTypeCommon','Pset_ValveTypeCommon','Pset_DistributionPortCommon','Pset_DistributionPortTypePipe','Pset_ManufacturerTypeInformation','Pset_TankTypeCommon','Pset_PumpTypeCommon','Pset_PipeConnectionFlanged','Pset_DistributionSystemCommon']:
    t=tmpl.get_by_name(p)
    if t is None: psets[p]=None; continue
    psets[p]={'applicable':t.ApplicableEntity,'properties':[{'name':pp.Name,'type':pp.PrimaryMeasureType} for pp in (t.HasPropertyTemplates or [])]}
out['psets']=psets
print(json.dumps(out,indent=1))
