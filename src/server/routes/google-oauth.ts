import { Hono } from 'hono';
import type { AppVariables } from '../app.js';
import { verifyOAuthState, type UsedOAuthStates } from '../auth/oauth-state.js';
import type { Clock } from '../clock.js';
import type { AppConfig } from '../config.js';
import { encryptSecret } from '../crypto/secrets.js';
import type { AppDatabase } from '../db/index.js';
import { findProfile, toProvidersContext, updateProfile } from '../profiles/profile-store.js';
import { GOOGLE_INVALID_GRANT, GoogleAuthError, type SyncProvidersFactory } from '../providers/types.js';
import { resolveGoogleRedirectUri } from '../profiles/google-redirect.js';
import type { GoogleLinkOutcome } from '../../shared/profile.js';

export interface GoogleOAuthRouteDeps {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly clock: Clock;
  readonly usedStates: UsedOAuthStates;
  readonly createSyncProviders: SyncProvidersFactory;
}

function uiRedirect(profileId: string, outcome: GoogleLinkOutcome): string {
  return `/?profile=${encodeURIComponent(profileId)}&google=${outcome}`;
}

export function createGoogleOAuthRoutes(deps: GoogleOAuthRouteDeps): Hono<{ Variables: AppVariables }> {
  const { config, db, clock, usedStates, createSyncProviders } = deps;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get('/callback', async (c) => {
    const session = c.get('session');
    const verified = session
      ? verifyOAuthState(c.req.query('state'), {
          sessionIat: session.iat,
          sessionSecret: config.sessionSecret,
          clock,
        })
      : null;
    if (!verified || !usedStates.consume(verified.nonce, verified.exp)) {
      return c.json({ error: 'Invalid or expired OAuth state' }, 400);
    }

    const row = findProfile(db, verified.profileId);
    if (!row) {
      return c.json({ error: 'Profile not found' }, 404);
    }

    const code = c.req.query('code');
    if (c.req.query('error') || !code) {
      return c.redirect(uiRedirect(row.id, 'error'), 302);
    }

    const providers = createSyncProviders(toProvidersContext(row, config.encryptionKey));
    try {
      const tokens = await providers.google.exchangeCode({
        code,
        redirectUri: resolveGoogleRedirectUri(config, c.req.url),
      });
      updateProfile(db, row.id, {
        googleTokensEnc: encryptSecret(JSON.stringify(tokens), config.encryptionKey),
        googleReauthRequired: false,
      });
      return c.redirect(uiRedirect(row.id, 'connected'), 302);
    } catch (error) {
      if (error instanceof GoogleAuthError && error.code === GOOGLE_INVALID_GRANT) {
        updateProfile(db, row.id, { googleReauthRequired: true });
        return c.redirect(uiRedirect(row.id, 'invalid_grant'), 302);
      }
      return c.redirect(uiRedirect(row.id, 'error'), 302);
    }
  });

  return routes;
}
