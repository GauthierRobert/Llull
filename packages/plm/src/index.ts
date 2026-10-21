/** Public API of the PLM package: the plugin the composition root installs, and the manifest / package helpers hosts (server, desktop) use. */

// PLM plugin
export { plmPlugin } from './plugin';

// LOTAR archive validation
export { type ValidationProperties, compareValidation, documentOfSnapshot, validationPropertiesOf } from './lotar/validation';

// PDM manifest reader
export { readPdm } from './pdm/read';

// signature/seal records
export { isSealed } from './records';

// record types
export { type SignatureRecord } from './types';
