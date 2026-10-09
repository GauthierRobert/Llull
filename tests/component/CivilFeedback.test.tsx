/**
 * Component tests for the Civil / Site panel "Feedback" button (react R11): it composes a mailto:
 * link with the app version, anonymous document statistics and the user's text — never document
 * content — and never changes the document.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { CivilPanel } from '@ui/panels/civil/CivilPanel';
import { feedbackMailto, feedbackStats } from '@ui/panels/civil/feedbackMail';
import { version } from '../../package.json';
import { localDispatch } from '../helpers/storeTestHelpers';

const SURVEY = ['1,0,0,10,TOPO', '2,20,0,11,TOPO', '3,0,20,12,TOPO', '4,20,20,13,TOPO'].join('\n');

function decodedBody(href: string): string {
  const body = new URL(href).searchParams.get('body');
  return body ?? '';
}

beforeEach(() => {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
});

describe('CivilFeedback', () => {
  it('opens a feedback box and prefills the mail with version, counts and the text only', () => {
    localDispatch('set_units', { units: 'm' });
    localDispatch('import_survey_points', { text: SURVEY, name: 'Secret client site' });
    localDispatch('create_surface', {});
    const before = useStore.getState().document;
    render(<CivilPanel />);

    expect(screen.queryByLabelText('Feedback text')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }));
    fireEvent.change(screen.getByLabelText('Feedback text'), {
      target: { value: 'Volumes match our tool within 1 %.' },
    });
    const link = screen.getByRole('link', { name: 'Send by e-mail' });
    const href = link.getAttribute('href') ?? '';
    expect(href).toMatch(/^mailto:/);
    expect(new URL(href).searchParams.get('subject')).toBe(`llull pilot feedback (v${version})`);
    const body = decodedBody(href);
    expect(body).toContain('Volumes match our tool within 1 %.');
    expect(body).toContain(`llull ${version}`);
    expect(body).toMatch(/Document: \d+ entities, unit m/);
    expect(body).toContain('pointGroup 1, surface 1, platform 0, alignment 0, manhole 0, pipe 0');
    expect(body).not.toContain('Secret client site');
    expect(body).not.toContain('TOPO');

    // jsdom cannot navigate to mailto:; the app's own click handler still runs.
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    expect(screen.queryByLabelText('Feedback text')).toBeNull();
    expect(useStore.getState().document).toBe(before);
  });

  it('counts civil objects per category and addresses the configured recipient', () => {
    const stats = feedbackStats(createEmptyDocument());
    expect(stats.entityCount).toBe(0);
    expect(Object.values(stats.civil).every((count) => count === 0)).toBe(true);
    const href = feedbackMailto('  hello  ', stats, 'pilot@example.com');
    expect(href.startsWith('mailto:pilot@example.com?subject=')).toBe(true);
    expect(decodedBody(href).startsWith('hello\n')).toBe(true);
  });
});
