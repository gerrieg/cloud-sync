import { apiRequest, profilePath } from './http.js';

/** The calls for the Sync Rules of one kind (calendars, contacts or mail) of a Profile. */
export interface RulesApi<Dto, Create, Update, Discovery> {
  discover(profileId: string): Promise<Discovery>;
  list(profileId: string): Promise<Dto[]>;
  create(profileId: string, rule: Create): Promise<Dto>;
  update(profileId: string, ruleId: string, patch: Update): Promise<Dto>;
  /** Keeps what the rule synced in Google unless `cleanupGoogle` is explicitly true. */
  remove(profileId: string, ruleId: string, cleanupGoogle: boolean): Promise<void>;
}

/** `kind` is the path segment of `/rules/<kind>`; `discoverPath` that of `/discover/<discoverPath>`. */
export function rulesApi<Dto, Create, Update, Discovery>(
  kind: 'calendars' | 'contacts' | 'mail',
  discoverPath: string,
): RulesApi<Dto, Create, Update, Discovery> {
  const rulesPath = (profileId: string) => `${profilePath(profileId)}/rules/${kind}`;
  return {
    discover: (profileId) => apiRequest(`${profilePath(profileId)}/discover/${discoverPath}`),
    list: (profileId) => apiRequest(rulesPath(profileId)),
    create: (profileId, rule) => apiRequest(rulesPath(profileId), { method: 'POST', body: rule }),
    update: (profileId, ruleId, patch) =>
      apiRequest(`${rulesPath(profileId)}/${encodeURIComponent(ruleId)}`, { method: 'PATCH', body: patch }),
    remove: (profileId, ruleId, cleanupGoogle) =>
      apiRequest(`${rulesPath(profileId)}/${encodeURIComponent(ruleId)}?cleanupGoogle=${cleanupGoogle}`, {
        method: 'DELETE',
      }),
  };
}
