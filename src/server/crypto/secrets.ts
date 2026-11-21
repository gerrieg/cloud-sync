import crypto from 'node:crypto';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const VERSION_PREFIX = 'v1';

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${VERSION_PREFIX}.${Buffer.concat([iv, authTag, ciphertext]).toString('base64url')}`;
}

export function decryptSecret(token: string, key: Buffer): string {
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0] !== VERSION_PREFIX || !parts[1]) {
    throw new Error('Malformed encrypted secret');
  }

  const raw = Buffer.from(parts[1], 'base64url');
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Malformed encrypted secret');
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
