import { afterEach, describe, expect, it } from 'vitest';
import { findProfile, updateProfile, type ProfileRow } from '../../src/server/profiles/profile-store.js';
import { GoogleAuthError } from '../../src/server/providers/types.js';
import { insertRule } from '../../src/server/sync/rules-store.js';
import { insertContactRule } from '../../src/server/sync/contact-rules-store.js';
import { insertMailRule } from '../../src/server/sync/mail-rules-store.js';
import { pollingTargetsOf } from '../../src/server/sync/polling-targets.js';
import { ProfileLocks } from '../../src/server/sync/profile-locks.js';
import { flagGoogleReauth, ProfileRunner } from '../../src/server/sync/profile-runner.js';
import { TestApi } from '../helpers/api.js';
import { createTestContext } from '../helpers/test-app.js';

describe('Profile runner and polling targets', () => {
  let api: TestApi | undefined;

  afterEach(() => {
    api?.ctx.close();
    api = undefined;
  });

  async function setup(options: { connected?: boolean } = {}) {
    const ctx = createTestContext();
    api = new TestApi(ctx, await ctx.signIn());
    const dto = await api.createProfile('Anna');
    if (options.connected ?? true) {
      await api.connectAccounts(dto);
    }
    const { db } = ctx.dbContext;
    const profile = (): ProfileRow => findProfile(db, dto.id)!;
    const runner = new ProfileRunner({
      config: ctx.config,
      db,
      locks: new ProfileLocks(),
      createSyncProviders: ctx.providers.factory,
    });
    return { ctx, db, profile, runner };
  }

  describe('ProfileRunner', () => {
    it('hands the work the providers, the Profile and the Apple ID of a connected Profile', async () => {
      const { profile, runner } = await setup();

      const outcome = await runner.run(profile(), async (providers, current, appleId) => ({
        hasProviders: providers.apple !== undefined && providers.google !== undefined,
        profileId: current.id,
        appleId,
      }));

      expect(outcome).toEqual({
        status: 'done',
        value: { hasProviders: true, profileId: profile().id, appleId: 'anna@icloud.com' },
      });
    });

    it('does not run the work when an account is not connected', async () => {
      const { profile, runner } = await setup({ connected: false });
      let ran = false;

      const outcome = await runner.run(profile(), async () => {
        ran = true;
      });

      expect(outcome).toEqual({ status: 'not_connected' });
      expect(ran).toBe(false);
    });

    it('flags the Profile for re-authentication when Google rejects the authorization', async () => {
      const { profile, runner } = await setup();

      const outcome = await runner.run(profile(), async () => {
        throw new GoogleAuthError('invalid_grant');
      });

      expect(outcome).toEqual({ status: 'reauth_required' });
      expect(profile().googleReauthRequired).toBe(true);
    });

    it.each([
      ['another Google auth error', new GoogleAuthError('access_denied')],
      ['any other error', new Error('boom')],
    ])('leaves %s to the caller and flags nothing', async (_name, error) => {
      const { profile, runner } = await setup();

      await expect(
        runner.run(profile(), async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      expect(profile().googleReauthRequired).toBe(false);
    });

    it('reads the Profile again once it is its turn under the lock', async () => {
      const { db, profile, runner } = await setup();
      const stale = profile();
      const seen: boolean[] = [];

      const first = runner.run(
        stale,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          updateProfile(db, stale.id, { googleReauthRequired: true });
        },
        { exclusive: true },
      );
      const second = runner.run(
        stale,
        async (_providers, current) => {
          seen.push(current.googleReauthRequired);
        },
        { exclusive: true },
      );
      await Promise.all([first, second]);

      expect(seen).toEqual([true]);
    });

    it('serializes exclusive work of one Profile, but not work that is not exclusive', async () => {
      const { runner, profile } = await setup();
      const events: string[] = [];
      const work = (name: string) => async () => {
        events.push(`${name} start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`${name} end`);
      };

      await Promise.all([
        runner.run(profile(), work('a'), { exclusive: true }),
        runner.run(profile(), work('b'), { exclusive: true }),
      ]);
      expect(events).toEqual(['a start', 'a end', 'b start', 'b end']);

      events.length = 0;
      await Promise.all([runner.run(profile(), work('c')), runner.run(profile(), work('d'))]);
      expect(events.slice(0, 2)).toEqual(['c start', 'd start']);
    });
  });

  describe('flagGoogleReauth', () => {
    it('flags only a dead Google authorization', async () => {
      const { db, profile } = await setup();

      expect(flagGoogleReauth(db, profile().id, new Error('invalid_grant'))).toBe(false);
      expect(flagGoogleReauth(db, profile().id, new GoogleAuthError('access_denied'))).toBe(false);
      expect(profile().googleReauthRequired).toBe(false);

      expect(flagGoogleReauth(db, profile().id, new GoogleAuthError('invalid_grant'))).toBe(true);
      expect(profile().googleReauthRequired).toBe(true);
    });
  });

  describe('pollingTargetsOf', () => {
    const calendarRule = (profileId: string, n: number, extra: Record<string, unknown> = {}) => ({
      profileId,
      appleCalendarUrl: `/cal/${n}/`,
      appleCalendarName: `Apple ${n}`,
      googleCalendarId: `g${n}`,
      googleCalendarName: `Google ${n}`,
      ...extra,
    });

    it('lists what the enabled rules of an active Profile make worth watching', async () => {
      const { db, profile } = await setup();
      const id = profile().id;
      insertRule(db, calendarRule(id, 1, { direction: 'bidirectional' }));
      insertRule(db, calendarRule(id, 2));
      insertRule(db, calendarRule(id, 3, { direction: 'bidirectional', enabled: false }));
      insertRule(db, calendarRule(id, 4, { direction: 'bidirectional', appleReadOnly: true }));
      insertMailRule(db, { profileId: id, appleFolderPath: 'INBOX', appleFolderName: 'INBOX', googleLabel: 'INBOX' });
      insertMailRule(db, { profileId: id, appleFolderPath: 'Archive', appleFolderName: 'Archive', googleLabel: 'Archive', enabled: false });
      insertContactRule(db, {
        profileId: id,
        appleGroupUid: 'all',
        appleGroupName: 'All',
        googleGroupResourceName: 'contactGroups/x',
        googleGroupName: 'X',
      });

      expect(pollingTargetsOf(db, profile())).toEqual({
        appleMailFolders: ['INBOX'],
        appleCalendarUrls: ['/cal/1/', '/cal/2/', '/cal/4/'],
        // A read-only Apple calendar can never receive Google changes, so Google is not watched for it
        watchedGoogleCalendarIds: ['g1'],
        hasContactRules: true,
      });
    });

    it('has no targets for a Profile with no enabled rules', async () => {
      const { db, profile } = await setup();

      expect(pollingTargetsOf(db, profile())).toEqual({
        appleMailFolders: [],
        appleCalendarUrls: [],
        watchedGoogleCalendarIds: [],
        hasContactRules: false,
      });
    });

    it.each([
      ['paused', (db: Parameters<typeof updateProfile>[0], id: string) => updateProfile(db, id, { enabled: false })],
      ['waiting for a re-authentication', (db: Parameters<typeof updateProfile>[0], id: string) => updateProfile(db, id, { googleReauthRequired: true })],
    ])('has no targets for a Profile that is %s', async (_name, change) => {
      const { db, profile } = await setup();
      const id = profile().id;
      insertRule(db, calendarRule(id, 1, { direction: 'bidirectional' }));
      insertMailRule(db, { profileId: id, appleFolderPath: 'INBOX', appleFolderName: 'INBOX', googleLabel: 'INBOX' });
      change(db, id);

      expect(pollingTargetsOf(db, profile())).toEqual({
        appleMailFolders: [],
        appleCalendarUrls: [],
        watchedGoogleCalendarIds: [],
        hasContactRules: false,
      });
    });

    it('has no targets for a Profile that is not connected', async () => {
      const { db, profile } = await setup({ connected: false });
      insertMailRule(db, { profileId: profile().id, appleFolderPath: 'INBOX', appleFolderName: 'INBOX', googleLabel: 'INBOX' });

      expect(pollingTargetsOf(db, profile()).appleMailFolders).toEqual([]);
    });
  });
});
