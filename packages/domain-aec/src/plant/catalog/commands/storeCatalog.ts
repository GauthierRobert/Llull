/** Stores a parsed catalogue in the document (shared by `import_piping_catalog` and `import_piping_catalog_sheet`): identical content is a no-op, a clash needs `replace`. */

import { changed, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { BUNDLED_CATALOG_ID } from '../bundled';
import { refuse } from '../codes';
import { getCatalogModel, withCatalogModel } from '../store';
import type { PipingCatalog } from '../types';

const countValues = (catalog: PipingCatalog): number =>
  catalog.families.reduce((count, family) => count + family.sizes.reduce((inner, size) => inner + Object.keys(size.dims).length, 0), 0);

export function storeCatalog(doc: CadDocument, command: string, incoming: PipingCatalog, replace: boolean): CommandResult {
  if (incoming.id === BUNDLED_CATALOG_ID)
    return refuse(
      doc,
      command,
      'PSC_CATALOG_CONFLICT',
      `the id ${BUNDLED_CATALOG_ID} is reserved for the bundled catalogue; choose another id`,
      [incoming.id],
      ['id'],
    );
  const model = getCatalogModel(doc);
  const existing = Object.hasOwn(model.catalogs, incoming.id) ? model.catalogs[incoming.id] : undefined;
  if (existing !== undefined && canonicalJson(existing) === canonicalJson(incoming))
    return report(doc, `${command}: catalogue ${incoming.id} already present with identical content; nothing changed.`, {
      catalogId: incoming.id,
      unchanged: true,
    });
  if (existing !== undefined && !replace)
    return refuse(
      doc,
      command,
      'PSC_CATALOG_CONFLICT',
      `catalogue ${incoming.id} already exists with different content`,
      [incoming.id],
      ['id'],
    );
  const next = withCatalogModel(doc, {
    ...model,
    catalogs: { ...model.catalogs, [incoming.id]: incoming },
    catalogOrder: existing === undefined ? [...model.catalogOrder, incoming.id] : model.catalogOrder,
  });
  const rows = incoming.families.reduce((count, family) => count + family.sizes.length, 0);
  const unverified = incoming.families.reduce(
    (count, family) =>
      count + family.sizes.reduce((inner, size) => inner + Object.values(size.dims).filter((dim) => !dim.verified).length, 0),
    0,
  );
  return {
    ...changed(
      next,
      `Imported piping catalogue ${incoming.id}@${incoming.version}: ${incoming.families.length} family(ies), ${rows} row(s), ${countValues(incoming)} value(s) (${unverified} unverified).`,
      [],
    ),
    data: {
      catalogId: incoming.id,
      version: incoming.version,
      families: incoming.families.map((family) => family.id),
      rows,
      unverifiedValues: unverified,
      replaced: existing !== undefined,
    },
  };
}
