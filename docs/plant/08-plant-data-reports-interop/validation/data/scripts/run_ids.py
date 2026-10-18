import sys, json, ifcopenshell, ifctester, ifctester.ids, ifctester.reporter
ids = ifctester.ids.open(sys.argv[1])
res = {}
for path in sys.argv[2:]:
    ids.validate(ifcopenshell.open(path))
    rows=[]
    for spec in ids.specifications:
        rows.append({'spec': spec.name, 'status': spec.status, 'applicable': len(spec.applicable_entities), 'failed': len(spec.failed_entities) if hasattr(spec,'failed_entities') else None})
    res[path.split('/')[-1]] = rows
print(json.dumps(res, indent=1))
