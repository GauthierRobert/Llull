/** Absolute path of the system `tar` for `platform`; throws when none of the known locations holds one. */
export declare function systemTar(
  platform?: NodeJS.Platform,
  env?: Record<string, string | undefined>,
  exists?: (candidate: string) => boolean,
): string;
