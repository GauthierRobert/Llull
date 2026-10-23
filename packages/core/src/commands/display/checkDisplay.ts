/** check_display (plant 09 VIS §4, TR-VIS-16): consistency of the colour profiles against the document; read-only. */

import { findProfile } from '../../model/display';
import { referencedProperties } from '../../geometry/colourRules';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { displayOf, evaluateProfile, readProperties } from './displayModel';

type Severity = 'error' | 'warn';

interface DisplayIssue {
  readonly code: string;
  readonly severity: Severity;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @affects nothing — read-only; data { status, issues[{ code, severity, ids, paths, message, remediation }], counts }
 * @invariant issues are ordered by profile order, then code
 */
export const checkDisplay = defineCommand({
  name: 'check_display',
  description:
    'Check the document colour profiles. Reports VIS_PROFILE_NOT_FOUND (error: the active profile is missing), VIS_COLOUR_UNMATCHED (warn: entities that carry a property the ' +
    'active profile tests but matched no rule; data ids list them), VIS_RULE_PROPERTY_UNKNOWN (warn: a rule tests a property no entity of the document has), and ' +
    'VIS_SCHEME_REVIEW_REQUIRED (warn: the active profile is flagged reviewRequired: no qualified reviewer approved it). data { status: pass|warn|fail, issues[{ code, ' +
    'severity, ids, paths, message, remediation }], counts }. Run it after building a profile and before relying on its colours. Read-only.',
  annotations: { readOnly: true },
  params: z.object({}),
  run: (doc, _params, ctx): CommandResult => {
    const display = displayOf(doc);
    const issues: DisplayIssue[] = [];
    const present = new Set(doc.order.flatMap((id) => Object.keys(readProperties(doc, id, ctx))));
    for (const profile of Object.values(display.colourProfiles)) {
      for (const rule of profile.rules) {
        const keys = referencedProperties({ ...profile, rules: [rule] });
        const missing = [...keys].filter((key) => !present.has(key));
        if (missing.length > 0)
          issues.push({
            code: 'VIS_RULE_PROPERTY_UNKNOWN',
            severity: 'warn',
            ids: [],
            paths: [`display.colourProfiles.${profile.id}.rules.${rule.id}`],
            message: `rule '${rule.id}' of profile '${profile.id}' tests ${missing.join(', ')}, which no entity has`,
            remediation: 'check the property name, or add the entities that carry it',
          });
      }
    }
    const activeId = display.activeProfileId;
    const active = activeId === undefined ? undefined : findProfile(display, activeId);
    if (activeId !== undefined && active === undefined)
      issues.push({
        code: 'VIS_PROFILE_NOT_FOUND',
        severity: 'error',
        ids: [activeId],
        paths: ['display.activeProfileId'],
        message: `active profile '${activeId}' does not exist`,
        remediation: 'set_active_colour_profile with an existing profile, or null',
      });
    if (active !== undefined) {
      const unmatched = evaluateProfile(doc, ctx, active, doc.order)
        .filter((row) => row.inScope && row.rule === null)
        .map((row) => row.id)
        .sort(compareText);
      if (unmatched.length > 0)
        issues.push({
          code: 'VIS_COLOUR_UNMATCHED',
          severity: 'warn',
          ids: unmatched,
          paths: [`display.colourProfiles.${active.id}`],
          message: `${unmatched.length} entit${unmatched.length === 1 ? 'y' : 'ies'} matched no rule of profile '${active.id}'`,
          remediation: 'extend the profile rules, or accept the default colour',
        });
      if (active.reviewRequired)
        issues.push({
          code: 'VIS_SCHEME_REVIEW_REQUIRED',
          severity: 'warn',
          ids: [],
          paths: [`display.colourProfiles.${active.id}`],
          message: `profile '${active.id}' is flagged reviewRequired and not approved`,
          remediation: 'a qualified reviewer approves the profile before the colours are used on a deliverable',
        });
    }
    const status = issues.some((issue) => issue.severity === 'error') ? 'fail' : issues.length > 0 ? 'warn' : 'pass';
    const counts = { profiles: Object.keys(display.colourProfiles).length, issues: issues.length };
    const codes = [...new Set(issues.map((issue) => issue.code))];
    return report(
      doc,
      `Display check ${status.toUpperCase()}: ${counts.profiles} profile(s), ${issues.length} issue(s)${codes.length > 0 ? ` (${codes.join(', ')})` : ''}.`,
      { status, issues, counts },
    );
  },
});
