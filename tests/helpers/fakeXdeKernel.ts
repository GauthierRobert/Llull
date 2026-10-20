/**
 * Fake XDE kernel for the aerospace-04 command tests: the real recipe evaluator over canned natives with the exchange ports a test scripts
 * (`writeExchange`, `importExchange`, `massProperties`, `loadBlob`/`brep`), plus builders of small Part 21 / IGES texts carrying validation properties.
 * Natives: a box entity integrates in closed form; an imported solid carries its mass inside its B-rep text (JSON), so no OpenCascade is needed.
 */
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ExchangeWriteRequest, ImportExchangeOptions, ImportExchangeResult, ImportedExchange } from '@core/geometry/kernelExchange';
import type { ExactMassProperties, ImportShapesResult, ImportedSolid } from '@core/geometry/kernelPorts';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import type { Entity, MeshData, Vec3 } from '@core/model/types';
import { TETRA } from './fakeKernel';

interface FakeNative {
  readonly mesh: MeshData;
  readonly entity?: Entity;
  readonly mass?: ExactMassProperties;
}

/** Mass of a box entity (centred on `position`) or null for any other kind. */
function boxMass(entity: Entity | undefined): ExactMassProperties | null {
  if (entity?.kind !== 'box') return null;
  const [sx, sy, sz] = entity.size;
  const [px, py, pz] = entity.position;
  return {
    volume: sx * sy * sz,
    area: 2 * (sx * sy + sy * sz + sz * sx),
    centroid: [px, py, pz],
    inertiaAtCentroid: [1, 1, 1, 0, 0, 0],
    bounds: { min: [px - sx / 2, py - sy / 2, pz - sz / 2], max: [px + sx / 2, py + sy / 2, pz + sz / 2] },
  };
}

function scaledMass(mass: ExactMassProperties, factor: number): ExactMassProperties {
  const scale = (v: Vec3): Vec3 => [v[0] * factor, v[1] * factor, v[2] * factor];
  return {
    ...mass,
    volume: mass.volume * factor ** 3,
    area: mass.area * factor ** 2,
    centroid: scale(mass.centroid),
    bounds: { min: scale(mass.bounds.min), max: scale(mass.bounds.max) },
  };
}

/** B-rep text of a fake imported solid: its mass as JSON (the fake kernel reads it back as the solid's exact mass). */
export const fakeBrep = (volume: number, area: number, centroid: Vec3, half = 5): string =>
  JSON.stringify({
    volume,
    area,
    centroid,
    inertiaAtCentroid: [1, 1, 1, 0, 0, 0],
    bounds: { min: centroid.map((c) => c - half), max: centroid.map((c) => c + half) },
  });

export const importedBody = (brep: string, extra: Partial<ImportedSolid> = {}): ImportedSolid => ({
  brep,
  validAsRead: true,
  validAfterHeal: true,
  actions: [],
  maxToleranceMm: 1e-7,
  freeEdges: 0,
  faces: 6,
  faceted: false,
  ...extra,
});

export interface FakeProductSpec {
  readonly name: string;
  readonly volume: number;
  readonly area: number;
  readonly centroid: Vec3;
}

