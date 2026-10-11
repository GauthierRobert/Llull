/**
 * @layer ui/panels/building
 * BuildingForm — the `<form>` chrome shared by the building forms: fields, inline error, submit.
 */

import React from 'react';
import { FormError } from '@ui/panels/PanelParts';

interface BuildingFormProps {
  ariaLabel: string;
  error: string;
  submitLabel: string;
  submitTestId: string;
  testId?: string;
  onSubmit: () => void;
  children: React.ReactNode;
}

export function BuildingForm({
  ariaLabel,
  error,
  submitLabel,
  submitTestId,
  testId,
  onSubmit,
  children,
}: BuildingFormProps): React.ReactElement {
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
      <button type="submit" className="btn btn--primary btn--sm" data-testid={submitTestId}>
        {submitLabel}
      </button>
    </form>
  );
}
