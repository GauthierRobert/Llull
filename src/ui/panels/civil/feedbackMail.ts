/**
 * @layer ui/panels/civil
 *
 * Pilot feedback e-mail: a `mailto:` link prefilled with the app version, anonymous document
 * statistics (entity count, unit, civil object counts per category) and the user's text. Never
 * includes document content (names, coordinates, survey data).
 */

import { CIVIL_CATEGORIES, type CivilCategory } from '@core/model/civil';
import type { CadDocument } from '@core/model/types';
import { version as APP_VERSION } from '../../../../package.json';

/** Recipient from the build (`VITE_LLULL_FEEDBACK_EMAIL`); empty lets the user pick it. */
const FEEDBACK_RECIPIENT: string = (() => {
  const value: unknown = import.meta.env['VITE_LLULL_FEEDBACK_EMAIL'];
  return typeof value === 'string' ? value.trim() : '';
})();

export interface FeedbackStats {
  units: string;
  entityCount: number;
  civil: Readonly<Record<CivilCategory, number>>;
}

export function feedbackStats(doc: CadDocument): FeedbackStats {
  const civil = Object.fromEntries(CIVIL_CATEGORIES.map((category) => [category, 0])) as Record<
    CivilCategory,
    number
  >;
  for (const id of doc.civil?.order ?? []) {
    const category = doc.civil?.objects[id]?.category;
    if (category !== undefined) civil[category] += 1;
  }
  return { units: doc.units, entityCount: doc.order.length, civil };
}

export function feedbackBody(text: string, stats: FeedbackStats): string {
  const counts = CIVIL_CATEGORIES.map((category) => `${category} ${stats.civil[category]}`);
  return [
    text.trim(),
    '',
    '--',
    `llull ${APP_VERSION}`,
    `Document: ${stats.entityCount} entities, unit ${stats.units}`,
    `Civil objects: ${counts.join(', ')}`,
  ].join('\n');
}

export function feedbackMailto(
  text: string,
  stats: FeedbackStats,
  recipient: string = FEEDBACK_RECIPIENT,
): string {
  const subject = `llull pilot feedback (v${APP_VERSION})`;
  return (
    `mailto:${encodeURIComponent(recipient).replace(/%40/g, '@')}` +
    `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(feedbackBody(text, stats))}`
  );
}
