/** Hostile-input table: the spreadsheet / CSV / IFC / IDS readers of plant data exchange (plant 08 DAT-M4): xlsx and csv files, imports, ifc_summary, IDS. */
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { readCsv } from '@lib/csvRead';
import { deflateRaw } from '@lib/deflate';
import { readXlsx } from '@lib/xlsxRead';
import { xlsxWrite } from '@lib/xlsxWrite';
import { zipStore } from '@lib/zip';
import { parseIds } from '@aec/plant/data/ifcRead/idsParse';
import { libraryDocument } from '../../unit/plant/data/dataFixtures';
import { deflatedZip } from '../deflatedZip';
import { asBytes, asText, repeated, type HostileReader } from './types';

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const xlsxBuild = (records: number): Uint8Array =>
  xlsxWrite([
    {
      name: 'Data',
      columns: [{ header: 'Tag' }, { header: 'Description' }, { header: 'OperatingWeight (kg)' }],
      rows: Array.from({ length: records }, (_, k) => [`P-${k}`, `pump ${k}`, k]),
    },
  ]);

const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
/** A workbook whose single sheet holds `sheetXml`, optionally with a shared string table. */
const bookOf = (sheetXml: string, shared = ''): Uint8Array =>
  zipStore([
    { name: 'xl/workbook.xml', data: text(`<workbook ${MAIN}><sheets><sheet name="S" sheetId="1"/></sheets></workbook>`) },
    { name: 'xl/worksheets/sheet1.xml', data: text(sheetXml) },
    ...(shared === '' ? [] : [{ name: 'xl/sharedStrings.xml', data: text(shared) }]),
  ]);

const bomb = (entry: string): Uint8Array => {
  const zeros = new Uint8Array(60 << 20);
  return deflatedZip([{ name: entry, data: zeros, packed: deflateRaw(zeros) }]);
};

const sheetOf = (inner: string): string => `<worksheet ${MAIN}><sheetData>${inner}</sheetData></worksheet>`;

const xlsxExtras = [
  { name: 'zip bomb: 60 MB of zeros as the sheet', input: () => bomb('xl/worksheets/sheet1.xml') },
  { name: 'zip bomb: 60 MB of zeros as the shared strings', input: () => bomb('xl/sharedStrings.xml') },
  { name: 'XML nested 100000 levels deep in the sheet', input: () => bookOf(sheetOf('<a>'.repeat(100_000) + '</a>'.repeat(100_000))) },
  {
    name: 'one 5 MB shared string referenced by 100000 cells',
    input: () =>
      bookOf(
        sheetOf(`<row r="1">${Array.from({ length: 100_000 }, (_, k) => `<c r="A${k + 1}" t="s"><v>0</v></c>`).join('')}</row>`),
        `<sst ${MAIN}><si><t>${'x'.repeat(5_000_000)}</t></si></sst>`,
      ),
  },
  { name: '100000 rows of 3 cells', input: () => xlsxBuild(100_000) },
  {
    name: 'a cell at the far corner of each of 50000 rows',
    input: () =>
      bookOf(sheetOf(Array.from({ length: 50_000 }, (_, k) => `<row r="${k + 1}"><c r="XFD${k + 1}"><v>1</v></c></row>`).join(''))),
  },
  {
    name: '60000 archive entries',
    input: () => zipStore(Array.from({ length: 60_000 }, (_, k) => ({ name: `e${k}`, data: new Uint8Array(1) }))),
  },
  {
    name: 'entries named with ../ and absolute paths',
    input: () =>
      zipStore([
        { name: '../../etc/passwd', data: text('x') },
        { name: '/abs.xml', data: text('x') },
      ]),
  },
  { name: 'an entry name of 60000 characters', input: () => zipStore([{ name: 'a'.repeat(60_000), data: text('x') }]) },
  {
    name: 'a DTD with entities in the workbook',
    input: () =>
      zipStore([
        { name: 'xl/workbook.xml', data: text('<!DOCTYPE a [<!ENTITY b "bbbb"><!ENTITY c "&b;&b;&b;&b;">]><workbook>&c;</workbook>') },
      ]),
  },
];

