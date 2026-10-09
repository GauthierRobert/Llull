/**
 * @layer server
 * License + administration endpoints (transport only, no business logic):
 *
 *   GET /license         public: { mode, customer, seats, expires, label, evaluation, warning? }
 *   GET /admin/license   admin: license status + seats used / users beyond the seat count
 *   GET /admin/users     admin: users (id, name, role, licensed) — never token hashes
 *   GET /admin/audit     admin: ?since=<ISO>&user=<id>&limit=<n, default 100, max 1000>
 */

import { Router, type RequestHandler } from 'express';
import { readAudit } from './audit';
import { getLicense, publicLicenseBody } from './license';
import { guardAdmin } from './security';
import { isUserMode, licensedUserIds, loadUsers } from './users';

const MAX_AUDIT_LIMIT = 1000;

export function buildAdminRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  const adminGuard = guardAdmin();

  router.get('/license', restLimiter, (_req, res) => {
    res.status(200).json(publicLicenseBody(getLicense()));
  });

  router.get('/admin/license', restLimiter, adminGuard, (_req, res) => {
    const license = getLicense();
    const users = loadUsers();
    const licensed = licensedUserIds(users, license.seats);
    res.status(200).json({
      ...license,
      namedUsers: users.length,
      seatsUsed: licensed.size,
      usersWithoutSeat: users.filter((user) => !licensed.has(user.id)).map((user) => user.id),
    });
  });

  router.get('/admin/users', restLimiter, adminGuard, (_req, res) => {
    const users = loadUsers();
    const licensed = licensedUserIds(users, getLicense().seats);
    res.status(200).json({
      userMode: isUserMode(),
      users: users.map(({ id, name, role }) => ({ id, name, role, licensed: licensed.has(id) })),
    });
  });

  router.get('/admin/audit', restLimiter, adminGuard, (req, res) => {
    const { since, user, limit } = req.query;
    if (typeof since === 'string' && Number.isNaN(Date.parse(since))) {
      res.status(400).json({ error: '"since" must be an ISO date-time.' });
      return;
    }
    const requested = typeof limit === 'string' ? Number.parseInt(limit, 10) : 100;
    const entries = readAudit({
      ...(typeof since === 'string' ? { since } : {}),
      ...(typeof user === 'string' && user !== '' ? { user } : {}),
      limit: Math.min(
        Number.isFinite(requested) && requested > 0 ? requested : 100,
        MAX_AUDIT_LIMIT,
      ),
    });
    res.status(200).json({ count: entries.length, entries });
  });

  return router;
}
