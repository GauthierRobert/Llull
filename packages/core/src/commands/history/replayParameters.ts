/**
 * Parameter-read tracking for replay: a step's cached state depends on `doc.parameters` only when its `run` actually reads them
 * (`=expr` params are already resolved into the step key). `trackParameterReads` hands a step a document whose parameter table reports reads.
 * @invariant a step that never touches the table is parameter-independent: its cached state is served for any parameter table
 */

import type { CadDocument } from '../../model/types';
import { hashText } from '../../lib/hash';

type ParameterTable = CadDocument['parameters'];

const fingerprints = new WeakMap<ParameterTable, string>();

/** Content hash of a parameter table (memoized per table object). */
export function parametersFingerprint(parameters: ParameterTable): string {
  let fingerprint = fingerprints.get(parameters);
  if (fingerprint === undefined) {
    fingerprint = hashText(JSON.stringify(parameters));
    fingerprints.set(parameters, fingerprint);
  }
  return fingerprint;
}

export interface TrackedParameters {
  /** `doc` with a read-reporting parameter table. */
  readonly doc: CadDocument;
  /** True once the table was read, replaced or stashed in a top-level field of the result. */
  readonly wasRead: (result: CadDocument) => boolean;
  /** `doc`'s own table; a result carrying the tracked table is rewritten to carry it instead. */
  readonly restore: (result: CadDocument) => CadDocument;
}

export function trackParameterReads(doc: CadDocument): TrackedParameters {
  let read = false;
  const proxy = new Proxy(doc.parameters, {
    get: (target, key, receiver) => ((read = true), Reflect.get(target, key, receiver)),
    has: (target, key) => ((read = true), Reflect.has(target, key)),
    ownKeys: (target) => ((read = true), Reflect.ownKeys(target)),
    getOwnPropertyDescriptor: (target, key) => ((read = true), Reflect.getOwnPropertyDescriptor(target, key)),
    set: (target, key, value, receiver) => ((read = true), Reflect.set(target, key, value, receiver)),
    deleteProperty: (target, key) => ((read = true), Reflect.deleteProperty(target, key)),
    defineProperty: (target, key, descriptor) => ((read = true), Reflect.defineProperty(target, key, descriptor)),
  });
  const tracked: CadDocument = { ...doc, parameters: proxy };
  const stashed = (result: CadDocument): boolean =>
    Object.entries(result).some(([field, value]) => field !== 'parameters' && value === proxy);
  return {
    doc: tracked,
    wasRead: (result) => read || (result.parameters !== proxy && result.parameters !== doc.parameters) || stashed(result),
    restore: (result) => (result.parameters === proxy ? { ...result, parameters: doc.parameters } : result),
  };
}
