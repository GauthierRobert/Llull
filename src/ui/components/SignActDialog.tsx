// Sign a human-only act: the user picks one of their enrolled signing keys and types its passphrase; the local backend signs the act payload
// (`/signing/sign`, kind payload) and the confirmation goes back to the caller, which dispatches the command with it. Only a key the desktop app
// TRUSTED counts: an untrusted key yields a refused command, never a recorded act. Used by every human gate of the app (PMI review, review
// dispositions, margin dispositions).

import React, { useEffect, useId, useState } from 'react';
import { ModalDialog } from '@ui/components/ModalDialog';
import { type SigningKey, fetchSigningKeys, signPayload } from '@ui/services/signing';

export interface SignActRequest {
  /** What the user is about to sign, in plain words. */
  readonly title: string;
  readonly summary: string;
  /** The SHA-256 to sign for a fresh nonce (the act payload the command will verify). */
  readonly payload: (nonce: string) => string;
  /** Called with the confirmation object { alg, keyId, publicKey, signature, nonce } after a successful signature. */
  readonly onSigned: (confirmation: Record<string, unknown>) => void;
}

const freshNonce = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');

export function SignActDialog({ request, onClose }: { request: SignActRequest; onClose: () => void }): React.ReactElement {
  const ids = useId();
  const [keys, setKeys] = useState<SigningKey[] | null>(null);
  const [keyId, setKeyId] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    void fetchSigningKeys().then(setKeys);
  }, []);
  const key = keys?.find((candidate) => candidate.keyId === (keyId || keys[0]?.keyId));

  async function submit(): Promise<void> {
    if (key === undefined) return;
    const nonce = freshNonce();
    const signed = await signPayload(key.keyId, passphrase, request.payload(nonce));
    if ('error' in signed) return setMessage(signed.error);
    setPassphrase('');
    request.onSigned({ ...(signed.signature as Record<string, unknown>), nonce });
    onClose();
  }

  return (
    <ModalDialog
      backdropClassName="shortcuts-backdrop"
      className="shortcuts-dialog"
      onClose={onClose}
      label={request.title}
      initialFocus="first"
    >
      <div className="shortcuts-dialog__header">
        <h2 className="shortcuts-dialog__title">{request.title}</h2>
      </div>
      <p className="analysis__hint" data-testid="sign-summary">
        {request.summary}
      </p>
      {keys !== null && keys.length === 0 && (
        <p className="analysis__hint" data-testid="sign-no-key">
          No signing key on this machine. Enroll one (llull keys create) and trust it in the desktop app (Keys).
        </p>
      )}
      <label className="field" htmlFor={`${ids}-key`}>
        <span className="field__label">Signing key</span>
        <select id={`${ids}-key`} data-testid="sign-key" value={key?.keyId ?? ''} onChange={(e) => setKeyId(e.target.value)}>
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
          data-testid="sign-passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
        />
      </label>
      {message !== '' && (
        <p className="analysis__hint" role="alert" data-testid="sign-error">
          {message}
        </p>
      )}
      <div className="confirm-dialog__actions">
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          data-testid="sign-confirm"
          disabled={key === undefined || passphrase === ''}
          onClick={() => void submit()}
        >
          Sign
        </button>
      </div>
    </ModalDialog>
  );
}
