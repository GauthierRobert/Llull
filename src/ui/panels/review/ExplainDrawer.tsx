// Explain drawer (FR-FPR-57): where a number in the Review tab comes from — method, solver/kernel versions, tolerances, inputs, threshold
// with its source, the accuracy block per value (band, basis, origin, validation level, S/D/E/U_val, warnings) and a "copy as CLI" button.

import React, { useState } from 'react';
import { Icon } from '@ui/components/Icon';
import { StatusMark } from './StatusMark';
import { describeValueKey, formatThreshold, formatValue, itemStatusLabel } from './checklist';
import { explainCliCommand } from './explainCli';
import { bandText } from './AccuracyBadge';
import type { Accuracy, CheckItem, CheckResult } from './reviewTypes';

function AccuracyBlock({ valueKey, accuracy }: { valueKey: string; accuracy: Accuracy }): React.ReactElement {
  const { comparison } = accuracy;
  return (
    <div className="explain__accuracy" data-testid={`explain-accuracy-${valueKey}`}>
      <p>
        <strong>{describeValueKey(valueKey).label}</strong> <span className="explain__band">{bandText(accuracy.band)}</span>{' '}
        <span className="explain__origin">{accuracy.origin === 'verification' ? 'self-check' : accuracy.origin}</span>
      </p>
      <p className="panel__row-meta">
        basis: {accuracy.basis} · validation level {accuracy.validationLevel}
      </p>
      {comparison !== undefined && (
        <p className="panel__row-meta">
          vs {comparison.referenceId}: S {comparison.s} · D {comparison.d} · E {comparison.e} · U_val {comparison.uVal ?? '?'}
        </p>
      )}
      {accuracy.warnings.map((warning) => (
        <p key={warning} className="explain__warning">
          <span aria-hidden="true">▲</span> {warning}
        </p>
      ))}
    </div>
  );
}

function CopyCliButton({ command }: { command: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn--sm"
      data-testid="explain-copy-cli"
      onClick={() =>
        void navigator.clipboard.writeText(command).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      <Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'Copied' : 'Copy as CLI'}
    </button>
  );
}

interface ExplainDrawerProps {
  readonly result: CheckResult;
  readonly item: CheckItem;
  readonly onClose: () => void;
}

export function ExplainDrawer({ result, item, onClose }: ExplainDrawerProps): React.ReactElement {
  const { provenance } = result;
  const threshold = formatThreshold(item);
  const command = explainCliCommand(result);
  return (
    <aside className="explain" role="complementary" aria-label={`Explain ${item.code}`} data-testid="explain-drawer">
      <header className="explain__header">
        <h3 className="explain__title">{item.code}</h3>
        <StatusMark status={item.status} label={itemStatusLabel(item)} />
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close explanation" title="Close">
          <Icon name="close" size={14} />
        </button>
      </header>
      <dl className="explain__facts">
        <dt>Method</dt>
        <dd data-testid="explain-method">{provenance.method}</dd>
        {provenance.kernel !== undefined && (
          <>
            <dt>Kernel</dt>
            <dd>{provenance.kernel}</dd>
          </>
        )}
        {provenance.engine !== undefined && (
          <>
            <dt>Engine</dt>
            <dd>{provenance.engine}</dd>
          </>
        )}
        <dt>Check</dt>
        <dd>{result.check.replace('_', ' ')}</dd>
        <dt>Inputs hash</dt>
        <dd className="explain__mono">{result.inputsHash}</dd>
        {item.ids.length > 0 && (
          <>
            <dt>Parts</dt>
            <dd>{item.ids.join(', ')}</dd>
          </>
        )}
        {threshold !== null && (
          <>
            <dt>Threshold</dt>
            <dd data-testid="explain-threshold">{threshold}</dd>
          </>
        )}
        {Object.keys(provenance.tolerances).length > 0 && (
          <>
            <dt>Tolerances</dt>
            <dd className="explain__mono">
              {Object.entries(provenance.tolerances)
                .map(([key, value]) => `${key} ${value}`)
                .join(' · ')}
            </dd>
          </>
        )}
      </dl>
      {(item.unverified === true || result.unverified) && (
        <p className="explain__warning" data-testid="explain-unverified">
          <span aria-hidden="true">○</span> unverified: at least one input is a stated assumption, not a sourced value.
        </p>
      )}
      <h4 className="readiness__subheader">Values</h4>
      <ul className="explain__values">
        {Object.entries(item.values).map(([key, value]) => (
          <li key={key}>
            <span>{describeValueKey(key).label}</span> <strong>{formatValue(key, value)}</strong>
            {item.accuracy?.[key] !== undefined && <AccuracyBlock valueKey={key} accuracy={item.accuracy[key]} />}
            {item.accuracy?.[key] === undefined && <span className="panel__row-meta"> ± ? (no accuracy estimate)</span>}
          </li>
        ))}
      </ul>
      <p className="finding__remediation">{item.remediation}</p>
      <CopyCliButton command={command} />
      <pre className="explain__cli" data-testid="explain-cli">
        {command}
      </pre>
    </aside>
  );
}
