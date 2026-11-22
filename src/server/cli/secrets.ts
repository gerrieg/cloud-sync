import crypto from 'node:crypto';
import bcryptjs from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';

const BCRYPT_COST = 12;
const TOTP_ISSUER = 'Cloud Sync';
const TOTP_SECRET_BYTES = 20;

export async function generatePasswordHash(password: string): Promise<string> {
  if (password.length === 0) {
    throw new Error('The password must not be empty');
  }
  return bcryptjs.hash(password, BCRYPT_COST);
}

export interface TotpSetup {
  /** Base32 secret for `TOTP_SECRET`. */
  readonly secret: string;
  /** `otpauth://` URI for authenticator apps. */
  readonly uri: string;
  /** The URI as a QR code made of terminal characters. */
  renderQr(): Promise<string>;
}

export function generateTotpSetup(params: { accountName: string }): TotpSetup {
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: params.accountName,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: TOTP_SECRET_BYTES }),
  });
  const uri = totp.toString();
  return {
    secret: totp.secret.base32,
    uri,
    renderQr: () => QRCode.toString(uri, { type: 'terminal', small: true }),
  };
}

export interface AppSecrets {
  readonly sessionSecret: string;
  readonly encryptionKey: string;
}

export function generateAppSecrets(): AppSecrets {
  return {
    sessionSecret: crypto.randomBytes(48).toString('base64url'),
    encryptionKey: crypto.randomBytes(32).toString('hex'),
  };
}
