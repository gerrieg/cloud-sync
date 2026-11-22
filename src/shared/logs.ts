/** Sync-log contracts shared by the server API and the React client. */

export const LOG_ENTITY_TYPES = ['calendar', 'contact', 'email'] as const;
export type LogEntityType = (typeof LOG_ENTITY_TYPES)[number];

export const LOG_LEVELS = ['info', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** One line of the sync log: a change that was carried over (`info`) or an item that failed (`error`). */
export interface SyncLogDto {
  readonly id: string;
  readonly profileId: string;
  readonly profileName: string;
  /** The Sync Rule the item belongs to; null when it cannot be attributed to a single rule. */
  readonly ruleId: string | null;
  /** Display name of the rule, e.g. `Privat → Anna`; null without a rule (or once the rule was deleted). */
  readonly ruleName: string | null;
  readonly entityType: LogEntityType;
  readonly level: LogLevel;
  /** What was done or attempted: `create`, `update` or `delete`; null for errors of a whole rule or run. */
  readonly action: string | null;
  /** The event UID, contact UID or message key; null for errors of a whole rule or run. */
  readonly itemKey: string | null;
  /** Display name of the item (or of the rule for errors that concern all of it). */
  readonly summary: string;
  /** Why (info) or what went wrong (error); may be empty for info lines. */
  readonly message: string;
  /** When it happened; for a repeated error, the latest occurrence. */
  readonly createdAt: number;
  /** When a later run succeeded for the item; null while an error is still open. */
  readonly resolvedAt: number | null;
}

/** Query of `GET /api/logs`. */
export interface SyncLogQuery {
  readonly profileId?: string;
  readonly entityType?: LogEntityType;
  readonly level?: LogLevel;
  readonly unresolvedOnly?: boolean;
  /** At most this many entries, newest first (default 200, maximum 1000). */
  readonly limit?: number;
}
