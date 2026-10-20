import type { HumanSignaturePort } from '../model/analysis';

let installed: HumanSignaturePort | null = null;

/** Install (or with null, remove) the process signature port (`ctx.humanSignature` of the default context). Composition roots and tests only. */
export function setSignaturePort(port: HumanSignaturePort | null): void {
  installed = port;
}

/** The installed signature port, or null: human-gated acts then refuse (hosts that build their own context pass theirs). */
export function getSignaturePort(): HumanSignaturePort | null {
  return installed;
}
