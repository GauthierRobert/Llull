/**
 * The text of a feature-failure issue (SC-A4) and its prefilled GitHub "new issue" URL. Pure: the dialog shows exactly these strings,
 * and opening the URL (the user's choice) is the only thing that ever leaves the app.
 */
import { redactHomePaths, redactedJson } from './redact';

export const ISSUES_URL = 'https://github.com/GauthierRobert/Llull/issues/new';
/** Longest URL we hand to the browser (GitHub answers 414 above roughly 8k). */
export const MAX_ISSUE_URL_CHARS = 7000;
const MAX_PARAMS_CHARS = 1500;
const TRUNCATION_NOTE = '\n\n_(truncated to fit a link: attach the saved reproducer file instead)_';

export interface FailureFacts {
  readonly commandName: string;
  readonly params: unknown;
  readonly summary: string;
  readonly appVersion: string;
  readonly platform: string;
}

export const issueTitle = (facts: FailureFacts): string => `Command failed: ${facts.commandName} — ${facts.summary}`.slice(0, 120);

/** The editable body (no reproducer): what happened, the redacted command and the environment. */
export function issueBody(facts: FailureFacts): string {
  const params = redactedJson(facts.params, 2);
  const shownParams = params.length > MAX_PARAMS_CHARS ? `${params.slice(0, MAX_PARAMS_CHARS)}\n…` : params;
  return [
    '**What I was doing**',
    '',
    '',
    '**Error**',
    '```',
    redactHomePaths(facts.summary),
    '```',
    '',
    `**Command** \`${facts.commandName}\``,
    '```json',
    shownParams,
    '```',
    '',
    `llull ${facts.appVersion} · ${facts.platform}`,
  ].join('\n');
}

const reproducerSection = (reproducerJson: string): string =>
  ['', '**Reproducer** (a `build_project` plan: run it on an empty document)', '```json', reproducerJson, '```'].join('\n');

/** The whole issue text as the user would paste it. */
export const composeIssue = (body: string, reproducerJson: string | null): string =>
  reproducerJson === null ? body : `${body}\n${reproducerSection(reproducerJson)}`;

export interface IssueUrl {
  readonly url: string;
  /** The text was cut to fit the URL cap. */
  readonly truncated: boolean;
}

const linkOf = (title: string, text: string): string => `${ISSUES_URL}?${new URLSearchParams({ title, body: text }).toString()}`;

/** Largest prefix of `text` (plus the note) whose link fits `MAX_ISSUE_URL_CHARS`; `fits` is monotone in the prefix length. */
function longestFitting(text: string, fits: (candidate: string) => boolean): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, middle))) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

/** The prefilled link: the reproducer is cut first, then the body; the cut text says to attach the saved file. */
export function issueUrl(title: string, body: string, reproducerJson: string | null): IssueUrl {
  const full = composeIssue(body, reproducerJson);
  const direct = linkOf(title, full);
  if (direct.length <= MAX_ISSUE_URL_CHARS) return { url: direct, truncated: false };
  const fitsLink = (text: string): boolean => linkOf(title, `${text}${TRUNCATION_NOTE}`).length <= MAX_ISSUE_URL_CHARS;
  if (reproducerJson !== null && fitsLink(body)) {
    const room = longestFitting(reproducerJson, (cut) => fitsLink(composeIssue(body, cut)));
    const text = room.length > 0 ? composeIssue(body, room) : body;
    return { url: linkOf(title, `${text}${TRUNCATION_NOTE}`), truncated: true };
  }
  const cut = longestFitting(body, fitsLink);
  return { url: linkOf(title, `${cut}${TRUNCATION_NOTE}`), truncated: true };
}
