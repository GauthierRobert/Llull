/** 05 §5.8 margin commands. */

import { commandCatalog } from '@core/commands/schema';
import { computeMargins } from './computeMargins';
import { disposeMargin } from './disposeMargin';
import { marginDispositionPayloadQuery } from './marginDispositionPayloadCommand';

export const marginCommands = commandCatalog(computeMargins, disposeMargin, marginDispositionPayloadQuery);
