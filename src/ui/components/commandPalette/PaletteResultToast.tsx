/**
 * @layer ui/components/commandPalette
 *
 * Result toast for commands run from the palette: the palette closes on run, so the command's
 * `summary` (its feedback signal) is shown here until dismissed or timed out (paused on hover /
 * focus). Presentation only.
 */

import React, { useEffect, useState } from 'react';
import { usePaletteStore, useStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { humanizeName } from './paramForm';

const TOAST_MS = 6000;
const FAILURE_PATTERN =
  /rejected|unknown command|not available|not ready|^no |could not|cannot|failed/i;

interface ToastContent {
  commandName: string;
  summary: string;
  failed: boolean;
}

export function PaletteResultToast(): React.ReactElement | null {
  const lastSummary = useStore((s) => s.lastSummary);
  const awaitingResultOf = usePaletteStore((s) => s.awaitingResultOf);
  const setAwaitingResultOf = usePaletteStore((s) => s.setAwaitingResultOf);
  const [toast, setToast] = useState<ToastContent | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (awaitingResultOf === null || lastSummary === null) return;
    setToast({
      commandName: awaitingResultOf,
      summary: lastSummary,
      failed: FAILURE_PATTERN.test(lastSummary),
    });
    setAwaitingResultOf(null);
  }, [awaitingResultOf, lastSummary, setAwaitingResultOf]);

  useEffect(() => {
    if (toast === null || paused) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast, paused]);

  if (toast === null) return null;

  return (
    <div
      className={`palette-toast${toast.failed ? ' palette-toast--failed' : ''}`}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="palette-toast__icon" aria-hidden="true">
        <Icon name={toast.failed ? 'info' : 'check'} size={14} />
      </span>
      <span className="palette-toast__text">
        <strong className="palette-toast__title">{humanizeName(toast.commandName)}</strong>
        <span className="palette-toast__summary">{toast.summary}</span>
      </span>
      <button
        type="button"
        className="icon-btn"
        onClick={() => setToast(null)}
        aria-label="Dismiss result"
        title="Dismiss"
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
