// Ctrl/Cmd+K palette over every app action + registry command (ARIA combobox/listbox, Tab trapped). A command with
// params (or destructive) opens its generated form, others run at once; the result is toasted via `onResult`.

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { getCommand } from '@core/commands/registry';
import type { CommandDefinition } from '@core/commands/types';
import { usePaletteStore, useStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { ModalDialog } from '@ui/components/ModalDialog';
import { type PaletteItem, allPaletteItems, searchPaletteItems } from './paletteItems';
import { CommandParamForm } from './CommandParamForm';

function runCommand(command: CommandDefinition<unknown>, params: Record<string, unknown>): void {
  const readOnly = command.annotations?.readOnly === true;
  useStore
    .getState()
    .dispatch(command.name, params, {
      selectAffected: true,
      onResult: ({ summary, changed }) =>
        usePaletteStore.getState().showResult({ commandName: command.name, summary, failed: !changed && !readOnly }),
    });
}

/** Takes input or would destroy content. */
function needsForm(command: CommandDefinition<unknown>): boolean {
  return Object.keys(command.paramsSchema.properties).length > 0 || command.annotations?.destructive === true;
}

interface PaletteListProps {
  items: readonly PaletteItem[];
  activeIndex: number;
  listId: string;
  grouped: boolean;
  onHover: (index: number) => void;
  onChoose: (item: PaletteItem) => void;
}

function PaletteList({ items, activeIndex, listId, grouped, onHover, onChoose }: PaletteListProps): React.ReactElement {
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${listId}-${activeIndex}`)}`)?.scrollIntoView?.({ block: 'nearest' });
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
              <li className="palette-group" role="presentation" aria-hidden="true">
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
  const [formCommand, setFormCommand] = useState<CommandDefinition<unknown> | null>(() => {
    const pending = usePaletteStore.getState().pendingCommand;
    return pending === null ? null : (getCommand(pending) ?? null);
  });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  const catalog = useMemo(() => allPaletteItems(), []);
  const results = useMemo(() => searchPaletteItems(catalog, query, recentIds), [catalog, query, recentIds]);

  useEffect(() => {
    if (formCommand === null) inputRef.current?.focus();
  }, [formCommand]);

  const close = (): void => setOpen(false);

  const choose = (item: PaletteItem): void => {
    if (item.kind === 'command' && needsForm(item.command)) {
      setFormCommand(item.command);
      return;
    }
    recordRecent(item.id);
    close();
    if (item.kind === 'action') item.run();
    else runCommand(item.command, {});
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
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const item = results[activeIndex];
      if (item !== undefined) choose(item);
    }
  };

  return (
    <ModalDialog
      backdropClassName="palette-backdrop"
      className="palette"
      onClose={close}
      closeOn="mousedown"
      label="Command palette"
      tabIndex={-1}
    >
      {formCommand === null ? (
        <>
          <div className="palette-search">
            <Icon name="search" size={16} />
            <input
              ref={inputRef}
              className="palette-search__input"
              role="combobox"
              aria-expanded={results.length > 0}
              aria-controls={results.length > 0 ? listId : undefined}
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
          preview
          onBack={() => {
            setFormCommand(null);
            setActiveIndex(0);
          }}
          onSubmit={(params) => {
            recordRecent(`command:${formCommand.name}`);
            close();
            runCommand(formCommand, params);
          }}
        />
      )}
    </ModalDialog>
  );
}