/** Part 21 text with one PRODUCT per spec carrying geometric validation properties (volume, surface area, centre point) in `unit`. */
export function fakeStepText(
  products: readonly FakeProductSpec[],
  options: { unit?: 'mm' | 'inch'; schema?: string; withProperties?: boolean } = {},
): string {
  const unit = options.unit ?? 'mm';
  const schema = options.schema ?? 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }';
  const lines: string[] = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('fake'),'2;1');",
    "FILE_NAME('fake.stp','',(''),(''),'','','');",
    `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;',
    'DATA;',
    unit === 'mm'
      ? '#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );'
      : "#1 = ( CONVERSION_BASED_UNIT('INCH',#2) LENGTH_UNIT() NAMED_UNIT(#3) );",
    '#2 = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#4);',
    '#3 = DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);',
    '#4 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
    "#5 = PRODUCT_CONTEXT('',#6,'mechanical');",
    "#6 = APPLICATION_CONTEXT('x');",
  ];
  let next = 10;
  for (const product of products) {
    const [product_, formation, definition, shape] = [next, next + 1, next + 2, next + 3];
    next += 4;
    lines.push(
      `#${product_} = PRODUCT('${product.name}','${product.name}','',(#5));`,
      `#${formation} = PRODUCT_DEFINITION_FORMATION('','',#${product_});`,
      `#${definition} = PRODUCT_DEFINITION('design','',#${formation},#6);`,
      `#${shape} = PRODUCT_DEFINITION_SHAPE('','',#${definition});`,
    );
    if (options.withProperties === false) continue;
    const rows: [string, string, string][] = [
      ['volume', 'volume measure', `VOLUME_MEASURE(${product.volume})`],
      ['surface area', 'surface area measure', `AREA_MEASURE(${product.area})`],
    ];
    for (const [description, item, measure] of rows) {
      const [property, link, representation, value] = [next, next + 1, next + 2, next + 3];
      next += 4;
      lines.push(
        `#${property} = PROPERTY_DEFINITION('geometric validation property','${description}',#${shape});`,
        `#${link} = PROPERTY_DEFINITION_REPRESENTATION(#${property},#${representation});`,
        `#${representation} = REPRESENTATION('${description}',(#${value}),#1);`,
        `#${value} = MEASURE_REPRESENTATION_ITEM('${item}',${measure},#1);`,
      );
    }
    const [property, link, representation, point] = [next, next + 1, next + 2, next + 3];
    next += 4;
    lines.push(
      `#${property} = PROPERTY_DEFINITION('geometric validation property','centroid',#${shape});`,
      `#${link} = PROPERTY_DEFINITION_REPRESENTATION(#${property},#${representation});`,
      `#${representation} = REPRESENTATION('centroid',(#${point}),#1);`,
      `#${point} = CARTESIAN_POINT('centre point',(${product.centroid.join(',')}));`,
    );
  }
  lines.push('ENDSEC;', 'END-ISO-10303-21;');
  return `${lines.join('\n')}\n`;
}

/** An 80-column IGES text: `entityTypes` become Directory Entries; the Global section carries the unit flag and resolution. */
export function fakeIgesText(entityTypes: readonly number[], options: { unitFlag?: number; resolution?: number } = {}): string {
  const pad = (body: string, section: string, line: number): string => `${body.padEnd(72)}${section}${String(line).padStart(7)}`;
  const global = `1H,,1H;,5Hfake1,8Hfake.igs,6Hllull ,7Hfake 1 ,32,38,6,308,15,5Hfake1,1.,${options.unitFlag ?? 2},2HMM,1,0.01,13H20261020.1200,${options.resolution ?? 0.0001},100.,6Hauthor,,11,0,;`;
  const lines = [pad('fake start', 'S', 1)];
  for (let at = 0; at * 72 < global.length; at++) lines.push(pad(global.slice(at * 72, at * 72 + 72), 'G', at + 1));
  let line = 1;
  for (const type of entityTypes) {
    lines.push(
      `${String(type).padStart(8)}${' '.repeat(64)}D${String(line).padStart(7)}`,
      `${String(type).padStart(8)}${' '.repeat(64)}D${String(line + 1).padStart(7)}`,
    );
    line += 2;
  }
  lines.push(
    `S      1G${String(lines.filter((l) => l[72] === 'G').length).padStart(7)}D${String(line - 1).padStart(7)}P      0`.padEnd(72) +
      `T${String(1).padStart(7)}`,
  );
  return `${lines.join('\n')}\n`;
}

export interface XdeFakeSpec {
  /** Answer of `importExchange('step', …)` (null = the kernel cannot answer). */
  readonly stepImport?: ImportExchangeResult | null;
  /** Answer of the flat `importShapes` (used with assembly: false and as the fallback). */
  readonly flatImport?: ImportShapesResult | null;
  /** Answer of `importExchange('iges', …)`. */
  readonly igesImport?: ImportExchangeResult | null;
  /** Override of the STEP writer (default: a faithful Part 21 text of the request). */
  readonly writeStep?: (request: ExchangeWriteRequest) => string | null;
  /** Override of the IGES writer (default: a minimal IGES text). */
  readonly writeIges?: (request: ExchangeWriteRequest) => string | null;
  /** Omit `massProperties` (a kernel that cannot integrate). */
  readonly noMass?: boolean;
  readonly noWriter?: boolean;
  readonly noImporter?: boolean;
}

