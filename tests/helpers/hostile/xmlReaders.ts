/** Hostile-input table: XML-family readers (core xmlRead, QIF, OpenVSP). */
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { readXml } from '@lib/xmlRead';
import { parseXml as parseVspXml } from '@aero/surfacing/vspXml';
import { parseXml as parseQifXml } from '@plm/qif/xml';
import { readQifResults } from '@plm/qif/results';
import { asText, repeated, type HostileReader } from './types';

const nestXml = (depth: number): string => '<a>'.repeat(depth) + 'x' + '</a>'.repeat(depth);
const unterminated = (open: string): string => open.repeat(100_000);

const xmlRecord = (index: number): string => `<item id="${index}" v="1.5e3">t&amp;${index}<!-- c --><![CDATA[<raw>]]></item>\n`;
const xmlBuild = (records: number): string => repeated('<?xml version="1.0"?>\n<root xmlns:p="urn:p">\n', xmlRecord, '</root>\n', records);

const QIF3 = 'http://qifstandards.org/xsd/qif3';
const qifRow = (index: number): string =>
  `<DiameterCharacteristicMeasurement id="${index + 10}"><Status><CharacteristicStatusEnum>PASS</CharacteristicStatusEnum></Status><CharacteristicItemId>${index}</CharacteristicItemId><Value>1.${index}</Value></DiameterCharacteristicMeasurement>`;
const qifBuild = (records: number): string =>
  repeated(
    `<?xml version="1.0"?><QIFDocument xmlns="${QIF3}" versionQIF="3.0.0" idMax="9"><Results><MeasurementResultsSet n="1"><MeasurementResults id="5"><MeasuredCharacteristics><CharacteristicMeasurements n="${records}">`,
    qifRow,
    '</CharacteristicMeasurements></MeasuredCharacteristics></MeasurementResults></MeasurementResultsSet></Results></QIFDocument>',
    records,
  );

const vspBuild = (records: number): string =>
  repeated(
    `<?xml version="1.0"?><Vsp_Geometry><Version>3</Version><Vehicle><Geom><ParmContainer><Name>WingGeom</Name>
<Group Name="XSec_1"><Span Value="63.63"/><Root_Chord Value="16.672"/><Tip_Chord Value="7.5024"/><Sweep Value="45"/></Group>
`,
    (index) => `<Group Name="G${index}"><P${index} Value="${index}.5"/></Group>\n`,
    `</ParmContainer><XSecSurf><XSec><XSecCurve><Type>7</Type><Camber Value="0"/><CamberLoc Value="0"/><ThickChord Value="0.12"/></XSecCurve></XSec><XSec><XSecCurve><Type>7</Type><Camber Value="0"/><CamberLoc Value="0"/><ThickChord Value="0.12"/></XSecCurve></XSec></XSecSurf></Geom></Vehicle></Vsp_Geometry>`,
    records,
  );

const xmlExtras = [
  { name: 'many unterminated comments', input: () => unterminated('<!--') },
  { name: 'many unterminated CDATA sections', input: () => unterminated('<![CDATA[') },
  { name: 'many unterminated processing instructions', input: () => unterminated('<?x ') },
  { name: 'many unterminated start tags', input: () => unterminated('<a b="') },
  { name: 'many unterminated entity references', input: () => '<a>' + '&#x'.repeat(100_000) + '</a>' },
  { name: 'many attributes on one element', input: () => '<a ' + Array.from({ length: 20_000 }, (_, k) => `k${k}="v"`).join(' ') + '/>' },
  {
    name: 'many namespace declarations',
    input: () => '<a ' + Array.from({ length: 20_000 }, (_, k) => `xmlns:p${k}="u${k}"`).join(' ') + '/>',
  },
  { name: 'wide tree of siblings', input: () => '<a>' + '<b/>'.repeat(100_000) + '</a>' },
  { name: 'many errors positions after CR-only lines', input: () => '<a>' + '\r'.repeat(300_000) + '<b></a>' },
];

export const XML_READERS: readonly HostileReader[] = [
  {
    name: 'xml: readXml (@lib/xmlRead)',
    covers: ['core/src/lib/xmlRead.ts:readXml'],
    input: 'text',
    build: xmlBuild,
    nest: nestXml,
    extra: xmlExtras,
    read: (input) => readXml(asText(input)),
    accepts: (result) => (result as { ok: boolean }).ok,
  },
  {
    name: 'xml: QIF parseXml (plm/qif/xml)',
    covers: ['plm/src/qif/xml.ts:parseXml'],
    input: 'text',
    build: xmlBuild,
    nest: nestXml,
    extra: xmlExtras,
    read: (input) => parseQifXml(asText(input)),
    accepts: (result) => (result as { ok: boolean }).ok,
  },
  {
    name: 'xml: readQifResults (plm/qif/results)',
    covers: ['plm/src/qif/results.ts:readQifResults', 'import_qif_results'],
    input: 'text',
    build: qifBuild,
    extra: xmlExtras,
    read: (input) => readQifResults(asText(input)),
    accepts: (result) => (result as { ok: boolean }).ok,
  },
  {
    name: 'xml: OpenVSP parseXml (aero/surfacing/vspXml)',
    covers: ['domain-aero/src/surfacing/vspXml.ts:parseXml'],
    input: 'text',
    build: vspBuild,
    nest: nestXml,
    extra: xmlExtras,
    read: (input) => parseVspXml(asText(input)),
    accepts: (result) => typeof result !== 'string',
  },
  {
    name: 'xml: import_openvsp_wing (execute)',
    covers: ['import_openvsp_wing'],
    costly: true,
    input: 'text',
    build: vspBuild,
    nest: nestXml,
    extra: xmlExtras,
    read: (input) => execute(createEmptyDocument(), 'import_openvsp_wing', { text: asText(input) }),
    accepts: (result) => (result as { affected: string[] }).affected.length > 0,
  },
];
