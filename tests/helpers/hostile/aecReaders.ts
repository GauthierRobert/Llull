/** Hostile-input table: plant / piping readers (PCF, JSON catalogs and specs, tag formats, line-number templates, size designations). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { readStep } from '@lib/stepRead';
import { parseDn, parseNps } from '@aec/plant/catalog/nominal';
import { parseCatalogFile } from '@aec/plant/catalog/file';
import { setPipingLibraryProvider } from '@aec/plant/catalog/libraryPort';
import { parseTagFormat } from '@aec/plant/data/tagFormat';
import { readPcf } from '@aec/plant/fabrication/pcf/pcfRead';
import { readDexpi } from '@aec/plant/pid/dexpi/proteusRead';
import { parseTag } from '@aec/plant/pid/tags/parseTag';
import { parseLineNumber } from '@aec/plant/piping/lineNumber';
import { parseSpecFile } from '@aec/plant/spec/file';
import { parseCrossingName } from '@aec/industrial/framing/gridFraming';
import { parseRating } from '@aec/plant/equipment/geometry/nozzleHardware';
import { asText, orRefusal, repeated, type HostileReader } from './types';

const DATA = path.resolve(__dirname, '../../../docs/plant');
const jsonFile = (relative: string): string => readFileSync(path.join(DATA, relative), 'utf8');

/** `JSON.parse` whose syntax / depth errors are refusals (the readers under test take the parsed value). */
const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return undefined;
    throw error;
  }
};
const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const imported = (result: unknown): boolean => (result as { summary: string }).summary.startsWith('Imported');

const pcfBuild = (records: number): string =>
  repeated(
    'ISOGEN-FILES ISOGEN.FLS\nUNITS-BORE MM\nUNITS-CO-ORDS MM\nUNITS-WEIGHT KGS\nUNITS-BOLT-DIA MM\nUNITS-BOLT-LENGTH MM\nPIPELINE-REFERENCE L-101\n    PIPING-SPEC A1A\n',
    (k) =>
      `PIPE\n    COMPONENT-IDENTIFIER ${k + 1}\n    END-POINT ${k * 100}.0 0.0 3000.0 100 BW\n    END-POINT ${k * 100 + 100}.0 0.0 3000.0 100 BW\n    ITEM-CODE PIPE-100-S40\n`,
    '',
    records,
  );

const PROTEUS_HEAD = '<?xml version="1.0"?><PlantModel><PlantInformation SchemaVersion="4.1.1" Units="mm"/>';
const PROTEUS_NODES =
  '<ConnectionPoints><Node ID="d"/><Node Type="process" ID="a"><Position><Location X="1" Y="0" Z="0"/></Position></Node><Node Type="process" ID="b"><Position><Location X="2" Y="0" Z="0"/></Position></Node></ConnectionPoints>';
const proteusRecord = (k: number): string =>
  `<Equipment ID="E${k}" ComponentClass="Tank"><GenericAttributes Set="DexpiAttributes"><GenericAttribute Name="TagNameAssignmentClass" Format="string" Value="T-${k}"/></GenericAttributes><Nozzle ID="N${k}" ComponentClass="Nozzle"/></Equipment>` +
  `<PipingNetworkSystem ID="L${k}"><PipingNetworkSegment ID="S${k}"><CenterLine NumPoints="2"><Coordinate X="0" Y="0"/><Coordinate X="1" Y="0"/></CenterLine><PipingComponent ID="V${k}" ComponentClass="BallValve">${PROTEUS_NODES}</PipingComponent><Connection FromID="N${k}" FromNode="1" ToID="V${k}" ToNode="2"/></PipingNetworkSegment></PipingNetworkSystem>`;
const proteusBuild = (records: number): string => repeated(PROTEUS_HEAD, proteusRecord, '</PlantModel>', records);
const proteusNest = (depth: number): string =>
  PROTEUS_HEAD + '<Equipment ComponentClass="Chamber">'.repeat(depth) + '</Equipment>'.repeat(depth) + '</PlantModel>';
