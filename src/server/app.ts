import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { RealtimeOrchestrator } from './realtime/orchestrator.js';
import { ProfileLocks } from './sync/profile-locks.js';
import { UsedOAuthStates } from './auth/oauth-state.js';
import { decideAccess } from './auth/access.js';
import { SESSION_COOKIE_NAME, unsealSession, type SessionPayload } from './auth/session.js';
import { systemClock, type Clock } from './clock.js';
import type { AppConfig } from './config.js';
import { encryptSecret } from './crypto/secrets.js';
import type { DatabaseContext } from './db/index.js';
import { findProfile, updateProfile } from './profiles/profile-store.js';
import { createAuthRoutes } from './routes/auth.js';
import { createRealSyncProviders } from './providers/real.js';
import type { SyncProvidersFactory } from './providers/types.js';
import { createDeleteApprovalRoutes } from './routes/delete-approvals.js';
import { createGoogleOAuthRoutes } from './routes/google-oauth.js';
import { createGoogleWebhookRoutes } from './routes/google-webhook.js';
import { createHealthRoutes } from './routes/health.js';
import { createLogRoutes } from './routes/logs.js';
import { createOverviewRoutes } from './routes/overview.js';
import { createProfileRoutes } from './routes/profiles.js';
import { createTriggerSyncRoutes } from './routes/trigger-sync.js';

export interface AppVariables {
  session: SessionPayload | null;
}

export interface CreateAppOptions {
  readonly config: AppConfig;
  readonly dbContext: DatabaseContext;
  readonly clock?: Clock;
  readonly createSyncProviders?: SyncProvidersFactory;
  readonly staticDir?: string;
}

export interface CloudSyncApp {
  readonly app: Hono<{ Variables: AppVariables }>;
  /** The background triggers (IDLE, polling, webhooks); the server starts it, tests drive it by hand. */
  readonly realtime: RealtimeOrchestrator;
}

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'no-referrer'],
  [
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  ],
];

export function createApp(options: CreateAppOptions): CloudSyncApp {
  const { config, dbContext, staticDir } = options;
  const clock = options.clock ?? systemClock;
  const locks = new ProfileLocks();
  const createSyncProviders =
    options.createSyncProviders ??
    createRealSyncProviders({
      googleClientId: config.googleClientId,
      googleClientSecret: config.googleClientSecret,
      onGoogleTokensRefreshed: (profileId, tokens) => {
        try {
          const current = findProfile(dbContext.db, profileId);
          if (current && current.googleTokensEnc !== null) {
            updateProfile(dbContext.db, profileId, {
              googleTokensEnc: encryptSecret(JSON.stringify(tokens), config.encryptionKey),
            });
          }
        } catch (error) {
          console.error(`Persisting refreshed Google tokens for Profile ${profileId} failed:`, error);
        }
      },
    });
  const realtime = new RealtimeOrchestrator({ config, db: dbContext.db, clock, locks, createSyncProviders });
  const app = new Hono<{ Variables: AppVariables }>();

  // Apply baseline HTTP security headers to every response (UI, API, redirects, errors)
  app.use('*', async (c, next) => {
    for (const [name, value] of SECURITY_HEADERS) {
      c.header(name, value);
    }
    await next();
  });

  // Access-decision middleware enforces public vs self-authenticated vs session-protected routes
  app.use('*', async (c, next) => {
    const rawCookie = getCookie(c, SESSION_COOKIE_NAME);
    const session = unsealSession(rawCookie, config.sessionSecret, config.userName, clock);
    c.set('session', session);

    const url = new URL(c.req.url);
    const decision = decideAccess({
      pathname: url.pathname,
      search: url.search,
      isAuthenticated: session !== null,
    });

    if (decision.action === 'unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (decision.action === 'redirect') {
      return c.redirect(decision.location, 302);
    }

    await next();
  });

  app.route('/api/health', createHealthRoutes(dbContext.sqlite));
  app.route(
    '/api/profiles',
    createProfileRoutes({ config, db: dbContext.db, clock, locks, createSyncProviders, realtime }),
  );
  app.route('/webhooks/google', createGoogleWebhookRoutes({ config, db: dbContext.db, clock, realtime }));
  app.route('/api', createOverviewRoutes({ db: dbContext.db, realtime, clock }));
  app.route('/api/logs', createLogRoutes({ db: dbContext.db }));
  app.route('/api/trigger-sync', createTriggerSyncRoutes({ config, db: dbContext.db, realtime }));
  app.route(
    '/api/delete-approvals',
    createDeleteApprovalRoutes({ config, db: dbContext.db, clock, locks, createSyncProviders }),
  );
  app.route(
    '/api/auth/google',
    createGoogleOAuthRoutes({
      config,
      db: dbContext.db,
      clock,
      usedStates: new UsedOAuthStates(clock),
      createSyncProviders,
    }),
  );
  app.route(
    '/api/auth',
    createAuthRoutes({
      config,
      db: dbContext.db,
      clock,
    }),
  );

  if (staticDir && fs.existsSync(staticDir)) {
    const relativeRoot = path.relative(process.cwd(), staticDir) || '.';
    app.use('/assets/*', serveStatic({ root: relativeRoot }));
    app.use('/favicon.ico', serveStatic({ root: relativeRoot }));
    app.use('/favicon.svg', serveStatic({ root: relativeRoot }));
    app.use('/robots.txt', serveStatic({ root: relativeRoot }));

    const indexPath = path.join(staticDir, 'index.html');
    app.get('*', (c) => {
      const url = new URL(c.req.url);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhooks/')) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, 'utf8');
        return c.html(html);
      }
      return c.text('Not found', 404);
    });
  }

  return { app, realtime };
}
