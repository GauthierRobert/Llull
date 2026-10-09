#!/usr/bin/env node
/**
 * Add a named user to the llull users file and print a fresh token ONCE (only its SHA-256 is stored).
 *
 *   node server/scripts/add-user.mjs <id> <name> <viewer|editor|admin> [--file users.json]
 *
 * File: --file, else $LLULL_USERS_FILE, else ./users.json.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const args = process.argv.slice(2);
const fileFlag = args.indexOf('--file');
let file = process.env.LLULL_USERS_FILE || 'users.json';
if (fileFlag !== -1) {
  file = args[fileFlag + 1] ?? '';
  args.splice(fileFlag, 2);
}
const [id, name, role] = args;

if (!id || !name || !['viewer', 'editor', 'admin'].includes(role ?? '') || file === '') {
  console.error('usage: add-user.mjs <id> <name> <viewer|editor|admin> [--file users.json]');
  process.exit(2);
}

let users = [];
if (fs.existsSync(file)) {
  users = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(users)) {
    console.error(`${file} is not a JSON array`);
    process.exit(1);
  }
}
if (users.some((user) => user.id === id)) {
  console.error(`user "${id}" already exists in ${file}`);
  process.exit(1);
}

const token = `llull_${crypto.randomBytes(32).toString('base64url')}`;
const tokenSha256 = crypto.createHash('sha256').update(token).digest('hex');
users.push({ id, name, role, tokenSha256 });
fs.writeFileSync(file, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 });

process.stdout.write(`Added ${role} "${name}" (${id}) to ${file}.\n`);
process.stdout.write('Token (shown once, store it safely):\n');
process.stdout.write(`${token}\n`);
