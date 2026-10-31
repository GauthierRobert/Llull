// Colour swatch that opens the system picker and commits once, when the picker closes (the native `change` event; React's
// onChange fires on every drag step and would flood the history). Previews the picked colour locally until then.

import React, { useEffect, useRef, useState } from 'react';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function ColorField({ value, onCommit }: { value: string; onCommit: (color: string) => void }): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return undefined;
    const onChange = (): void => {
      setDraft(null);
      if (input.value.toLowerCase() !== value.toLowerCase()) commitRef.current(input.value);
    };
    input.addEventListener('change', onChange);
    return () => input.removeEventListener('change', onChange);
  }, [value]);

  return (
    <label className="props-color" title="Change the display colour">
      <input
        ref={inputRef}
        type="color"
        className="props-color-input"
        aria-label="Color"
        value={HEX_COLOR.test(shown) ? shown : '#888888'}
        onChange={(e) => setDraft(e.target.value)}
      />
      <span className="props-number">{shown}</span>
    </label>
  );
}