export interface FakeXdeKernel {
  readonly kernel: GeometryKernel;
  readonly requests: ExchangeWriteRequest[];
  readonly imports: { readonly format: string; readonly text: string; readonly options: ImportExchangeOptions }[];
}

const nameOf = (request: ExchangeWriteRequest): FakeProductSpec[] =>
  request.products.flatMap((product) =>
    product.validation === undefined
      ? []
      : [{ name: product.name, volume: product.validation.volume, area: product.validation.area, centroid: product.validation.centroid }],
  );

/** A kernel with the exchange ports of an XDE-capable OCC kernel, scripted by `spec`. */
export function fakeXdeKernel(spec: XdeFakeSpec = {}): FakeXdeKernel {
  const requests: ExchangeWriteRequest[] = [];
  const imports: FakeXdeKernel['imports'] = [];
  const brep = new Map<string, string>();
  const kernel = kernelFromOps<FakeNative>({
    name: 'occt',
    info: () => ({ capabilities: ['writeExchange', 'importExchange', 'igesExchange', 'brepBlobs', 'importShapes'], occtVersion: '7.9.2' }),
    solid: (entity) => ({ mesh: TETRA, entity }),
    boolean: () => null,
    fillet: () => null,
    blend: () => null,
    chamfer: () => null,
    shell: () => null,
    place: (shape) => shape,
    scale: (shape, factor) => ({
      ...shape,
      ...(boxMass(shape.entity) === null && shape.mass === undefined
        ? {}
        : { mass: scaledMass(shape.mass ?? boxMass(shape.entity)!, factor) }),
    }),
    tessellate: (shape) => shape.mesh,
    topology: () => null,
    exportStep: () => null,
    release: () => undefined,
    ...(spec.noMass === true ? {} : { massProperties: (shape: FakeNative) => shape.mass ?? boxMass(shape.entity) }),
    brep: (sha256: string) => {
      const text = brep.get(sha256);
      if (text === undefined) return null;
      try {
        return { mesh: TETRA, mass: JSON.parse(text) as ExactMassProperties };
      } catch {
        return { mesh: TETRA };
      }
    },
    loadBlob: (sha256: string, text: string) => void brep.set(sha256, text),
    importShapes: () => spec.flatImport ?? null,
  });
  const ports: Partial<GeometryKernel> = {
    ...(spec.noWriter === true
      ? {}
      : {
          writeExchange: (request: ExchangeWriteRequest): string | null => {
            requests.push(request);
            if (request.format === 'iges')
              return spec.writeIges === undefined ? fakeIgesText([186, 514, 510, 190, 116]) : spec.writeIges(request);
            if (spec.writeStep !== undefined) return spec.writeStep(request);
            const specs = [
              ...nameOf(request),
              ...(request.rootValidation === undefined ? [] : [{ name: request.rootName ?? 'Assembly', ...request.rootValidation }]),
            ];
            return fakeStepText(specs, {
              unit: request.unit === 'in' ? 'inch' : 'mm',
              schema: request.schema === 'ap214' ? 'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }' : undefined,
            });
          },
        }),
    ...(spec.noImporter === true
      ? {}
      : {
          importExchange: (format: 'step' | 'iges', text: string, options: ImportExchangeOptions): ImportExchangeResult | null => {
            imports.push({ format, text, options });
            const answer = format === 'iges' ? spec.igesImport : spec.stepImport;
            return answer === undefined ? null : answer;
          },
        }),
  };
  return { kernel: Object.assign(kernel, ports), requests, imports };
}

/** The census every fake import reports. */
const FAKE_CENSUS = { roots: 1, solids: 1, shells: 1, openShells: 0, faces: 6 } as const;

/** A flat single-part tree (one product holding `solids`) in millimetres. */
export function singlePartTree(name: string, solids: readonly ImportedSolid[]): ImportedExchange {
  return {
    solids,
    census: { ...FAKE_CENSUS, solids: solids.length },
    skipped: [],
    products: [{ name, assembly: false, layers: [], solids: solids.map((_, index) => index) }],
    occurrences: [],
    roots: [0],
  };
}
