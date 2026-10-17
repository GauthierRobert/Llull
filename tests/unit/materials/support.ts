import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext, MaterialLibraryProvider } from '@core/commands/types';
import { libraryHash } from '@core/commands/materials/libraryFormat';
import type { MaterialLibrary } from '@core/model/materialLibrary';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

export const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/materials' };

/** The result of a command; for a rejection the document is unchanged. */
export const call = (doc: CadDocument, name: string, params: Record<string, unknown>, ctx?: ExecutionContext): CommandResult =>
  execute(doc, name, params, ctx);

/** The document after a command that must succeed. */
export function step(doc: CadDocument, name: string, params: Record<string, unknown>, ctx?: ExecutionContext): CadDocument {
  const result = call(doc, name, params, ctx);
  if (result.rejected === true || result.document === doc) throw new Error(`${name} did not apply: ${result.summary}`);
  return result.document;
}

export const dataOf = (result: CommandResult): Record<string, unknown> => (result.data ?? {}) as Record<string, unknown>;

export const mmDocument = (): CadDocument => step(createEmptyDocument(), 'set_units', { units: 'mm' });

export const ctxWith = (libraries: MaterialLibraryProvider | null): ExecutionContext => ({ ...defaultContext(), libraries });

export const providerOf = (...libraries: MaterialLibrary[]): MaterialLibraryProvider => ({
  get: (libraryId, version) => libraries.find((library) => library.id === libraryId && library.version === version) ?? null,
});

interface ModelOptions {
  readonly id: string;
  readonly property: string;
  readonly value: number;
  readonly unit: string;
  readonly basis?: string;
  readonly direction?: string;
  readonly locator?: string;
}

const model = ({ id, property, value, unit, basis = 'B', direction, locator = 'Table 1' }: ModelOptions): Record<string, unknown> => ({
  id,
  property,
  unit,
  variables: [],
  validity: [],
  form: { kind: 'constant', value },
  basis,
  ...(direction !== undefined ? { direction } : {}),
  provenance: { citation: 'synthetic library', locator },
});

interface LibraryOptions {
  readonly id?: string;
  readonly version?: string;
  readonly storage?: 'embedded' | 'private';
  readonly licence?: string;
  readonly marking?: Record<string, unknown>;
  readonly fbru?: number;
  readonly sentinel?: number;
  readonly materialId?: string;
}

/** A small valid library file: a 7075-T6 record with density, E and a bearing allowable. */
export function libraryFile(options: LibraryOptions = {}): Record<string, unknown> {
  const {
    id = 'synthetic-lib',
    version = '1',
    storage = 'embedded',
    licence = 'company-proprietary',
    marking = { regime: 'none' },
  } = options;
  const { fbru = 156, sentinel, materialId = 'aa7075_t6' } = options;
  return {
    format: 'llull-material-library',
    schemaVersion: 1,
    id,
    version,
    title: 'Synthetic library',
    licence,
    exportMarking: marking,
    storage,
    sources: { s1: { citation: 'synthetic library' } },
    materials: [
      {
        id: materialId,
        name: materialId,
        designation: '7075',
        temper: 'T6',
        productForm: 'sheet',
        specs: [{ body: 'SAE', id: 'AMS 4045' }],
        licence,
        exportMarking: marking,
        propertyModels: [
          model({ id: 'density', property: 'density', value: 2.81, unit: 'g/cm^3', basis: 'company' }),
          model({ id: 'E', property: 'E', value: 10.3, unit: 'Msi', basis: 'company' }),
          model({ id: 'Fbru.B', property: 'Fbru', value: fbru, unit: 'ksi', basis: 'B', direction: 'L', locator: 'Table 3.7.6.0(b)' }),
          ...(sentinel !== undefined
            ? [model({ id: 'Ftu.A', property: 'Ftu', value: sentinel, unit: 'ksi', basis: 'A', direction: 'L' })]
            : []),
        ],
      },
    ],
  };
}

export const hashOf = (file: Record<string, unknown>): string => libraryHash(file as unknown as MaterialLibrary);

/** A document with `material` defined as a record with a company-basis density (2.81 g/cm^3) and a box assigned to it. */
export function boxOf(doc: CadDocument, material: string): { doc: CadDocument; id: string } {
  const added = call(doc, 'add_box', { size: [100, 50, 10] });
  const id = added.affected[0] ?? '';
  return { doc: step(added.document, 'assign_material', { materialName: material, entityIds: [id] }), id };
}
