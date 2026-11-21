import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { decideAccess } from './auth/access.js';
import { SESSION_COOKIE_NAME, unsealSession, type SessionPayload } from './auth/session.js';
import { systemClock, type Clock } from './clock.js';
import type { AppConfig } from './config.js';
import type { DatabaseContext } from './db/index.js';
import { createAuthRoutes } from './routes/auth.js';
import { createHealthRoutes } from './routes/health.js';

export interface AppVariables {
  session: SessionPayload | null;
}

export interface CreateAppOptions {
  readonly config: AppConfig;
  readonly dbContext: DatabaseContext;
  readonly clock?: Clock;
  readonly staticDir?: string;
}

export function createApp(options: CreateAppOptions): Hono<{ Variables: AppVariables }> {
  const { config, dbContext, staticDir } = options;
  const clock = options.clock ?? systemClock;
  const app = new Hono<{ Variables: AppVariables }>();

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

  return app;
}