const proteusExtras = [
  {
    name: 'many components in one segment',
    input: () =>
      repeated(
        PROTEUS_HEAD + '<PipingNetworkSystem><PipingNetworkSegment>',
        (k) => `<PipingComponent ID="V${k}" ComponentClass="BallValve">${PROTEUS_NODES}</PipingComponent>`,
        '</PipingNetworkSegment></PipingNetworkSystem></PlantModel>',
        50_000,
      ),
  },
  {
    name: 'many dangling connections',
    input: () =>
      repeated(
        PROTEUS_HEAD + '<PipingNetworkSystem>',
        (k) => `<PipingNetworkSegment><Connection FromID="x${k}" ToID="y${k}"/></PipingNetworkSegment>`,
        '</PipingNetworkSystem></PlantModel>',
        50_000,
      ),
  },
  { name: 'many unknown elements', input: () => repeated(PROTEUS_HEAD, () => '<Mystery/>', '</PlantModel>', 100_000) },
  {
    name: 'many information flows without ends',
    input: () =>
      repeated(
        PROTEUS_HEAD + '<ProcessInstrumentationFunction>',
        () => '<InformationFlow/>',
        '</ProcessInstrumentationFunction></PlantModel>',
        50_000,
      ),
  },
];

const SPEC = '02-spec-driven-routing/validation/data/spec_cs150.json';
const CATALOG = '02-spec-driven-routing/validation/data/catalog_stub_cs150.json';

const LINE_NUMBER_FIELDS = { dn: 100, service: 'HC', sequence: '001', spec: 'A1A' } as const;

const STEP_HEAD = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n";
const STEP_TAIL = 'ENDSEC;\nEND-ISO-10303-21;\n';

