/**
 * Short-lived single-use tickets for `GET /live` (EventSource cannot send headers, and a bearer token in the URL leaks into
 * proxy/access logs and history). `POST /live/ticket` (header auth) mints one; `GET /live?ticket=` consumes it.
 * @invariant a ticket is valid once, for TICKET_TTL_MS.
 */
import crypto from 'crypto';

export const TICKET_TTL_MS = 30_000;
export const MAX_TICKETS = 1024;
/** Outstanding tickets per owner (client address): one caller cannot fill the shared store. */
export const MAX_TICKETS_PER_OWNER = 8;

interface TicketEntry {
  readonly expiresAt: number;
  readonly owner: string;
}

const tickets = new Map<string, TicketEntry>();

function sweepExpired(now: number): void {
  for (const [ticket, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(ticket);
}

function evictOldestOf(owner: string): void {
  const owned = [...tickets].filter(([, entry]) => entry.owner === owner);
  if (owned.length >= MAX_TICKETS_PER_OWNER && owned[0] !== undefined) tickets.delete(owned[0][0]);
}

/** New ticket for the client `clientKey`. An owner past MAX_TICKETS_PER_OWNER recycles its oldest ticket; null when the store is full. */
export function issueTicket(clientKey: string, now: number = Date.now()): string | null {
  sweepExpired(now);
  const owner = `client:${clientKey}`;
  evictOldestOf(owner);
  if (tickets.size >= MAX_TICKETS) return null;
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(ticket, { expiresAt: now + TICKET_TTL_MS, owner });
  return ticket;
}

/** Redeems (and deletes) `ticket`: true when it was valid and fresh. */
export function consumeTicket(ticket: string, now: number = Date.now()): boolean {
  const entry = tickets.get(ticket);
  if (entry === undefined) return false;
  tickets.delete(ticket);
  return entry.expiresAt > now;
}

/** Test hook. */
export function _resetTickets(): void {
  tickets.clear();
}
