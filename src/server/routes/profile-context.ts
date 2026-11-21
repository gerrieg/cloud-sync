import type { AppVariables } from '../app.js';
import type { ProfileRow } from '../profiles/profile-store.js';

/** Hono environment of every route below `/api/profiles/:id`, where the Profile is preloaded. */
export interface ProfileEnv {
  Variables: AppVariables & { profile: ProfileRow };
}
