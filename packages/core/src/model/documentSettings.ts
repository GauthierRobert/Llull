/** The settings slices `CadDocument` inherits: dimension styles and the site context. */

import type { DimensionStyleFields } from './dimensionStyle';
import type { SiteContextFields } from './siteContext';

export interface DocumentSettingsFields extends DimensionStyleFields, SiteContextFields {}
