import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../../src/server/config.js';

const VALID_BCRYPT_HASH = bcrypt.hashSync('super-secret-password', 4);
const VALID_TOTP_SECRET = 'JBSWY3DPEHPK3PXP'; // standard RFC 4648 base32 test secret
const VALID_SESSION_SECRET = 'a'.repeat(32);
const VALID_ENCRYPTION_KEY_HEX = '0123456789abcdef'.repeat(4); // 64 hex chars = 32 bytes

function makeValidEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    USER_NAME: 'admin',
    USER_PASSWORD_HASH: VALID_BCRYPT_HASH,
    TOTP_SECRET: VALID_TOTP_SECRET,
    SESSION_SECRET: VALID_SESSION_SECRET,
    ENCRYPTION_KEY: VALID_ENCRYPTION_KEY_HEX,
    GOOGLE_CLIENT_ID: 'google-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    ...overrides,
  };
}

describe('parseConfig', () => {
  it('parses a valid environment with defaults', () => {
    const config = parseConfig(makeValidEnv());

    expect(config.userName).toBe('admin');
    expect(config.userPasswordHash).toBe(VALID_BCRYPT_HASH);
    expect(config.totpSecret).toBe(VALID_TOTP_SECRET);
    expect(config.sessionSecret).toBe(VALID_SESSION_SECRET);
    expect(config.encryptionKey).toBeInstanceOf(Buffer);
    expect(config.encryptionKey.length).toBe(32);
    expect(config.googleClientId).toBe('google-client-id.apps.googleusercontent.com');
    expect(config.googleClientSecret).toBe('google-client-secret');
    expect(config.port).toBe(3000);
    expect(config.databasePath).toBe('./data/cloud-sync.db');
    expect(config.nodeEnv).toBe('development');
  });

  it('accepts a 32-byte base64 ENCRYPTION_KEY', () => {
    const base64Key = Buffer.alloc(32, 0x42).toString('base64');
    const config = parseConfig(makeValidEnv({ ENCRYPTION_KEY: base64Key }));

    expect(config.encryptionKey.length).toBe(32);
    expect(config.encryptionKey.equals(Buffer.alloc(32, 0x42))).toBe(true);
  });

  it.each([
    'USER_NAME',
    'USER_PASSWORD_HASH',
    'SESSION_SECRET',
    'ENCRYPTION_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
  ])('fails fast with a clear error when %s is missing', (missingVar) => {
    const env = makeValidEnv({ [missingVar]: undefined });

    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow(new RegExp(missingVar));
  });

  it('fails fast when SESSION_SECRET is shorter than 32 characters', () => {
    const env = makeValidEnv({ SESSION_SECRET: 'too-short-secret' });

    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow(/SESSION_SECRET/);
  });

  it('fails fast when USER_PASSWORD_HASH is not a valid bcrypt hash', () => {
    const env = makeValidEnv({ USER_PASSWORD_HASH: 'plaintext-password' });

    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow(/USER_PASSWORD_HASH/);
  });

  it('fails fast when TOTP_SECRET is not valid base32', () => {
    const env = makeValidEnv({ TOTP_SECRET: 'not-valid-base32!@#$' });

    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow(/TOTP_SECRET/);
  });

  it.each([undefined, '', '   '])('runs without a second factor when TOTP_SECRET is %j', (value) => {
    const config = parseConfig(makeValidEnv({ TOTP_SECRET: value }));

    expect(config.totpSecret).toBeNull();
  });

  it('fails fast when ENCRYPTION_KEY does not decode to 32 bytes', () => {
    const env = makeValidEnv({ ENCRYPTION_KEY: 'deadbeef' });

    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow(/ENCRYPTION_KEY/);
  });

  it('validates optional PORT, DATABASE_PATH, and NODE_ENV when provided', () => {
    const valid = parseConfig(
      makeValidEnv({
        PORT: '8080',
        DATABASE_PATH: '/var/lib/cloud-sync/app.db',
        NODE_ENV: 'production',
      }),
    );

    expect(valid.port).toBe(8080);
    expect(valid.databasePath).toBe('/var/lib/cloud-sync/app.db');
    expect(valid.nodeEnv).toBe('production');

    expect(() => parseConfig(makeValidEnv({ PORT: 'not-a-port' }))).toThrow(/PORT/);
    expect(() => parseConfig(makeValidEnv({ NODE_ENV: 'staging' }))).toThrow(/NODE_ENV/);
  });

  it('reports all invalid variables together in one clear error message', () => {
    expect(() => parseConfig({})).toThrow(/USER_NAME.*USER_PASSWORD_HASH.*SESSION_SECRET.*ENCRYPTION_KEY.*GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET/s);
  });
});