const csvBuild = (records: number): string =>
  repeated('Tag,Description,OperatingWeight (kg)\n', (k) => `P-${k},"pump, ${k}",${k}\n`, '', records);
const csvExtras = [
  { name: 'a quote that is never closed over 5 MB', input: () => `Tag\n"${'a,b\n'.repeat(1_300_000)}` },
  { name: 'one record with 1000000 fields', input: () => 'a' + ',a'.repeat(1_000_000) },
  { name: '300000 empty lines', input: () => 'Tag\n' + '\n'.repeat(300_000) },
  { name: 'a field of 3 MB', input: () => `Tag\n${'x'.repeat(3_000_000)}\n` },
  { name: 'two million doubled quotes', input: () => `Tag\n"${'""'.repeat(2_000_000)}"\n` },
  { name: 'delimiters of all three kinds', input: () => 'a,b;c\td\n'.repeat(100_000) },
];

const emptyDoc = createEmptyDocument();
let library: ReturnType<typeof libraryDocument> | null = null;
const libraryDoc = (): ReturnType<typeof libraryDocument> => (library ??= libraryDocument());

const STEP_HEAD = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n";
const STEP_TAIL = 'ENDSEC;\nEND-ISO-10303-21;\n';
const ifcBuild = (records: number): string =>
  repeated(STEP_HEAD, (k) => `#${k + 1}=IFCPIPESEGMENT('0abc${k}',$,'P-${k}',$,$,$,$,'P-${k}',.RIGIDSEGMENT.);\n`, STEP_TAIL, records);

const IDS_HEAD =
  '<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema"><info><title>t</title></info><specifications>';
const idsSpec = (k: number): string =>
  `<specification name="s${k}" ifcVersion="IFC4X3_ADD2"><applicability minOccurs="0"><entity><name><simpleValue>IFCPIPESEGMENT</simpleValue></name></entity></applicability><requirements><attribute cardinality="required"><name><simpleValue>Tag</simpleValue></name><value><xs:restriction base="xs:string"><xs:pattern value="P-[0-9]+"/></xs:restriction></value></attribute></requirements></specification>`;
const idsBuild = (records: number): string => repeated(IDS_HEAD, idsSpec, '</specifications></ids>', records);
const idsWith = (restriction: string): string =>
  `${IDS_HEAD}<specification name="s" ifcVersion="IFC4X3_ADD2"><applicability><entity><name><simpleValue>IFCPIPESEGMENT</simpleValue></name></entity></applicability><requirements><attribute><name><simpleValue>Tag</simpleValue></name><value><xs:restriction base="xs:string">${restriction}</xs:restriction></value></attribute></requirements></specification></specifications></ids>`;
const idsExtras = [
  { name: 'a catastrophic pattern', input: () => idsWith('<xs:pattern value="(a+)+$"/>') },
  { name: 'a 2 MB pattern', input: () => idsWith(`<xs:pattern value="${'a'.repeat(2_000_000)}"/>`) },
  {
    name: '200000 enumeration values',
    input: () => idsWith(Array.from({ length: 200_000 }, (_, k) => `<xs:enumeration value="v${k}"/>`).join('')),
  },
  {
    name: 'a DTD with a billion laughs',
    input: () => `<!DOCTYPE ids [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>${idsBuild(1)}`,
  },
  { name: 'specifications nested 100000 levels', input: () => `${IDS_HEAD}${'<specification>'.repeat(100_000)}` },
  { name: '5000 specifications', input: () => idsBuild(5000) },
];

const handoverIds = idsBuild(3);

