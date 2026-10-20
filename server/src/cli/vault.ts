/**
 * `llull vault ...`: the local vault of 09 PLM M3 (check-out / check-in with exclusive locks, content-addressed snapshots, refs, audit). One machine, no
 * network. The vault is a folder (`--vault DIR` or $LLULL_VAULT); documents are files (`--doc`). Every change to a document goes through a command
 * (`checkpoint_iteration`, `externalize_snapshots`) inside `checkIn`; the CLI only moves files and takes locks.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { writeDocumentFile } from '../documentFile';
import { vaultDirOf } from '../plm/vault/location';
import {
  type Vault,
  VaultError,
  checkIn,
  checkOut,
  currentHolder,
  breakItemLock,
  initVault,
  itemStatus,
  listItems,
  openVault,
  readRefs,
  renew,
  verifyVault,
} from '../plm/vault/vault';
import { writeFileAtomic } from '../writeFileAtomic';
import { type ParsedArgv, booleanFlag, cliTarget, stringFlag } from './argv';

export interface VaultCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const OK = 0;
const FAILED = 1;
const USAGE_ERROR = 2;

class VaultUsage extends Error {}

const print = (io: VaultCliIo, args: ParsedArgv, json: unknown, text: string): void =>
  io.stdout(booleanFlag(args, 'json') ? JSON.stringify(json) : text);

function dirOf(args: ParsedArgv, io: VaultCliIo): string {
  const dir = stringFlag(args, 'vault') ?? vaultDirOf({ ...process.env, ...io.env });
  if (dir === null || dir === '') throw new VaultUsage('no vault: pass --vault DIR or set $LLULL_VAULT.');
  return dir;
}

const itemArg = (args: ParsedArgv, action: string): string => {
  const item = args.positionals[2];
  if (item === undefined) throw new VaultUsage(`vault ${action} needs a part number: llull vault ${action} PN`);
  return item;
};

/** Lock holder of this invocation: the user, this host and `--session` (default `cli`, so one user's CLI runs share their locks). */
const holderOf = (args: ParsedArgv, io: VaultCliIo): ReturnType<typeof currentHolder> =>
  currentHolder({ ...process.env, ...io.env }, stringFlag(args, 'session') ?? 'cli');

function runCheckOut(vault: Vault, args: ParsedArgv, io: VaultCliIo, now: Date): number {
  const partNumber = itemArg(args, 'checkout');
  const file = cliTarget(args, io.env).doc;
  const occupied = existsSync(file) && statSync(file).size > 0;
  const known = readRefs(vault, partNumber)?.head != null;
  if (known && occupied && !booleanFlag(args, 'force'))
    throw new VaultUsage(`${file} already exists; check out into another --doc, or pass --force to replace it with the vault head.`);
  const out = checkOut(vault, partNumber, holderOf(args, io), now);
  if (out.document !== null) {
    writeFileAtomic(file, out.document);
    print(
      io,
      args,
      { partNumber, doc: file, lock: out.lock },
      `${partNumber} checked out into ${file} (lease until ${out.lock.leaseUntil}).`,
    );
  } else {
    print(
      io,
      args,
      { partNumber, doc: null, lock: out.lock },
      `${partNumber} is new to this vault: locked for you (lease until ${out.lock.leaseUntil}); build it, then: llull vault checkin --doc FILE.`,
    );
  }
  return OK;
}

function runCheckIn(vault: Vault, args: ParsedArgv, io: VaultCliIo, now: Date): number {
  const file = cliTarget(args, io.env).doc;
  if (!existsSync(file)) throw new VaultUsage(`no document at ${file}; pass --doc FILE.`);
  const result = checkIn(vault, deserializeDocument(readFileSync(file, 'utf8')), holderOf(args, io), now);
  writeDocumentFile(file, result.document);
  print(
    io,
    args,
    { revision: result.revision, iteration: result.iteration, head: result.head, notes: result.notes },
    `Checked in rev ${result.revision} iteration ${result.iteration}: head ${result.head.slice(0, 12)}…. ${result.notes.join(' ')} The lock is released; ${file} now holds vault references for frozen snapshots.`,
  );
  return OK;
}

function runStatus(vault: Vault, args: ParsedArgv, io: VaultCliIo, now: Date): number {
  const items = args.positionals[2] === undefined ? listItems(vault) : [args.positionals[2]];
  const rows = items.map((partNumber) => itemStatus(vault, partNumber, now, hostname()));
  print(
    io,
    args,
    rows,
    rows.length === 0
      ? 'The vault holds no items yet.'
      : rows
          .map((row) => {
            const frozen = Object.entries(row.refs?.revisions ?? {})
              .map(([label, ref]) => `${label}:${ref.state}`)
              .join(' ');
            const lock =
              row.lock === null
                ? 'free'
                : `locked by ${row.lock.holder.userId}@${row.lock.holder.host} until ${row.lock.leaseUntil}${row.lock.stale ? ' (STALE)' : ''}`;
            return `${row.partNumber}  ${lock}  frozen: ${frozen === '' ? 'none' : frozen}  head: ${row.refs?.head?.slice(0, 12) ?? 'none'}`;
          })
          .join('\n'),
  );
  return OK;
}

/** Run `llull vault <action>`; a refusal prints its stable code (PLM_VAULT_LOCKED names the holder) and returns 1, a usage mistake returns 2. */
export function runVault(args: ParsedArgv, io: VaultCliIo, now: () => Date = () => new Date()): number {
  try {
    const action = args.positionals[1];
    if (action === 'init') {
      const vault = initVault(dirOf(args, io));
      print(io, args, { vault: vault.dir }, `Vault ready at ${vault.dir}.`);
      return OK;
    }
    const vault = openVault(dirOf(args, io));
    switch (action) {
      case 'checkout':
        return runCheckOut(vault, args, io, now());
      case 'checkin':
        return runCheckIn(vault, args, io, now());
      case 'status':
        return runStatus(vault, args, io, now());
      case 'renew': {
        const lock = renew(vault, itemArg(args, 'renew'), holderOf(args, io), now());
        print(io, args, lock, `Lease renewed until ${lock.leaseUntil}.`);
        return OK;
      }
      case 'break-lock': {
        const broken = breakItemLock(vault, itemArg(args, 'break-lock'), holderOf(args, io), now());
        print(io, args, broken, `Lock of ${broken.holder.userId}@${broken.holder.host} broken (audited).`);
        return OK;
      }
      case 'verify': {
        const verdict = verifyVault(vault);
        print(
          io,
          args,
          verdict,
          verdict.ok
            ? `Vault intact: ${verdict.objects} object(s).`
            : verdict.findings.map((finding) => `PLM_INTEGRITY_MISMATCH: ${finding}`).join('\n'),
        );
        return verdict.ok ? OK : FAILED;
      }
      default:
        throw new VaultUsage(
          'vault needs an action: init | status [PN] | checkout PN | checkin | renew PN | break-lock PN | verify  (--vault DIR, --doc FILE)',
        );
    }
  } catch (error) {
    if (error instanceof VaultUsage) {
      io.stderr(`llull: ${error.message}`);
      return USAGE_ERROR;
    }
    if (error instanceof VaultError) {
      io.stderr(`${error.code}: ${error.message}`);
      return FAILED;
    }
    throw error;
  }
}
