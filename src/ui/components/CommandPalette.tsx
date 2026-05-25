/**
 * @layer ui/components
 *
 * CommandPalette — a Spotlight-style command launcher (Ctrl/Cmd-K).
 *
 * - Fuzzy substring search over command name + description.
 * - Keyboard navigable: ↑/↓ move the highlight, Enter selects, Esc closes.
 * - Commands with no required params dispatch immediately on selection.
 * - Commands with required params show ParamForm inline.
 * - Accessible: role="dialog", aria-modal, focus trap + restore, aria-activedescendant.
 *   Focus trap: Tab/Shift+Tab cycle within the dialog; focus never escapes to background.
 *   Focus restore: the element that had focus before open regains it on close/unmount.
 * - Styled with design-system CSS variables (supports both light and dark themes).
 * - Presentation only: all document changes go through dispatch (PRIME DIRECTIVE).
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { listCommands } from '@core/commands/registry';
import type { CommandDefinition } from '@core/commands/types';
import { ParamForm } from '@ui/panels/ParamForm';
import { useStore } from '@ui/store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PaletteView = 'list' | 'form';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toLabel(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Fuzzy substring filter: both `name` and `description` are searched
 * (case-insensitive). A match exists when `query` appears as a substring
 * (subsequence-free, simple includes — fast and predictable).
 */
