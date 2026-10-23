/** The `plant.spec` slice of the document (01 PSC M2): validation on load. */

import { isRecord } from '@lib/isRecord';
import { COMPONENT_TYPES } from '../catalog/types';
import { SPEC_STATUSES } from './types';

const isSize = (value: unknown): boolean =>
  isRecord(value) && (value['system'] === 'NPS' || value['system'] === 'DN') && typeof value['key'] === 'string';

function componentErrors(component: unknown, at: string): string[] {
  if (!isRecord(component)) return [`${at} must be a component object`];
  const bad: string[] = [];
  if (typeof component['id'] !== 'string') bad.push('id');
  if (!COMPONENT_TYPES.includes(component['type'] as (typeof COMPONENT_TYPES)[number])) bad.push('type');
  if (typeof component['catalogRef'] !== 'string') bad.push('catalogRef');
  if (!isSize(component['from']) || !isSize(component['to'])) bad.push('from / to sizes');
  return bad.length === 0 ? [] : [`${at} has an invalid ${bad.join(', ')}`];
}

function specErrors(id: string, revisions: unknown): string[] {
  const path = `plant.spec.specs.${id}`;
  if (!Array.isArray(revisions) || revisions.length === 0) return [`${path} must be a non-empty array of revisions`];
  return revisions.flatMap((spec: unknown, index) => {
    const at = `${path}.${index}`;
    if (!isRecord(spec) || spec['format'] !== 'llull-pipe-spec' || spec['id'] !== id)
      return [`${at} must be a llull-pipe-spec with id "${id}"`];
    const range = spec['sizeRange'];
    const errors: string[] = [];
    const revision = spec['revision'];
    const previous = (revisions[index - 1] as Record<string, unknown> | undefined)?.['revision'];
    if (!Number.isInteger(revision) || (revision as number) < 1 || (typeof previous === 'number' && (revision as number) <= previous))
      errors.push(`${at}.revision must be a positive integer, strictly ascending`);
    const approval = spec['approval'];
    if (
      spec['status'] !== 'draft' &&
      (!isRecord(approval) || ['signer', 'signatureId', 'at'].some((key) => typeof approval[key] !== 'string'))
    )
      errors.push(`${at}.approval { signer, signatureId, at } is required when the status is approved or superseded`);
    if (!SPEC_STATUSES.includes(spec['status'] as (typeof SPEC_STATUSES)[number]))
      errors.push(`${at}.status must be one of ${SPEC_STATUSES.join(', ')}`);
    if (!Array.isArray(spec['components']) || !Array.isArray(spec['catalogs']))
      errors.push(`${at} must have components and catalogs arrays`);
    if (Array.isArray(spec['components']))
      errors.push(...spec['components'].flatMap((c: unknown, k) => componentErrors(c, `${at}.components.${k}`)));
    if (!isRecord(range) || !isSize(range['from']) || !isSize(range['to']))
      errors.push(`${at}.sizeRange must be { from, to } nominal sizes`);
    return errors;
  });
}

/** Errors of a raw `plant.spec` value (empty when valid). */
export function pipeSpecErrors(raw: unknown): string[] {
  if (!isRecord(raw) || !isRecord(raw['specs']) || !Array.isArray(raw['specOrder'])) return ['plant.spec must be { specs, specOrder }'];
  const ids = Object.keys(raw['specs']);
  const order = raw['specOrder'] as unknown[];
  const orderErrors =
    order.length === ids.length && ids.every((id) => order.includes(id)) ? [] : ['plant.spec.specOrder must list every spec id once'];
  return [...orderErrors, ...ids.flatMap((id) => specErrors(id, (raw['specs'] as Record<string, unknown>)[id]))];
}
