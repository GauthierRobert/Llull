/** Access to the plugin's document slice (`CadDocument.fasteners`). */

import type { CadDocument } from '@core/model/types';
import type { FastenerFamily, FastenerModel, FastenerSize } from '@aero/fasteners/types';

const EMPTY_MODEL: FastenerModel = { catalogs: {}, stacks: {} };

export const fastenerModel = (doc: CadDocument): FastenerModel => doc.fasteners ?? EMPTY_MODEL;

/** `doc` with `patch` merged into its fasteners slice. */
export const withFasteners = (doc: CadDocument, patch: Partial<FastenerModel>): CadDocument => ({
  ...doc,
  fasteners: { ...fastenerModel(doc), ...patch },
});

export const familyOf = (doc: CadDocument, id: string): FastenerFamily | undefined => {
  const catalogs = fastenerModel(doc).catalogs;
  return Object.hasOwn(catalogs, id) ? catalogs[id] : undefined;
};

export const sizeOf = (family: FastenerFamily, dash: string): FastenerSize | undefined => family.sizes.find((size) => size.dash === dash);