export const PLANT_DATA_READERS: readonly HostileReader[] = [
  {
    name: 'xlsx: readXlsx (@lib/xlsxRead)',
    covers: ['core/src/lib/xlsxRead.ts:readXlsx'],
    input: 'bytes',
    build: xlsxBuild,
    nest: (depth) => bookOf(sheetOf('<a>'.repeat(depth) + '</a>'.repeat(depth))),
    extra: xlsxExtras,
    read: (input) => readXlsx(asBytes(input)),
    accepts: (result) => (result as { ok: boolean }).ok,
    budgetMs: 20_000,
    maxRecords: 1 << 15,
  },
  {
    name: 'csv: readCsv (@lib/csvRead)',
    covers: ['core/src/lib/csvRead.ts:readCsv'],
    input: 'text',
    build: csvBuild,
    extra: csvExtras,
    read: (input) => readCsv(asText(input)),
    accepts: (result) => (result as { ok: boolean }).ok,
    budgetMs: 15_000,
  },
  {
    name: 'plant data: import_plant_data (execute, CSV text)',
    covers: ['import_plant_data'],
    input: 'text',
    build: csvBuild,
    extra: csvExtras,
    read: (input) => execute(emptyDoc, 'import_plant_data', { csv: asText(input) }),
    accepts: (result) => (result as { summary: string }).summary.startsWith('import_plant_data'),
    budgetMs: 20_000,
    maxRecords: 1 << 15,
  },
  {
    name: 'plant data: import_plant_data (execute, xlsx as base64)',
    covers: [],
    input: 'bytes',
    build: xlsxBuild,
    extra: xlsxExtras,
    read: (input) => execute(emptyDoc, 'import_plant_data', { fileBase64: toBase64(asBytes(input)) }),
    accepts: (result) => (result as { summary: string }).summary.startsWith('import_plant_data'),
    budgetMs: 25_000,
    maxRecords: 1 << 15,
  },
  {
    name: 'plant data: import_tag_list (execute, CSV text)',
    covers: ['import_tag_list'],
    input: 'text',
    build: csvBuild,
    extra: csvExtras,
    read: (input) => execute(libraryDoc(), 'import_tag_list', { csv: asText(input), className: 'CentrifugalPump', hierarchy: 'U10' }),
    accepts: (result) => (result as { summary: string }).summary.startsWith('import_tag_list'),
    budgetMs: 20_000,
    maxRecords: 1 << 13,
  },
  {
    name: 'plant data: ifc_summary (execute)',
    covers: ['ifc_summary'],
    input: 'text',
    build: ifcBuild,
    nest: (depth) => `${STEP_HEAD}#1=A(${'('.repeat(depth)}${')'.repeat(depth)});\n${STEP_TAIL}`,
    extra: [
      { name: 'half a million unterminated quotes', input: () => `${STEP_HEAD}#1=IFCPIPESEGMENT('${"''".repeat(500_000)}` },
      {
        name: '200000 port connections between entities that do not exist',
        input: () => repeated(STEP_HEAD, (k) => `#${k + 1}=IFCRELCONNECTSPORTS('g',$,$,$,#${k + 2},#${k + 3},$);\n`, STEP_TAIL, 200_000),
      },
    ],
    read: (input) => execute(emptyDoc, 'ifc_summary', { ifc: asText(input) }),
    accepts: (result) => (result as { summary: string }).summary.startsWith('ifc_summary:'),
    budgetMs: 15_000,
  },
  {
    name: 'plant data: parseIds (IDS 1.0 XML)',
    covers: ['domain-aec/src/plant/data/ifcRead/idsParse.ts:parseIds'],
    input: 'text',
    build: idsBuild,
    nest: (depth) => `${IDS_HEAD}<specification>${'<applicability>'.repeat(depth)}`,
    extra: idsExtras,
    read: (input) => parseIds(asText(input)),
    accepts: (result) => (result as { ok: boolean }).ok,
    budgetMs: 15_000,
    maxRecords: 1 << 13,
  },
  {
    name: 'plant data: check_ifc_requirements (execute, IFC against an IDS)',
    covers: ['check_ifc_requirements'],
    input: 'text',
    build: ifcBuild,
    extra: [
      {
        name: 'a pipe segment Tag of 3 MB against a pattern',
        input: () => ifcBuild(1).replace("'P-0',.RIGIDSEGMENT.", `'${'A'.repeat(3_000_000)}',.RIGIDSEGMENT.`),
      },
    ],
    read: (input) => execute(emptyDoc, 'check_ifc_requirements', { ids: handoverIds, ifc: asText(input) }),
    accepts: (result) => (result as { summary: string }).summary.startsWith('check_ifc_requirements:'),
    budgetMs: 15_000,
  },
];
