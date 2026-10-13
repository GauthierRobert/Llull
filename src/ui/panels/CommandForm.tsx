/**
 * CommandForm — the `<form>` chrome shared by the panel forms that gather one command's params:
 * fields, inline error, submit button.
 */

import React from 'react';
import { classNames } from '@ui/classNames';
import { FormError } from '@ui/panels/PanelParts';

interface CommandFormProps {
  ariaLabel: string;
  submitLabel: string;
  /** Inline error shown above the submit button; omitted = none. */
  error?: string;
  submitTestId?: string;
  testId?: string;
  /** Submit button look; default the primary action. */
  ghostSubmit?: boolean;
  submitDisabled?: boolean;
  onSubmit: () => void;
  children: React.ReactNode;
}

export function CommandForm({
  ariaLabel,
  submitLabel,
  error = '',
  submitTestId,
  testId,
  ghostSubmit = false,
  submitDisabled,
  onSubmit,
  children,
}: CommandFormProps): React.ReactElement {
  return (
    <form
      className="panel__form building-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {children}
      <FormError text={error} />
      <button
        type="submit"
        className={classNames('btn btn--sm', ghostSubmit ? 'btn--ghost' : 'btn--primary')}
        data-testid={submitTestId}
        disabled={submitDisabled}
      >
        {submitLabel}
      </button>
    </form>
  );
}
