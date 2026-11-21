import * as OTPAuth from 'otpauth';

export type NodeEnv = 'development' | 'production' | 'test';

export interface AppConfig {
  readonly userName: string;
  readonly userPasswordHash: string;
  readonly totpSecret: string;
  readonly sessionSecret: string;
  readonly encryptionKey: Buffer;
  readonly googleClientId: string;
  readonly googleClientSecret: string;
  readonly publicBaseUrl: string | null;
  readonly port: number;
  readonly databasePath: string;
  readonly nodeEnv: NodeEnv;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const HEX_32_BYTES_PATTERN = /^[0-9a-fA-F]{64}$/;
const BASE32_PATTERN = /^[A-Z2-7]+=*$/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+=*$/;
const MIN_SESSION_SECRET_LENGTH = 32;
const MIN_TOTP_SECRET_BYTES = 10;

function parseEncryptionKey(raw: string): Buffer | null {
  if (HEX_32_BYTES_PATTERN.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  if (BASE64_PATTERN.test(raw)) {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) {
      return decoded;
    }
  }
  return null;
}

function parseTotpSecret(raw: string): string | null {
  const normalized = raw.replace(/\s+/g, '').toUpperCase();
  if (!normalized || !BASE32_PATTERN.test(normalized)) {
    return null;
  }
  try {
    const secret = OTPAuth.Secret.fromBase32(normalized);
    if (secret.bytes.byteLength < MIN_TOTP_SECRET_BYTES) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const issues: string[] = [];

  const userName = env.USER_NAME?.trim() ?? '';
  if (!userName) {
    issues.push('USER_NAME is required and must be non-empty');
  }

  const userPasswordHash = env.USER_PASSWORD_HASH?.trim() ?? '';
  if (!userPasswordHash) {
    issues.push('USER_PASSWORD_HASH is required');
  } else if (!BCRYPT_HASH_PATTERN.test(userPasswordHash)) {
    issues.push('USER_PASSWORD_HASH must be a valid bcrypt hash ($2a$, $2b$, or $2y$)');
  }

  const rawTotpSecret = env.TOTP_SECRET?.trim() ?? '';
  let totpSecret = '';
  if (!rawTotpSecret) {
    issues.push('TOTP_SECRET is required');
  } else {
    const parsedTotp = parseTotpSecret(rawTotpSecret);
    if (!parsedTotp) {
      issues.push('TOTP_SECRET must be a valid base32 secret of at least 80 bits');
    } else {
      totpSecret = parsedTotp;
    }
  }

  const sessionSecret = env.SESSION_SECRET ?? '';
  if (!sessionSecret) {
    issues.push('SESSION_SECRET is required');
  } else if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    issues.push(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters long`);
  }

  const rawEncryptionKey = env.ENCRYPTION_KEY?.trim() ?? '';
  let encryptionKey: Buffer = Buffer.alloc(0);
  if (!rawEncryptionKey) {
    issues.push('ENCRYPTION_KEY is required');
  } else {
    const parsedKey = parseEncryptionKey(rawEncryptionKey);
    if (!parsedKey) {
      issues.push('ENCRYPTION_KEY must be a 32-byte key encoded as 64 hex characters or base64');
    } else {
      encryptionKey = parsedKey;
    }
  }

  const googleClientId = env.GOOGLE_CLIENT_ID?.trim() ?? '';
  if (!googleClientId) {
    issues.push('GOOGLE_CLIENT_ID is required and must be non-empty');
  }

  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
  if (!googleClientSecret) {
    issues.push('GOOGLE_CLIENT_SECRET is required and must be non-empty');
  }

  let publicBaseUrl: string | null = null;
  const rawPublicBaseUrl = env.PUBLIC_BASE_URL?.trim();
  if (rawPublicBaseUrl) {
    try {
      const parsed = new URL(rawPublicBaseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
      publicBaseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    } catch {
      issues.push('PUBLIC_BASE_URL must be an http(s) URL such as https://sync.example.com');
    }
  }

  let port = 3000;
  const rawPort = env.PORT?.trim();
  if (rawPort !== undefined && rawPort !== '') {
    const parsedPort = Number(rawPort);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      issues.push('PORT must be an integer between 1 and 65535');
    } else {
      port = parsedPort;
    }
  }

  const databasePath = env.DATABASE_PATH?.trim() || './data/cloud-sync.db';

  let nodeEnv: NodeEnv = 'development';
  const rawNodeEnv = env.NODE_ENV?.trim();
  if (rawNodeEnv) {
    if (rawNodeEnv === 'development' || rawNodeEnv === 'production' || rawNodeEnv === 'test') {
      nodeEnv = rawNodeEnv;
    } else {
      issues.push('NODE_ENV must be one of development, production, or test');
    }
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    userName,
    userPasswordHash,
    totpSecret,
    sessionSecret,
    encryptionKey,
    googleClientId,
    googleClientSecret,
    publicBaseUrl,
    port,
    databasePath,
    nodeEnv,
  };
}
