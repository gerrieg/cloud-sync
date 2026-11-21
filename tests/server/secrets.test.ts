import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../../src/server/crypto/secrets.js';

const KEY = Buffer.from('0123456789abcdef'.repeat(4), 'hex');
const OTHER_KEY = Buffer.from('fedcba9876543210'.repeat(4), 'hex');

describe('AES-256-GCM secret encryption', () => {
  it('round-trips a secret and never exposes the plaintext in the ciphertext', () => {
    const encrypted = encryptSecret('abcd-efgh-ijkl-mnop', KEY);

    expect(encrypted).not.toContain('abcd-efgh-ijkl-mnop');
    expect(decryptSecret(encrypted, KEY)).toBe('abcd-efgh-ijkl-mnop');
  });

  it('uses a fresh random IV so identical plaintexts encrypt differently', () => {
    expect(encryptSecret('same', KEY)).not.toBe(encryptSecret('same', KEY));
  });

  it('rejects a wrong key, tampered ciphertext, and malformed input', () => {
    const encrypted = encryptSecret('secret', KEY);

    expect(() => decryptSecret(encrypted, OTHER_KEY)).toThrow();
    expect(() => decryptSecret(`${encrypted.slice(0, -4)}AAAA`, KEY)).toThrow();
    expect(() => decryptSecret('not-a-token', KEY)).toThrow();
  });
});
