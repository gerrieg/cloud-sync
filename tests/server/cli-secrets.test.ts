import * as OTPAuth from 'otpauth';
import { describe, expect, it } from 'vitest';
import { verifyAdminCredentials } from '../../src/server/auth/password.js';
import { verifyAndClaimTotp } from '../../src/server/auth/totp.js';
import {
  generateAppSecrets,
  generatePasswordHash,
  generateTotpSetup,
} from '../../src/server/cli/secrets.js';
import { parseConfig } from '../../src/server/config.js';
import { createDatabase } from '../../src/server/db/index.js';
import { FakeClock, TEST_ENCRYPTION_KEY, TEST_SESSION_SECRET } from '../helpers/test-app.js';

describe('CLI secret helpers', () => {
  describe('generatePasswordHash', () => {
    it('produces a bcrypt hash that the login accepts for that password only', async () => {
      const hash = await generatePasswordHash('correct-horse-battery-staple');

      await expect(
        verifyAdminCredentials({
          username: 'admin',
          password: 'correct-horse-battery-staple',
          expectedUsername: 'admin',
          expectedPasswordHash: hash,
        }),
      ).resolves.toBe(true);
      await expect(
        verifyAdminCredentials({
          username: 'admin',
          password: 'wrong',
          expectedUsername: 'admin',
          expectedPasswordHash: hash,
        }),
      ).resolves.toBe(false);
    });

    it('is accepted by the config as USER_PASSWORD_HASH', async () => {
      const hash = await generatePasswordHash('s3cret-pass');
      const config = parseConfig({ ...validEnv(), USER_PASSWORD_HASH: hash });
      expect(config.userPasswordHash).toBe(hash);
    });

    it('rejects an empty password', async () => {
      await expect(generatePasswordHash('')).rejects.toThrow(/empty/i);
    });
  });

  describe('generateTotpSetup', () => {
    it('produces a secret the config accepts and an otpauth URI for the same secret', () => {
      const setup = generateTotpSetup({ accountName: 'admin' });

      const config = parseConfig({ ...validEnv(), TOTP_SECRET: setup.secret });
      expect(config.totpSecret).toBe(setup.secret);

      const parsed = OTPAuth.URI.parse(setup.uri);
      expect(parsed).toBeInstanceOf(OTPAuth.TOTP);
      const totp = parsed as OTPAuth.TOTP;
      expect(totp.secret.base32).toBe(setup.secret);
      expect(totp.label).toBe('admin');
      expect(totp.issuer).toBe('Cloud Sync');
      expect(totp.digits).toBe(6);
      expect(totp.period).toBe(30);
      expect(totp.algorithm).toBe('SHA1');
    });

    it('produces codes (from the URI) that the login verifies', () => {
      const clock = new FakeClock();
      const { secret, uri } = generateTotpSetup({ accountName: 'admin' });
      const authenticatorCode = (OTPAuth.URI.parse(uri) as OTPAuth.TOTP).generate({
        timestamp: clock.now(),
      });

      const dbContext = createDatabase(':memory:');
      try {
        const result = verifyAndClaimTotp({
          db: dbContext.db,
          totpSecret: secret,
          totpCode: authenticatorCode,
          clock,
        });
        expect(result.ok).toBe(true);
      } finally {
        dbContext.close();
      }
    });

    it('draws a fresh secret every time', () => {
      expect(generateTotpSetup({ accountName: 'a' }).secret).not.toBe(
        generateTotpSetup({ accountName: 'a' }).secret,
      );
    });

    it('renders a scannable QR code for the URI', async () => {
      const setup = generateTotpSetup({ accountName: 'admin' });
      const qr = await setup.renderQr();
      expect(qr.split('\n').length).toBeGreaterThan(10);
    });
  });

  describe('generateAppSecrets', () => {
    it('produces a SESSION_SECRET and ENCRYPTION_KEY the config accepts', () => {
      const secrets = generateAppSecrets();
      const config = parseConfig({
        ...validEnv(),
        SESSION_SECRET: secrets.sessionSecret,
        ENCRYPTION_KEY: secrets.encryptionKey,
      });
      expect(config.sessionSecret).toBe(secrets.sessionSecret);
      expect(config.encryptionKey).toHaveLength(32);
    });

    it('draws fresh values every time', () => {
      const a = generateAppSecrets();
      const b = generateAppSecrets();
      expect(a.sessionSecret).not.toBe(b.sessionSecret);
      expect(a.encryptionKey).not.toBe(b.encryptionKey);
    });
  });
});

function validEnv(): Record<string, string> {
  return {
    USER_NAME: 'admin',
    USER_PASSWORD_HASH: '$2b$04$' + 'a'.repeat(53),
    TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
    SESSION_SECRET: TEST_SESSION_SECRET,
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
  };
}
