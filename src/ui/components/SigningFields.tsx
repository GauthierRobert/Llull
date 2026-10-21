// Shared signing form of every human gate: key picker + passphrase + error line, with the enrolled-keys state in `useSigningFields`.

import React, { useEffect, useId, useState } from 'react';
import { type SigningKey, fetchSigningKeys } from '@ui/services/signing';

export interface SigningFieldsState {
  readonly keys: SigningKey[] | null;
  /** The picked key (defaults to the first enrolled one). */
  readonly key: SigningKey | undefined;
  readonly setKeyId: (keyId: string) => void;
  readonly passphrase: string;
  readonly setPassphrase: (passphrase: string) => void;
  readonly message: string;
  readonly setMessage: (message: string) => void;
}

export function useSigningFields(): SigningFieldsState {
  const [keys, setKeys] = useState<SigningKey[] | null>(null);
  const [keyId, setKeyId] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    void fetchSigningKeys().then(setKeys);
  }, []);
  const key = keys?.find((candidate) => candidate.keyId === (keyId || keys[0]?.keyId));
  return { keys, key, setKeyId, passphrase, setPassphrase, message, setMessage };
}

/** "No signing key" hint (when none is enrolled). Test ids: `<prefix>-no-key`, `<prefix>-key`, `<prefix>-passphrase`, `<prefix>-error`. */
export function NoSigningKeyHint({
  prefix,
  keys,
  children,
}: {
  prefix: string;
  keys: SigningKey[] | null;
  children: string;
}): React.ReactNode {
  return (
    keys !== null &&
    keys.length === 0 && (
      <p className="analysis__hint" data-testid={`${prefix}-no-key`}>
        {children}
      </p>
    )
  );
}

export function SigningFields({ prefix, signing }: { prefix: string; signing: SigningFieldsState }): React.ReactElement {
  const ids = useId();
  const { key, keys, passphrase, message } = signing;
  return (
    <>
      <label className="field" htmlFor={`${ids}-key`}>
        <span className="field__label">Signing key</span>
        <select id={`${ids}-key`} data-testid={`${prefix}-key`} value={key?.keyId ?? ''} onChange={(e) => signing.setKeyId(e.target.value)}>
          {(keys ?? []).map((candidate) => (
            <option key={candidate.keyId} value={candidate.keyId}>
              {candidate.name} ({candidate.userId}){candidate.trusted === false ? ' - not trusted yet' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="field" htmlFor={`${ids}-pass`}>
        <span className="field__label">Key passphrase</span>
        <input
          id={`${ids}-pass`}
          type="password"
          autoComplete="off"
          data-testid={`${prefix}-passphrase`}
          value={passphrase}
          onChange={(e) => signing.setPassphrase(e.target.value)}
        />
      </label>
      {message !== '' && (
        <p className="analysis__hint" role="alert" data-testid={`${prefix}-error`}>
          {message}
        </p>
      )}
    </>
  );
}