export const AEC_READERS: readonly HostileReader[] = [
  {
    name: 'plant: readDexpi (DEXPI 1.3 Proteus and 2.0 XML)',
    covers: ['domain-aec/src/plant/pid/dexpi/proteusRead.ts:readDexpi'],
    input: 'text',
    build: proteusBuild,
    nest: proteusNest,
    extra: proteusExtras,
    read: (input) => readDexpi(asText(input), 'pid-1.1', 'auto'),
    accepts: (result) => (result as { ok: boolean }).ok,
  },
  {
    name: 'plant: parseTag (ISA 5.1 instrument tag)',
    covers: ['domain-aec/src/plant/pid/tags/parseTag.ts:parseTag'],
    input: 'text',
    build: (records) => `F${'I'.repeat(records)}-1`,
    extra: [
      { name: 'one million spaces', input: () => ` ${' '.repeat(1_000_000)}FIC-1` },
      { name: 'one million digits', input: () => `FIC-${'9'.repeat(1_000_000)}` },
      { name: 'one million plus signs', input: () => `P${'+'.repeat(1_000_000)}-1` },
      { name: 'one million superscript plus signs', input: () => `P${'⁺'.repeat(1_000_000)} 1` },
    ],
    read: (input) => parseTag(asText(input)),
    accepts: (result) => (result as { ok: boolean }).ok,
    skipLinear: 'tags over 64 characters are refused after one linear normalisation pass; the grammar itself is bounded by that limit',
  },
  {
    name: 'plant: import_dexpi (execute)',
    covers: ['import_dexpi'],
    input: 'text',
    build: proteusBuild,
    nest: proteusNest,
    budgetMs: 10_000,
    read: (input) => execute(createEmptyDocument(), 'import_dexpi', { text: asText(input) }),
    accepts: (result) => (result as { summary: string }).summary.startsWith('import_dexpi: DEXPI 1.3'),
  },
  {
    name: 'plant: readPcf',
    covers: ['domain-aec/src/plant/fabrication/pcf/pcfRead.ts:readPcf'],
    input: 'text',
    build: pcfBuild,
    extra: [
      { name: 'many END-POINT records without a component', input: () => '    END-POINT 1 2 3 100 BW\n'.repeat(100_000) },
      { name: 'one 2 MB attribute value', input: () => 'PIPE\n    ITEM-CODE ' + 'x'.repeat(2_000_000) + '\n' },
    ],
    read: (input) => readPcf(asText(input)),
    accepts: (result) => (result as { ok: boolean }).ok,
  },
  {
    name: 'plant: import_pcf (execute)',
    covers: ['import_pcf'],
    input: 'text',
    build: pcfBuild,
    read: (input) => execute(createEmptyDocument(), 'import_pcf', { text: asText(input), preview: true }),
    accepts: (result) => (result as { summary: string }).summary.includes('import_pcf'),
  },
  {
    name: 'plant: parseCatalogFile (llull-piping-catalog JSON)',
    covers: ['domain-aec/src/plant/catalog/file.ts:parseCatalogFile', 'import_piping_catalog'],
    input: 'text',
    build: () => jsonFile(CATALOG),
    skipLinear: 'a schema-validated JSON file: the sample is a fixed catalog, not a scalable record list',
    read: (input) => parseCatalogFile(parsedJson(asText(input))),
    accepts: (result) => 'catalog' in (result as object),
  },
  {
    name: 'plant: import_piping_catalog (execute)',
    covers: [],
    input: 'text',
    build: () => jsonFile(CATALOG),
    skipLinear: 'a schema-validated JSON file: the sample is a fixed catalog, not a scalable record list',
    read: (input) => execute(createEmptyDocument(), 'import_piping_catalog', { catalog: recordOf(parsedJson(asText(input))) }),
    accepts: imported,
  },
  {
    name: 'plant: import_piping_library (execute, the library file text comes from the provider)',
    covers: ['import_piping_library'],
    input: 'text',
    build: () => JSON.stringify({ ...(JSON.parse(jsonFile(CATALOG)) as object), id: 'hostile-library' }),
    skipLinear: 'a schema-validated JSON file: the sample is a fixed catalog, not a scalable record list',
    read: (input) => {
      const text = asText(input);
      setPipingLibraryProvider({ get: () => text });
      try {
        return execute(createEmptyDocument(), 'import_piping_library', { libraryId: 'hostile-library', version: '1' });
      } finally {
        setPipingLibraryProvider(null);
      }
    },
    accepts: (result) => (result as { summary: string }).summary.startsWith('Referenced'),
  },
  {
    name: 'plant: parseSpecFile (llull-pipe-spec JSON)',
    covers: ['domain-aec/src/plant/spec/file.ts:parseSpecFile'],
    input: 'text',
    build: () => jsonFile(SPEC),
    skipLinear: 'a schema-validated JSON file: the sample is a fixed spec, not a scalable record list',
    read: (input) => parseSpecFile(parsedJson(asText(input))),
    accepts: (result) => 'spec' in (result as object),
  },
  {
    name: 'plant: import_pipe_spec (execute)',
    covers: ['import_pipe_spec'],
    input: 'text',
    build: () => jsonFile(SPEC),
    skipLinear: 'a schema-validated JSON file: the sample is a fixed spec, not a scalable record list',
    read: (input) => execute(createEmptyDocument(), 'import_pipe_spec', { spec: recordOf(parsedJson(asText(input))) }),
    accepts: imported,
  },
  {
    name: 'plant: readSheet (piping CSV sheets) + import_piping_catalog_sheet (execute)',
    covers: ['domain-aec/src/plant/catalog/sheetRead.ts:readSheet', 'import_piping_catalog_sheet'],
    input: 'text',
    build: (records) =>
      repeated('family,type,standard,size,outsideDiameter\n', (k) => `f${k % 7},pipe,ASME B36.10M,NPS ${(k % 20) + 1},60.3\n`, '', records),
    skipLinear: 'refuses sheets over 20 000 rows up front',
    extra: [
      { name: 'a quote opened and never closed', input: () => 'family,type\n"' + 'x,'.repeat(100_000) },
      { name: 'ten thousand columns', input: () => `${Array.from({ length: 10_000 }, (_, k) => `c${k}`).join(',')}\n1` },
      { name: 'hostile header names', input: () => 'family,type,standard,size,__proto__,constructor\nf,pipe,s,NPS 2,1,2\n' },
      {
        name: 'formula cells everywhere',
        input: () => repeated('family,type,standard,size,outsideDiameter\n', () => '=1+1,=2,@3,-4,+5\n', '', 1000),
      },
    ],
    read: (input) =>
      execute(createEmptyDocument(), 'import_piping_catalog_sheet', {
        sheet: asText(input),
        catalogId: 'h',
        licence: 'open-data',
        provenance: { citation: 'h' },
      }),
    accepts: imported,
  },
  {
    name: 'plant: import_pipe_spec_sheet (execute, llull and Plant 3D sheets)',
    covers: ['import_pipe_spec_sheet'],
    input: 'text',
    build: (records) =>
      repeated('component,type,from,to,catalogRef,schedule\n', (k) => `C${k},pipe,NPS 2,NPS 2,asme-b36.10m,40\n`, '', records),
    skipLinear: 'refuses sheets over 20 000 rows up front',
    extra: [
      {
        name: 'extra JSON nested 50000 levels',
        input: () => `component,type,from,to,catalogRef,extra\nC,pipe,NPS 2,NPS 2,x,"${'{""a"":'.repeat(50_000)}"\n`,
      },
      {
        name: 'extra with a prototype key',
        input: () => 'component,type,from,to,catalogRef,extra\nC,pipe,NPS 2,NPS 2,x,"{""__proto__"":1}"\n',
      },
    ],
    read: (input) => {
      const sheet = asText(input);
      const spec = {
        id: 'H',
        dimensionalStandard: 'ASME',
        rating: { system: 'ASME B16.5', class: 150 },
        corrosionAllowance: { value: 1, unit: 'mm' },
        sizeRange: { fromNps: 1, toNps: 24 },
        catalogs: ['llull-open-piping'],
      };
      return [
        execute(createEmptyDocument(), 'import_pipe_spec_sheet', { sheet, spec }),
        execute(createEmptyDocument(), 'import_pipe_spec_sheet', { sheet, spec, format: 'plant3d', catalogRef: 'x' }),
      ];
    },
    accepts: (result) => (result as Array<{ summary: string }>)[0]?.summary.startsWith('Imported') === true,
  },
  {
    name: 'plant: parseRatingFile + import_rating_table (execute)',
    covers: ['domain-aec/src/plant/catalog/ratingFile.ts:parseRatingFile', 'import_rating_table'],
    input: 'text',
    build: (records) =>
      JSON.stringify({
        format: 'llull-rating-table',
        schemaVersion: 1,
        id: 'h',
        standard: 'company',
        materialGroup: 'h',
        licence: 'open-data',
        pressureUnit: 'bar',
        temperatureUnit: 'C',
        minTemperature: -50,
        provenance: { citation: 'h' },
        rows: Array.from({ length: Math.min(records, 5000) }, (_, k) => ({ class: 150, temperature: k, pressure: 10 })),
      }),
    skipLinear: 'a schema-validated JSON file capped at 5000 rows',
    read: (input) => execute(createEmptyDocument(), 'import_rating_table', { table: recordOf(parsedJson(asText(input))) }),
    accepts: imported,
  },
  {
    name: 'plant: parseTagFormat (tag format string)',
    covers: ['domain-aec/src/plant/data/tagFormat.ts:parseTagFormat'],
    input: 'text',
    build: (records) => '{classCode}-{seq:4}' + '-{area}'.repeat(Math.min(records, 20)),
    skipLinear: 'refuses formats over 200 characters up front',
    extra: [{ name: 'many braces', input: () => '{{{'.repeat(200_000) }],
    read: (input) => parseTagFormat(asText(input)),
    accepts: (result) => (result as { ok: boolean }).ok,
  },
  {
    name: 'plant: parseLineNumber (template to regex)',
    covers: ['domain-aec/src/plant/piping/lineNumber.ts:parseLineNumber'],
    input: 'text',
    build: (records) => `100-HC-${'0'.repeat(records)}-A1A`,
    extra: [
      { name: 'a long number that cannot match', input: () => '-'.repeat(30_000) },
      { name: 'a long number with many separators', input: () => '1-'.repeat(30_000) + 'X' },
    ],
    read: (input) =>
      parseLineNumber('{dn}-{service}-{sequence}-{spec}[-{insulationCode}{insulationThickness}]', asText(input), LINE_NUMBER_FIELDS),
    accepts: (result) => (result as { matched: boolean }).matched,
    maxRecords: 1 << 14,
  },
  {
    name: 'plant: parseLineNumber (hostile template)',
    covers: [],
    input: 'text',
    build: (records) => `${'[a]'.repeat(Math.min(records, 10))}{sequence}`,
    extra: [
      {
        name: 'optional groups followed by the same literals (exponential backtracking)',
        input: () => `${'[a]'.repeat(26)}${'a'.repeat(26)}{sequence}!`,
      },
      { name: 'duplicate placeholders', input: () => '{dn}{dn}{sequence}' },
      { name: 'unbalanced brackets', input: () => '[[[{sequence}' },
      { name: 'nested groups with fields', input: () => '[{dn}[{service}]]{sequence}' },
    ],
    skipLinear: 'the template is at most 120 characters (templateProblem): not scalable',
    read: (input) => orRefusal(() => parseLineNumber(asText(input), 'a'.repeat(26), LINE_NUMBER_FIELDS)),
    accepts: () => true,
  },
  {
    name: 'plant: parseNps / parseDn / parseRating (size designations)',
    covers: [
      'domain-aec/src/plant/catalog/nominal.ts:parseNps',
      'domain-aec/src/plant/catalog/nominal.ts:parseDn',
      'domain-aec/src/plant/equipment/geometry/nozzleHardware.ts:parseRating',
      'domain-aec/src/industrial/framing/gridFraming.ts:parseCrossingName',
    ],
    input: 'text',
    build: (records) => `${'1'.repeat(records)}-1/2`,
    read: (input) => {
      const text = asText(input);
      return [parseNps(text), parseDn(text), parseRating(text), parseCrossingName(text)];
    },
    accepts: () => true,
  },
  {
    name: 'plant: readStep (ISO 10303-21 / IFC physical file)',
    covers: ['core/src/lib/stepRead.ts:readStep'],
    input: 'text',
    build: (records) =>
      repeated(STEP_HEAD, (k) => `#${k + 1}=IFCPUMP('0abc',$,'P-${k}',$,$,$,$,'P-${k}',.ENDSUCTION.);\n`, STEP_TAIL, records),
    nest: (depth) => `${STEP_HEAD}#1=A(${'('.repeat(depth)}${')'.repeat(depth)});\n${STEP_TAIL}`,
    extra: [
      {
        name: 'many references to missing entities (the error list is capped)',
        input: () => repeated(STEP_HEAD, (k) => `#${k + 1}=IFCRELNESTS(#${k + 1_000_000},#${k + 2_000_000});\n`, STEP_TAIL, 100_000),
      },
      { name: 'half a million unterminated quotes', input: () => `${STEP_HEAD}#1=A('${"''".repeat(500_000)}` },
      { name: 'one million open parentheses', input: () => `${STEP_HEAD}#1=A(${'('.repeat(1_000_000)}` },
      { name: 'many records without a body', input: () => repeated(STEP_HEAD, (k) => `#${k}=\n`, STEP_TAIL, 100_000) },
    ],
    read: (input) => readStep(asText(input)),
    accepts: (result) => (result as ReturnType<typeof readStep>).entities.size === 3,
    budgetMs: 10_000,
  },
  {
    name: 'plant stress: import_pipe_material_data (material table rows as JSON)',
    covers: ['import_pipe_material_data'],
    input: 'text',
    build: (records) =>
      JSON.stringify(
        Array.from({ length: Math.min(records, 200) }, (_, k) => ({ tempC: k * 10, ShMPa: 100, EGPa: 200, meanCtePerK: 1e-5 })),
      ),
    read: (input) => {
      const rows = parsedJson(asText(input));
      return execute(createEmptyDocument(), 'import_pipe_material_data', {
        materialId: 'M',
        designation: 'hostile',
        rows,
        referenceTempC: 20,
        source: { citation: 'hostile table' },
        licence: 'test',
      });
    },
    accepts: (result) => (result as { rejected?: boolean }).rejected !== true,
    skipLinear: 'more than 200 rows are refused up front by design (PST_TABLE_INVALID)',
  },
];
