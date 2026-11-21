import type { AppleConnectionReport } from '../../shared/profile.js';

export interface AppleCredentials {
  readonly appleId: string;
  readonly appPassword: string;
}

export interface GoogleTokens {
  readonly refresh_token: string;
  readonly access_token?: string;
  readonly expiry_date?: number;
  readonly scope?: string;
}

export const GOOGLE_INVALID_GRANT = 'invalid_grant';

export class GoogleAuthError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'GoogleAuthError';
    this.code = code;
  }
}

/**
 * The single external I/O boundary, instantiated per Profile.
 * Production wires tsdav / imapflow / googleapis adapters; tests inject stateful fakes.
 */
export interface SyncProviders {
  readonly apple: {
    /** Checks CalDAV, CardDAV and IMAP simultaneously; never throws for per-protocol failures. */
    testConnection(): Promise<AppleConnectionReport>;
  };
  readonly google: {
    buildAuthUrl(input: { readonly redirectUri: string; readonly state: string }): string;
    /** Throws GoogleAuthError (e.g. `invalid_grant`) when Google rejects the code. */
    exchangeCode(input: {
      readonly code: string;
      readonly redirectUri: string;
    }): Promise<GoogleTokens>;
  };
}

export interface SyncProvidersContext {
  readonly profileId: string;
  readonly apple: AppleCredentials | null;
  readonly googleTokens: GoogleTokens | null;
}

export type SyncProvidersFactory = (context: SyncProvidersContext) => SyncProviders;
