/** Explicit dynamics plugin (PHY-19, RS1 RS-8): its own slice of the analysis case (`AnalysisCase.explicit`), next to `cae` like `topology`. */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { explicitCommands } from './catalog';
import { explicitErrors } from './model';

/** Pure definition data: nothing is derived, nothing is restored. */
const explicitDocument: DocumentExtension = { validate: explicitErrors, derivedEntityIds: () => new Set<string>(), restore: (raw) => raw };

export const explicitPlugin: CadPlugin = { name: 'explicit', toolset: 'analysis', commands: explicitCommands, document: explicitDocument };
