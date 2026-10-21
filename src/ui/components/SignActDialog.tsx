// Sign a human-only act: the user picks one of their enrolled signing keys and types its passphrase; the local backend signs the act payload
// (`/signing/sign`, kind payload) and the confirmation goes back to the caller, which dispatches the command with it. Only a key the desktop app
// TRUSTED counts: an untrusted key yields a refused command, never a recorded act. Used by every human gate of the app (PMI review, review
// dispositions, margin dispositions).

import React from 'react';
import { ModalDialog } from '@ui/components/ModalDialog';
import { NoSigningKeyHint, SigningFields, useSigningFields } from '@ui/components/SigningFields';
import { signPayload, signPmiReview } from '@ui/services/signing';

export interface SignActRequest {
  /** What the user is about to sign, in plain words. */
  readonly title: string;
  readonly summary: string;
  /** The command the act belongs to (recorded in the audit chain with the payload). */
  readonly act: string;
  /** The SHA-256 to sign for a fresh nonce (the act payload the command will verify); absent when the server computes it (`pmiReview`). */
  readonly payload?: (nonce: string) => string;
  /** A PMI review: the local backend computes the payload from the live document. */
  readonly pmiReview?: { readonly pmiIds: readonly string[]; readonly decision: 'accept' | 'reject'; readonly comment: string };
  /** Called with the confirmation object { alg, keyId, publicKey, signature, nonce } after a successful signature. */
  readonly onSigned: (confirmation: Record<string, unknown>) => void;
}

const freshNonce = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');

export function SignActDialog({ request, onClose }: { request: SignActRequest; onClose: () => void }): React.ReactElement {
  const signing = useSigningFields();
  const { key, passphrase } = signing;

  async function submit(): Promise<void> {
    if (key === undefined) return;
    const nonce = freshNonce();
    const signed =
      request.pmiReview !== undefined
        ? await signPmiReview(key.keyId, passphrase, request.pmiReview, nonce)
        : await signPayload(key.keyId, passphrase, request.act, request.payload?.(nonce) ?? '');
    if ('error' in signed) return signing.setMessage(signed.error);
    signing.setPassphrase('');
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
      <NoSigningKeyHint prefix="sign" keys={signing.keys}>
        No signing key on this machine. Enroll one (llull keys create) and trust it in the desktop app (Keys).
      </NoSigningKeyHint>
      <SigningFields prefix="sign" signing={signing} />
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
