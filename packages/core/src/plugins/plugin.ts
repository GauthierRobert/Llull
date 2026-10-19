/**
 * Plugin contract: a domain (building, industrial, …) extends the CAD core by contributing commands, a toolset, derivation guards and
 * a deriver — without the core importing it.
 * @invariant core/** never imports a plugin; the app composition root installs plugins
 */

import type { CadDocument } from '../model/types';
import type { CommandDefinition, RetiredCommandRewrite } from '../commands/types';
import type { DerivationGuard } from '../commands/derivation';

/** A plugin's slice of the document: validation of its data and re-derivation of its geometry. */
export interface DocumentExtension {
  /** Value errors in the plugin's raw document data (persistence rejects the file when non-empty). */
  validate(raw: Record<string, unknown>): string[];
  /** Entity ids this domain regenerates from the definition. */
  derivedEntityIds(doc: CadDocument): ReadonlySet<string>;
  /**
   * Restore omitted geometry on a migrated, not-yet-validated raw document.
   * @invariant returns `raw` unchanged when the domain data is absent or invalid
   */
  restore(raw: Record<string, unknown>): Record<string, unknown>;
}

export interface CadPlugin {
  /** Unique plugin id, e.g. `building`. */
  readonly name: string;
  /** Toolset its commands belong to in CLI listings and the UI palette (see @protocol/toolsets). */
  readonly toolset: string;
  readonly commands: ReadonlyArray<CommandDefinition<unknown>>;
  readonly guards?: ReadonlyArray<DerivationGuard>;
  readonly document?: DocumentExtension;
  /** Retired command name -> rewrite onto its replacement (saved steps are migrated on load). */
  readonly retiredCommands?: Readonly<Record<string, RetiredCommandRewrite>>;
}
