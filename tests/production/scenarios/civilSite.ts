import type { Scenario } from '../contract';
import { civilBrief } from '../civil/brief';
import { civilSiteIntent } from '../civil/intent';
import { civilScript } from '../civil/script';
import { civilSiteCriteria } from '../criteria/civilSite';
import { integrityCriteria } from '../criteria/integrity';

/**
 * @layer tests/production/scenarios
 *
 * Civil-office job: from the surveyor's topographic survey to a balanced building pad, an access
 * road with clothoids and superelevation, a sized storm network with its HGL check, and the
 * plan-profile sheet + LandXML issued to the contractor.
 */
export const civilSite: Scenario = {
  id: 'civil-site-development',
  title: 'Site development — survey, balanced pad, access road, storm drainage, LandXML',
  client: 'Civil engineering office (pilot)',
  brief: civilBrief(civilSiteIntent),
  script: civilScript(civilSiteIntent),
  criteria: [...civilSiteCriteria(civilSiteIntent), ...integrityCriteria()],
  knownIssues: { scripted: [], ui: [] },
  agentBaseline: 0.6,
};
