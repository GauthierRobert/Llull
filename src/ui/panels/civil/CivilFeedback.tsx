/**
 * @layer ui/panels/civil
 *
 * CivilFeedback — the pilot "Feedback" button of the Civil / Site panel header: a short text box
 * and a mailto: link prefilled with the app version and anonymous document statistics (no document
 * content). Presentation only: reads the store, never changes the document.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { feedbackMailto, feedbackStats } from './feedbackMail';

/** Mounted only while open, so the panel header does not re-render on every document change. */
function FeedbackForm({ onSent }: { onSent: () => void }): React.ReactElement {
  const document = useStore((s) => s.document);
  const [text, setText] = useState('');
  return (
    <div className="civil-form" role="group" aria-label="Pilot feedback">
      <textarea
        value={text}
        rows={3}
        placeholder="What worked, what blocked you, what your current tool does better…"
        aria-label="Feedback text"
        onChange={(event) => setText(event.target.value)}
      />
      <a
        className="btn btn--primary btn--sm"
        href={feedbackMailto(text, feedbackStats(document))}
        onClick={onSent}
      >
        Send by e-mail
      </a>
    </div>
  );
}

export function CivilFeedback(): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="civil-feedback">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-expanded={open}
        title="Send pilot feedback by e-mail (app version and object counts only, no document content)"
        onClick={() => setOpen((value) => !value)}
      >
        Feedback
      </button>
      {open && <FeedbackForm onSent={() => setOpen(false)} />}
    </div>
  );
}
