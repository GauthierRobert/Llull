// Reviewed issue draft for an internal command failure (SC-A4). Shows exactly what would be included (title, body, reproducer);
// every field is editable and the reproducer can be left out. Nothing is sent: Copy and Save are local, "Open GitHub issue draft"
// hands a prefilled link to the system browser (user's choice). Offline works (the backend crash report is optional).

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { version as APP_VERSION } from '../../../package.json';
import { useStore } from '@ui/store';
import { fetchLatestCrashReport } from '@ui/store/serverCommands';
import { downloadText } from '@ui/download';
import { useFailureStore, type CommandFailure } from '@ui/report/failureStore';
import { buildReproducer, crashReportFor } from '@ui/report/reproducer';
import { composeIssue, issueBody, issueTitle, issueUrl } from '@ui/report/issueDraft';
import { Icon } from './Icon';
import { ModalDialog } from './ModalDialog';

const platformLabel = (): string => (typeof navigator === 'undefined' ? 'unknown' : (navigator.platform || navigator.userAgent).trim());

/** The latest backend crash report, once, while the backend is reachable; `undefined` = none / unreachable. */
function useBackendCrashReport(failure: CommandFailure, online: boolean): unknown {
  const [report, setReport] = useState<unknown>(undefined);
  useEffect(() => {
    if (!online) return;
    let live = true;
    fetchLatestCrashReport().then(
      (found) => live && setReport(crashReportFor(found, failure.at)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [failure.at, online]);
  return report;
}

function ReportIssueForm({ failure, onClose }: { failure: CommandFailure; onClose: () => void }): React.ReactElement {
  const history = useStore((s) => s.document.featureHistory);
  const online = useStore((s) => s.liveStatus === 'connected');
  const crashReport = useBackendCrashReport(failure, online);
  const source = useMemo(() => buildReproducer(history, failure, crashReport), [history, failure, crashReport]);
  const defaultReproducer = useMemo(() => JSON.stringify(source.plan, null, 2), [source]);
  const defaultTitle = issueTitle({ ...failure, commandName: failure.name, appVersion: APP_VERSION, platform: platformLabel() });
  const defaultBody = useMemo(
    () =>
      issueBody({
        commandName: failure.name,
        params: failure.params,
        summary: failure.summary,
        appVersion: APP_VERSION,
        platform: platformLabel(),
      }),
    [failure],
  );
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [bodyEdit, setBodyEdit] = useState<string | null>(null);
  const [reproducerEdit, setReproducerEdit] = useState<string | null>(null);
  const [attach, setAttach] = useState(true);
  const [copied, setCopied] = useState(false);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const title = titleEdit ?? defaultTitle;
  const body = bodyEdit ?? defaultBody;
  const reproducer = reproducerEdit ?? defaultReproducer;
  const attached = attach ? reproducer : null;
  const link = issueUrl(title, body, attached);

  const copy = (): void => {
    void navigator.clipboard.writeText(`${title}\n\n${composeIssue(body, attached)}`).then(() => setCopied(true));
  };
  const openDraft = (): void => void window.open(link.url, '_blank', 'noopener,noreferrer');

  return (
    <ModalDialog
      backdropClassName="shortcuts-backdrop"
      className="shortcuts-dialog report-dialog"
      onClose={onClose}
      labelledBy={titleId}
      initialFocus={closeRef}
    >
      <div className="shortcuts-dialog__header">
        <h2 id={titleId} className="shortcuts-dialog__title">
          Report this problem
        </h2>
        <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="Close report" title="Close">
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="report-dialog__body">
        <p className="report-dialog__lead">
          Review what would be shared. Nothing is sent automatically, and your document is never attached: only the text below.
        </p>
        <label className="report-dialog__field">
          <span className="report-dialog__label">Title</span>
          <input type="text" value={title} onChange={(e) => setTitleEdit(e.target.value)} />
        </label>
        <label className="report-dialog__field">
          <span className="report-dialog__label">Description (error, command, environment)</span>
          <textarea className="report-dialog__text" rows={11} value={body} onChange={(e) => setBodyEdit(e.target.value)} />
        </label>
        <label className="report-dialog__check">
          <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
          <span>
            Include the reproducer ({source.plan.actions.length} command{source.plan.actions.length === 1 ? '' : 's'},{' '}
            {source.origin === 'crash-report' ? 'from the local crash report' : 'from this document’s history'})
          </span>
        </label>
        <label className="report-dialog__field">
          <span className="report-dialog__label">Reproducer (build_project plan)</span>
          <textarea
            className="report-dialog__text report-dialog__text--code"
            rows={8}
            value={reproducer}
            disabled={!attach}
            onChange={(e) => setReproducerEdit(e.target.value)}
          />
        </label>
        {link.truncated && (
          <p className="report-dialog__note" role="status">
            Too long for a link: the opened draft is shortened. Use “Save reproducer…” and attach the file to the issue.
          </p>
        )}
      </div>
      <div className="report-dialog__actions">
        <button type="button" className="btn btn--ghost" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => downloadText(reproducer, 'llull-reproducer.json', 'application/json')}
        >
          Save reproducer…
        </button>
        <button type="button" className="btn btn--primary" onClick={openDraft}>
          Open GitHub issue draft
        </button>
      </div>
    </ModalDialog>
  );
}

export function ReportIssueDialog(): React.ReactElement | null {
  const failure = useFailureStore((s) => s.failure);
  const open = useFailureStore((s) => s.dialogOpen);
  const close = useFailureStore((s) => s.closeDialog);
  if (!open || failure === null) return null;
  return <ReportIssueForm failure={failure} onClose={close} />;
}