function filterCommands(
  commands: ReadonlyArray<CommandDefinition<unknown>>,
  query: string,
): ReadonlyArray<CommandDefinition<unknown>> {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (cmd) =>
      cmd.name.toLowerCase().includes(q) || cmd.description.toLowerCase().includes(q),
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps): React.ReactElement | null {
  const dispatch = useStore((s) => s.dispatch);
  const uid = useId();

  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [view, setView] = useState<PaletteView>('list');
  const [activeCommand, setActiveCommand] = useState<CommandDefinition<unknown> | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  /** The element that had focus when the palette was opened; restored on close. */
  const priorFocusRef = useRef<Element | null>(null);

  const allCommands = useMemo(() => listCommands(), []);
  const filteredCommands = useMemo(
    () => filterCommands(allCommands, query),
    [allCommands, query],
  );

  // Reset state when the palette opens; restore focus when it closes.
  useEffect(() => {
    if (isOpen) {
      // Save the currently-focused element so we can restore it on close.
      priorFocusRef.current = document.activeElement;
      setQuery('');
      setHighlightedIndex(0);
      setView('list');
      setActiveCommand(null);
      // Focus the search input on the next tick (after rendering).
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    } else {
      // Restore focus to the element that was active before the palette opened.
      const prior = priorFocusRef.current;
      if (prior && prior instanceof HTMLElement && document.contains(prior)) {
        prior.focus();
      }
      priorFocusRef.current = null;
    }
  }, [isOpen]);

  // Keep highlightedIndex in bounds when the filtered list changes.
  useEffect(() => {
    setHighlightedIndex((prev) =>
      filteredCommands.length === 0 ? 0 : Math.min(prev, filteredCommands.length - 1),
    );
  }, [filteredCommands.length]);

  // Scroll the highlighted item into view (jsdom does not implement scrollIntoView).
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[highlightedIndex];
    if (item && typeof (item as HTMLElement).scrollIntoView === 'function') {
      (item as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const selectCommand = useCallback(
    (cmd: CommandDefinition<unknown>) => {
      const hasRequired = cmd.paramsSchema.required.length > 0;
      if (!hasRequired) {
        // Dispatch immediately — no params needed.
        dispatch(cmd.name, {});
        handleClose();
      } else {
        setActiveCommand(cmd);
        setView('form');
        // Focus the first input in the form on next tick.
        requestAnimationFrame(() => {
          const firstInput = document.querySelector<HTMLElement>(
            `#${CSS.escape(`${uid}-form`)} input, #${CSS.escape(`${uid}-form`)} select`,
          );
          firstInput?.focus();
        });
      }
    },
    [dispatch, handleClose, uid],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // --- Focus trap: Tab / Shift+Tab must stay within the dialog. ---
      if (e.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.closest('[aria-hidden="true"]'));
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
        return;
      }

      if (view === 'form') {
        if (e.key === 'Escape') {
          e.preventDefault();
          setView('list');
          setActiveCommand(null);
          requestAnimationFrame(() => inputRef.current?.focus());
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filteredCommands[highlightedIndex];
        if (cmd) selectCommand(cmd);
        return;
      }
    },
    [view, handleClose, filteredCommands, highlightedIndex, selectCommand],
  );

  const handleFormSubmit = useCallback(
    (params: Record<string, unknown>) => {
      if (!activeCommand) return;
      dispatch(activeCommand.name, params);
      handleClose();
    },
    [activeCommand, dispatch, handleClose],
  );

  // Close on backdrop click.
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) handleClose();
    },
    [handleClose],
  );

  if (!isOpen) return null;

  const listId = `${uid}-list`;
  const activeDescendant =
    view === 'list' && filteredCommands.length > 0
      ? `${uid}-item-${highlightedIndex}`
      : undefined;

  return (
    /* Backdrop */
    <div
      className="palette-backdrop"
      onClick={handleBackdropClick}
      aria-hidden={!isOpen}
    >
      {/* Dialog */}
      <div
        ref={dialogRef}
        className="palette-dialog"
        role="dialog"
        aria-modal
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
      >
        {view === 'list' ? (
          <>
            {/* Search bar */}
            <div className="palette-search-row">
              <span className="palette-search-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </span>
              <input
                ref={inputRef}
                type="text"
                className="palette-input"
                placeholder="Search commands…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlightedIndex(0);
                }}
                aria-label="Search commands"
                aria-autocomplete="list"
                aria-controls={listId}
                aria-activedescendant={activeDescendant}
                autoComplete="off"
                spellCheck={false}
              />
              <kbd className="palette-esc-hint" aria-label="Press Escape to close">Esc</kbd>
            </div>

            {/* Command list */}
            <ul
              ref={listRef}
              id={listId}
              className="palette-list"
              role="listbox"
              aria-label="Commands"
            >
              {filteredCommands.length === 0 ? (
                <li className="palette-empty" role="option" aria-selected={false}>
                  No commands match &ldquo;{query}&rdquo;
                </li>
              ) : (
                filteredCommands.map((cmd, i) => {
                  const isHighlighted = i === highlightedIndex;
                  return (
                    <li
                      key={cmd.name}
                      id={`${uid}-item-${i}`}
                      className={`palette-item${isHighlighted ? ' palette-item--highlighted' : ''}`}
                      role="option"
                      aria-selected={isHighlighted}
                      onMouseEnter={() => setHighlightedIndex(i)}
                      onClick={() => selectCommand(cmd)}
                    >
                      <span className="palette-item__name">{toLabel(cmd.name)}</span>
                      <span className="palette-item__desc">{cmd.description}</span>
                    </li>
                  );
                })
              )}
            </ul>

            {/* Footer */}
            <div className="palette-footer" aria-hidden="true">
              <span className="palette-hint"><kbd>↑↓</kbd> navigate</span>
              <span className="palette-hint"><kbd>↵</kbd> select</span>
              <span className="palette-hint"><kbd>Esc</kbd> close</span>
            </div>
          </>
        ) : (
          /* Param form view */
          activeCommand && (
            <div id={`${uid}-form`} className="palette-form-view">
              <div className="palette-form-header">
                <button
                  type="button"
                  className="palette-back-btn"
                  onClick={() => {
                    setView('list');
                    setActiveCommand(null);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                  aria-label="Back to command list"
                >
                  ← Back
                </button>
                <span className="palette-form-title">{toLabel(activeCommand.name)}</span>
              </div>
              <p className="palette-form-desc">{activeCommand.description}</p>
              <ParamForm
                schema={activeCommand.paramsSchema}
                onSubmit={handleFormSubmit}
                submitLabel={`Run ${toLabel(activeCommand.name)}`}
              />
            </div>
          )
        )}
      </div>
    </div>
  );
}
