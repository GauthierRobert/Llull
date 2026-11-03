// The scan slice of the document as the viewport reads it (the types live in the scan plugin and are not exported from `@aec/index`).

import type { CadDocument } from '@core/model/types';

type ScanSlice = NonNullable<CadDocument['scan']>;

export type CloudReference = ScanSlice['clouds'][string];
export type CropBox = ScanSlice['crops'][string];
