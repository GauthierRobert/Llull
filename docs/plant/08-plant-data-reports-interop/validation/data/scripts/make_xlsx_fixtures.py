"""XLSX round-trip fixtures for VC-DAT-09 (written with openpyxl, the reference reader/writer)."""
import sys, openpyxl
from openpyxl.styles import Protection
out = sys.argv[1]
HEAD = ['ObjectId', 'Tag', 'Class', 'Description', 'Hierarchy', 'OperatingWeight (kg)', 'DesignPressure (barg)']
READ_ONLY = {'ObjectId', 'Tag', 'Class', 'Hierarchy'}
ROWS = [
    ['equipment-1', 'T-101', 'Tank', 'Feed tank', 'S1/P1/U10', 2500, 3.5],
    ['equipment-2', 'P-101', 'CentrifugalPump', 'Transfer pump', 'S1/P1/U10', 450, 16],
]
def book(rows):
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Equipment'
    ws.append(HEAD)
    for r in rows: ws.append(r)
    ws.protection.sheet = True
    for col, name in enumerate(HEAD, start=1):
        for row in range(2, len(rows) + 2):
            ws.cell(row=row, column=col).protection = Protection(locked=name in READ_ONLY)
    return wb
book(ROWS).save(f'{out}/equipment-list-sc-dat-01.xlsx')
edited = [list(r) for r in ROWS]
edited[1][5] = 480          # editable: OperatingWeight of P-101 450 -> 480
edited[0][1] = 'T-102'      # read-only: Tag of T-101 changed in the sheet -> must be refused
edited[0][6] = 'high'       # editable but not a number -> must be refused (type)
book(edited).save(f'{out}/equipment-list-sc-dat-01-edited.xlsx')
