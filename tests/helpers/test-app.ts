import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { createApp, type CreateAppOptions } from '../../src/server/app.js';
import type { Clock } from '../../src/server/clock.js';
import { parseConfig, type AppConfig } from '../../src/server/config.js';
import { createDatabase, type DatabaseContext } from '../../src/server/db/index.js';
import { FakeSyncProviders } from './fake-providers.js';

export const TEST_USERNAME = 'admin';
export const TEST_PASSWORD = 'correct-horse-battery-staple';
export const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);
export const TEST_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
export const TEST_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
export const TEST_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);

export class FakeClock implements Clock {
  private currentMs: number;

  constructor(initialMs = Date.UTC(2026, 0, 15, 12, 0, 0)) {
    this.currentMs = initialMs;
  }

  now(): number {
    return this.currentMs;
  }

  set(ms: number): void {
    this.currentMs = ms;
  }

  advanceMs(ms: number): void {
    this.currentMs += ms;
  }

  advanceSeconds(seconds: number): void {
    this.advanceMs(seconds * 1000);
  }

  advanceMinutes(minutes: number): void {
    this.advanceSeconds(minutes * 60);
  }

  advanceDays(days: number): void {
    this.advanceSeconds(days * 24 * 60 * 60);
  }
}

export interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly config: AppConfig;
  readonly dbContext: DatabaseContext;
  readonly clock: FakeClock;
  readonly providers: FakeSyncProviders;
  /** Logs in as the admin and returns a `cookie` header value for authenticated requests. */
  signIn(): Promise<string>;
  generateTotp(stepOffset?: number): string;
  close(): void;
}

export function createTestContext(options?: {
  envOverrides?: Record<string, string | undefined>;
  initialTimeMs?: number;
  staticDir?: string;
}): TestContext {
  const config = parseConfig({
    USER_NAME: TEST_USERNAME,
    USER_PASSWORD_HASH: TEST_PASSWORD_HASH,
    TOTP_SECRET: TEST_TOTP_SECRET,
    SESSION_SECRET: TEST_SESSION_SECRET,
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    NODE_ENV: 'test',
    ...options?.envOverrides,
  });

  const clock = new FakeClock(options?.initialTimeMs);
  const dbContext = createDatabase(':memory:');
  const providers = new FakeSyncProviders();
  const appOptions: CreateAppOptions = {
    config,
    dbContext,
    clock,
    createSyncProviders: providers.factory,
    staticDir: options?.staticDir,
  };
  const app = createApp(appOptions);

  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(config.totpSecret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });

  return {
    app,
    config,
    dbContext,
    clock,
    providers,
    async signIn() {
      const response = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: TEST_USERNAME,
          password: TEST_PASSWORD,
          totpCode: this.generateTotp(0),
        }),
      });
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      if (response.status !== 200 || !cookie) {
        throw new Error(`Test sign-in failed (${response.status})`);
      }
      // Advance one TOTP step so a later signIn() in the same test is not a replay
      this.clock.advanceSeconds(30);
      return cookie;
    },
    generateTotp(stepOffset = 0): string {
      return totp.generate({ timestamp: clock.now() + stepOffset * 30_000 });
    },
    close() {
      dbContext.close();
    },
  };
}
