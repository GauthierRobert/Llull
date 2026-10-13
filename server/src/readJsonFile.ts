/** @layer server — a JSON file read that treats "missing or corrupt" as "absent". */

import fs from 'fs';

/** The parsed JSON of `filePath`, or null when it is missing, unreadable or not JSON. */
export function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}
