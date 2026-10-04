/**
 * @layer ui/components/commandPalette
 *
 * Command palette (Ctrl/Cmd+K) — one searchable entry point to every app action and every
 * registry command. ARIA combobox + listbox; arrows / Home / End move, Enter runs, Escape closes.
 * A command with parameters opens its generated form; one without runs at once. Every document
 * change goes through `dispatch` (PRIME DIRECTIVE).
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CommandDefinition } from '@core/commands/types';
import { usePaletteStore, useStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { allPaletteItems, searchPaletteItems } from './paletteItems';
import type { PaletteItem } from './paletteItems';
import { CommandParamForm } from './CommandParamForm';

function runCommand(command: CommandDefinition<unknown>, params: Record<string, unknown>): void {
  // Clear the previous summary so an identical new one still registers as this run's result.
  useStore.setState({ lastSummary: null });
  usePaletteStore.getState().setAwaitingResultOf(command.name);
  useStore.getState().dispatch(command.name, params, { selectAffected: true });
}

interface PaletteListProps {
  items: readonly PaletteItem[];
  activeIndex: number;
  listId: string;
  grouped: boolean;
  onHover: (index: number) => void;
  onChoose: (item: PaletteItem) => void;
}

function PaletteList({
  items,
  activeIndex,
  listId,
  grouped,
  onHover,
  onChoose,
}: PaletteListProps): React.ReactElement {
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`#${CSS.escape(`${listId}-${activeIndex}`)}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, listId]);

  if (items.length === 0) {
    return (
      <p className="palette-empty" role="status">
        No matching command. Try a verb like “add”, “measure” or “export”.
      </p>
    );
  }

  return (
    <ul ref={listRef} id={listId} className="palette-list" role="listbox" aria-label="Commands">
      {items.map((item, index) => {
        const showHeader = grouped && item.group !== items[index - 1]?.group;
        return (
          <React.Fragment key={`${item.group}-${item.id}`}>
            {showHeader && (
              <li className="palette-group" role="presentation">
                {item.group}
              </li>
            )}
            <li
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={`palette-item${index === activeIndex ? ' palette-item--active' : ''}`}
              onMouseMove={() => {
                if (index !== activeIndex) onHover(index);
              }}
              onClick={() => onChoose(item)}
            >
              <span className="palette-item__icon">
                <Icon name={item.icon} size={15} />
              </span>
              <span className="palette-item__text">
                <span className="palette-item__label">{item.label}</span>
                <span className="palette-item__hint">{item.hint}</span>
              </span>
              {!grouped && <span className="palette-item__group">{item.group}</span>}
              {item.shortcut !== undefined && <kbd className="kbd">{item.shortcut}</kbd>}
            </li>
          </React.Fragment>
        );
      })}
    </ul>
  );
}

export function CommandPalette(): React.ReactElement | null {
  const open = usePaletteStore((s) => s.open);
  if (!open) return null;
  return <OpenPalette />;
}

function OpenPalette(): React.ReactElement {
  const setOpen = usePaletteStore((s) => s.setOpen);
  const recentIds = usePaletteStore((s) => s.recentIds);
  const recordRecent = usePaletteStore((s) => s.recordRecent);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [formCommand, setFormCommand] = useState<CommandDefinition<unknown> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  const catalog = useMemo(() => allPaletteItems(), []);
  const results = useMemo(
    () => searchPaletteItems(catalog, query, recentIds),
    [catalog, query, recentIds],
  );

  // Restore focus to whatever opened the palette when it closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    if (formCommand === null) inputRef.current?.focus();
  }, [formCommand]);

  const close = (): void => setOpen(false);

  const choose = (item: PaletteItem): void => {
    recordRecent(item.id);
    if (item.kind === 'action') {
      close();
      item.run();
    } else if (Object.keys(item.command.paramsSchema.properties).length === 0) {
      close();
      runCommand(item.command, {});
    } else {
      setFormCommand(item.command);
    }
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    const last = results.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: Math.min(activeIndex + 1, last),
      ArrowUp: Math.max(activeIndex - 1, 0),
      Home: 0,
      End: last,
      PageDown: Math.min(activeIndex + 8, last),
      PageUp: Math.max(activeIndex - 8, 0),
    };
    const next = moves[e.key];
    if (next !== undefined && results.length > 0) {
      e.preventDefault();
      setActiveIndex(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = results[activeIndex];
      if (item !== undefined) choose(item);
    }
  };

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
      >
        {formCommand === null ? (
          <>
            <div className="palette-search">
              <Icon name="search" size={16} />
              <input
                ref={inputRef}
                className="palette-search__input"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={results.length > 0 ? `${listId}-${activeIndex}` : undefined}
                aria-label="Search commands"
                placeholder="Search actions and commands…"
                spellCheck={false}
                autoComplete="off"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={onInputKeyDown}
              />
              <kbd className="kbd">Esc</kbd>
            </div>
            <PaletteList
              items={results}
              activeIndex={activeIndex}
              listId={listId}
              grouped={query.trim() === ''}
              onHover={setActiveIndex}
              onChoose={choose}
            />
            <footer className="palette-footer" aria-hidden="true">
              <span>
                <kbd className="kbd">↑</kbd>
                <kbd className="kbd">↓</kbd> navigate
              </span>
              <span>
                <kbd className="kbd">↵</kbd> run
              </span>
              <span className="palette-footer__count">
                {results.length} result{results.length === 1 ? '' : 's'}
              </span>
            </footer>
          </>
        ) : (
          <CommandParamForm
            command={formCommand}
            onBack={() => setFormCommand(null)}
            onSubmit={(params) => {
              close();
              runCommand(formCommand, params);
            }}
          />
        )}
      </div>
    </div>
  );
}
