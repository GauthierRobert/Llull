/** `import_piping_library` (plant 01 PSC §2): references a private (licensed) catalogue held by the host's `PipingLibraryProvider`; the document stores only { libraryId, version, sha256 }. */

import { changed, report } from '@core/commands/noop';
import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { BUNDLED_CATALOG_ID } from '../bundled';
import { refuse } from '../codes';
import { resolveLibrary } from '../libraryPort';
import { getCatalogModel, withCatalogModel } from '../store';

const LIBRARY_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * @affects plant.catalog.libraries[libraryId] (document slice: the reference only, never the values)
 * @invariant re-referencing the same file changes nothing; a different file under a known id needs replace:true; the id is also the catalogue id specs name in catalogs[]
 * @failure no provider / not on this machine / hash differs / not a valid catalogue file -> PSC_LIBRARY_UNRESOLVED; the id of the bundled or an imported catalogue -> PSC_CATALOG_CONFLICT; bad id -> PSC_CATALOG_INVALID
 */
export const importPipingLibrary = defineCommand({
  name: 'import_piping_library',
  description:
    'Reference a private piping catalogue library (a licensed llull-piping-catalog file, e.g. licence licensed-no-redistribution) that this machine holds outside the document. ' +
    'The document keeps only { libraryId, version, sha256 }; the values are read from the machine on every lookup, so a pipe spec can name the library id in its catalogs[] ' +
    'and resolve components, while a machine without the file answers PSC_LIBRARY_UNRESOLVED. sha256 (optional) pins the exact file text: a different file is refused. ' +
    'Next: create_pipe_spec / edit_pipe_spec with catalogs including the libraryId, list_piping_catalogs to see it (origin library). Export of a licensed library is refused.',
  params: z.object({
    libraryId: z
      .string()
      .describe(
        'Library id = the id inside the file (letters, digits, . _ -; max 64). Not llull-open-piping nor an imported catalogue id.',
      ),
    version: z.string().describe('Library version the host provider is asked for (the file version).'),
    sha256: z
      .string()
      .describe('Expected SHA-256 (hex) of the library file text. Default: record the hash of the file found now.')
      .optional(),
    replace: z
      .boolean()
      .describe('Re-point an already referenced libraryId to a different file (different version or hash). Default false.')
      .optional(),
  }),
  run: (doc, { libraryId, version, sha256, replace = false }): CommandResult => {
    if (!LIBRARY_ID.test(libraryId))
      return refuse(
        doc,
        'import_piping_library',
        'PSC_CATALOG_INVALID',
        `library id "${libraryId}" must match ${LIBRARY_ID.source}`,
        [libraryId],
        ['libraryId'],
      );
    const model = getCatalogModel(doc);
    if (libraryId === BUNDLED_CATALOG_ID || Object.hasOwn(model.catalogs, libraryId))
      return refuse(
        doc,
        'import_piping_library',
        'PSC_CATALOG_CONFLICT',
        `the id ${libraryId} is already a bundled or imported catalogue`,
        [libraryId],
        ['libraryId'],
      );
    const found = resolveLibrary(libraryId, version, sha256?.toLowerCase());
    if (found.status === 'unresolved')
      return refuse(doc, 'import_piping_library', 'PSC_LIBRARY_UNRESOLVED', found.reason, [libraryId], ['libraryId']);
    const reference = { libraryId, version, sha256: found.sha256 };
    const existing = model.libraries !== undefined && Object.hasOwn(model.libraries, libraryId) ? model.libraries[libraryId] : undefined;
    const rows = found.catalog.families.reduce((count, family) => count + family.sizes.length, 0);
    const data = { ...reference, licence: found.catalog.licence, families: found.catalog.families.map((family) => family.id), rows };
    if (existing?.version === version && existing.sha256 === found.sha256)
      return report(doc, `import_piping_library: ${libraryId}@${version} already referenced with the same file; nothing changed.`, {
        ...data,
        unchanged: true,
      });
    if (existing !== undefined && !replace)
      return refuse(
        doc,
        'import_piping_library',
        'PSC_CATALOG_CONFLICT',
        `library ${libraryId} is already referenced (${existing.version}, ${existing.sha256.slice(0, 12)}); pass replace: true`,
        [libraryId],
        ['libraryId'],
      );
    const next = withCatalogModel(doc, { ...model, libraries: { ...model.libraries, [libraryId]: reference } });
    return {
      ...changed(
        next,
        `Referenced piping library ${libraryId}@${version} (${found.catalog.licence}): ${found.catalog.families.length} family(ies), ${rows} row(s), sha256 ${found.sha256.slice(0, 12)}.`,
        [],
      ),
      data: { ...data, replaced: existing !== undefined },
    };
  },
});
