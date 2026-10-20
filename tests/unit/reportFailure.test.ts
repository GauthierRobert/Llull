/** SC-A4 pure helpers: failure classifier, redaction, reproducer builder, issue text + capped URL. */
import { describe, expect, it } from 'vitest';
import type { FeatureStep } from '@core/model/types';
import { classifyFailure } from '@ui/report/classifyFailure';
import { redactHomePaths, redactedJson } from '@ui/report/redact';
import { buildReproducer, crashReportFor } from '@ui/report/reproducer';
import { composeIssue, issueBody, issueTitle, issueUrl, ISSUES_URL, MAX_ISSUE_URL_CHARS } from '@ui/report/issueDraft';

describe('classifyFailure', () => {
  it.each([
    ['fillet_edges failed: Standard_DomainError; document unchanged.', 'internal'],
    ['Command add_box failed: boom', 'internal'],
    ['boolean_union failed: NATIVE_OCC_FAILURE: BRepAlgo threw; document unchanged.', 'internal'],
    ['kernel said NATIVE_PANIC for op fuse', 'internal'],
    ['Server responded with HTTP 500 for /command', 'internal'],
    ['add_box failed: NATIVE_UNSUPPORTED: op loadBlob', 'unsupported'],
    ['add_box rejected: invalid params — size: expected array. Document unchanged.', 'user'],
    ['add_box failed: size must be positive.', 'user'],
    ['Server responded with HTTP 400 for /command', 'user'],
    ['Created box-1', 'user'],
  ] as const)('%s -> %s', (summary, kind) => {
    expect(classifyFailure(summary)).toBe(kind);
  });
});

describe('redaction', () => {
  it('replaces home directories in either slash style', () => {
    expect(redactHomePaths('C:\\Users\\alice\\Docs\\a.step')).toBe('~\\Docs\\a.step');
    expect(redactHomePaths('C:/Users/alice/a.step /Users/bob/x /home/carol/y')).toBe('~/a.step ~/x ~/y');
    expect(redactHomePaths(JSON.stringify({ path: 'C:\\Users\\alice\\a.step' }))).not.toContain('alice');
  });
  it('drops human signatures like the crash reports do and does not mutate', () => {
    const params = { name: 'x', confirmation: { signedBy: 'Alice', token: 'secret' }, nested: [{ confirmation: { signedBy: 'B' } }] };
    const text = redactedJson(params);
    expect(text).not.toContain('Alice');
    expect(text).not.toContain('secret');
    expect(text).toContain('"verified":true');
    expect(params.confirmation.signedBy).toBe('Alice');
  });
});

const step = (id: string, name: string, params: unknown, suppressed?: true): FeatureStep => ({
  id,
  name,
  params,
  ...(suppressed ? { suppressed } : {}),
});

describe('buildReproducer', () => {
  const history = [
    step('step-1', 'add_box', { size: [1, 1, 1] }),
    step('step-2', 'move', { id: 'x' }, true),
    step('step-3', 'add_sphere', {}),
  ];
  const failed = { name: 'fillet_edges', params: { radius: 2, note: 'C:\\Users\\alice\\n' } };

  it('from the document history: unsuppressed steps then the redacted failing command, as a build_project plan', () => {
    const { origin, plan } = buildReproducer(history, failed);
    expect(origin).toBe('document-history');
    expect(plan.onError).toBe('abort');
    expect(plan.actions.map((a) => a.command)).toEqual(['add_box', 'add_sphere', 'fillet_edges']);
    expect(JSON.stringify(plan)).not.toContain('alice');
  });

  const crash = {
    time: '2026-10-19T12:00:00.000Z',
    commandLog: {
      replayFrom: 'empty',
      commands: [{ name: 'add_box', params: { size: [2, 2, 2] } }],
      failing: { name: 'fillet_edges', params: { radius: 9 } },
    },
  };

  it('prefers a crash report that replays from empty and ends in this command', () => {
    const { origin, plan } = buildReproducer(history, failed, crash);
    expect(origin).toBe('crash-report');
    expect(plan.actions).toEqual([
      { command: 'add_box', params: { size: [2, 2, 2] } },
      { command: 'fillet_edges', params: { radius: 9 } },
    ]);
  });

  it.each([
    ['another command failed', { ...crash, commandLog: { ...crash.commandLog, failing: { name: 'other', params: {} } } }],
    ['it replays from a base file', { ...crash, commandLog: { ...crash.commandLog, replayFrom: 'base.llull.json' } }],
    ['it is malformed', { nothing: true }],
  ])('falls back to the history when %s', (_why, report) => {
    expect(buildReproducer(history, failed, report).origin).toBe('document-history');
  });

  it('crashReportFor ignores a report older than the failure', () => {
    const at = Date.parse(crash.time);
    expect(crashReportFor(crash, at)).toBe(crash);
    expect(crashReportFor(crash, at + 60_000)).toBeUndefined();
    expect(crashReportFor({ time: 3 }, at)).toBeUndefined();
  });
});

describe('issue text and URL', () => {
  const facts = {
    commandName: 'fillet_edges',
    params: { radius: 2 },
    summary: 'fillet_edges failed: boom; document unchanged.',
    appVersion: '0.1.0',
    platform: 'Win32',
  };

  it('title and body carry the error, command, params, version and platform', () => {
    expect(issueTitle(facts)).toContain('fillet_edges');
    const body = issueBody(facts);
    for (const expected of ['boom', '`fillet_edges`', '"radius": 2', 'llull 0.1.0 · Win32']) expect(body).toContain(expected);
  });

  it('a short issue is one untruncated link to the project issue form with the reproducer inside', () => {
    const { url, truncated } = issueUrl('T', issueBody(facts), '{"actions":[]}');
    expect(truncated).toBe(false);
    expect(url.startsWith(`${ISSUES_URL}?`)).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('title')).toBe('T');
    expect(params.get('body')).toContain('{"actions":[]}');
  });

  it('without the reproducer the body has no plan', () => {
    expect(new URL(issueUrl('T', 'body', null).url).searchParams.get('body')).toBe('body');
    expect(composeIssue('body', null)).toBe('body');
  });

  it('caps the URL: the reproducer is cut first and the note says to attach the saved file', () => {
    const reproducer = JSON.stringify({ actions: Array.from({ length: 2000 }, (_, i) => ({ command: 'add_box', params: { i } })) });
    const { url, truncated } = issueUrl('T', issueBody(facts), reproducer);
    expect(truncated).toBe(true);
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_CHARS);
    const body = new URL(url).searchParams.get('body') ?? '';
    expect(body).toContain('attach the saved reproducer');
    expect(body).toContain('boom');
  });

  it('a huge body is cut too', () => {
    const { url, truncated } = issueUrl('T', 'x'.repeat(50_000), null);
    expect(truncated).toBe(true);
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_CHARS);
  });
});
