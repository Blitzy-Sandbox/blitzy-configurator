/**
 * Liveness and readiness probe endpoints.
 *
 * Per ST-048-AC3: GET /healthz returns 200 with `{"status":"ok"}`
 * whenever the process is running. The probe never exercises any
 * external dependency — it only confirms that the Express loop is
 * alive. (Cloud Run's liveness probe will restart the container if
 * this endpoint stops responding.)
 *
 * Per ST-048-AC4: GET /readyz returns 200 with `{"status":"ready"}`
 * when the database is reachable, and 503 with
 * `{"status":"unready", ...}` when it is not. The readiness probe
 * gates traffic admission — Cloud Run withholds new traffic from a
 * replica that returns 503 here.
 *
 * The DB-reachability check is delegated to a caller-supplied
 * function (`checkDb`) so this module stays decoupled from the
 * database client. At Phase A there is no real DB pool yet; the
 * caller passes a no-op probe that always resolves true. When
 * Track 1 wires in pg.Pool, the caller will pass a real probe.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';

/**
 * Caller-supplied predicate that resolves true when the database is
 * reachable, false otherwise. Implementations should use a short
 * timeout (≤1s) so the readiness probe responds within Cloud Run's
 * default 4-second timeout.
 */
export type DbReadinessProbe = () => Promise<boolean>;

export interface HealthRoutesOptions {
  /**
   * Probe used by /readyz to decide between 200 and 503. Required.
   */
  checkDb: DbReadinessProbe;
}

/**
 * Builds the health-check router.
 *
 * @param options.checkDb async predicate returning true if DB is up
 * @returns an Express Router with /healthz and /readyz mounted at
 *   the router root (caller decides the mount path)
 */
export function createHealthRouter(options: HealthRoutesOptions): Router {
  const router = Router();

  // GET /healthz — liveness. Never queries the DB.
  router.get('/healthz', (_req: Request, res: Response): void => {
    res.status(200).json({ status: 'ok' });
  });

  // GET /readyz — readiness. Queries the DB via the supplied probe.
  // Wraps the probe in a try/catch so a thrown probe (e.g. pool not
  // initialised) becomes a 503, never a 500. Per Rule R8, this is
  // fail-closed: any indication of trouble produces 503.
  router.get('/readyz', (_req: Request, res: Response): void => {
    options
      .checkDb()
      .then((ready) => {
        if (ready) {
          res.status(200).json({ status: 'ready' });
        } else {
          res.status(503).json({ status: 'unready', reason: 'database unreachable' });
        }
      })
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : 'database probe threw';
        res.status(503).json({ status: 'unready', reason });
      });
  });

  return router;
}
