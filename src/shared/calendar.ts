/** Calendar-sync contracts shared by the server API and the React client. */

export interface AppleCalendarDto {
  readonly url: string;
  readonly name: string;
  readonly readOnly: boolean;
  readonly subscribed: boolean;
}

export interface GoogleCalendarDto {
  readonly id: string;
  readonly name: string;
  readonly primary: boolean;
  readonly writable: boolean;
}

/** Response of `GET /api/profiles/:id/discover/calendars`. */
export interface CalendarDiscovery {
  readonly apple: readonly AppleCalendarDto[];
  readonly google: readonly GoogleCalendarDto[];
}

export type SyncDirection = 'one_way' | 'bidirectional';

export interface CalendarRuleDto {
  readonly id: string;
  readonly appleCalendarUrl: string;
  readonly appleCalendarName: string;
  readonly appleReadOnly: boolean;
  readonly googleCalendarId: string;
  readonly googleCalendarName: string;
  readonly direction: SyncDirection;
  /** Days of history to sync; null means all history. */
  readonly syncWindowDays: number | null;
  readonly syncReminders: boolean;
  readonly enabled: boolean;
}

/** Body of `POST /api/profiles/:id/rules/calendars`. */
export interface CalendarRuleCreate {
  readonly appleCalendarUrl: string;
  readonly googleCalendarId: string;
  readonly direction?: SyncDirection;
  readonly syncWindowDays?: number | null;
  readonly syncReminders?: boolean;
  readonly enabled?: boolean;
}

/** Body of `PATCH /api/profiles/:id/rules/calendars/:ruleId`. */
export type CalendarRuleUpdate = Partial<Omit<CalendarRuleCreate, 'appleCalendarUrl' | 'googleCalendarId'>>;

export type PlannedActionType = 'create' | 'update' | 'delete' | 'skip';

export interface PlannedAction {
  readonly action: PlannedActionType;
  readonly ruleId: string;
  readonly uid: string;
  readonly summary: string;
  /** Why an event is skipped: `unchanged`, `outside_window`, `matched_existing`, `invalid_calendar_data`. */
  readonly reason?: string;
  /** The event was organized by someone other than the Profile's Apple ID. */
  readonly foreignInvitation?: boolean;
}

export interface RuleRunResult {
  readonly ruleId: string;
  /** `skipped` means the whole rule was not processed (see `reason`: `paused` or `unchanged`). */
  readonly status: 'ok' | 'skipped' | 'error';
  readonly reason?: string;
  readonly error?: string;
  readonly actions: readonly PlannedAction[];
}

/** Response of `POST /api/profiles/:id/sync` and `POST /api/profiles/:id/dry-run`. */
export interface SyncRunResult {
  readonly dryRun: boolean;
  readonly rules: readonly RuleRunResult[];
}
