import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  TEST_PASSWORD,
  TEST_USERNAME,
  type TestContext,
} from '../helpers/test-app.js';

describe('Static frontend serving from Hono', () => {
  let ctx: TestContext | undefined;
  let tempDir: string | undefined;

  afterEach(() => {
    ctx?.close();
    ctx = undefined;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('serves /login and /assets/* publicly while protecting / with session auth', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-sync-static-'));
    fs.mkdirSync(path.join(tempDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'index.html'), '<!doctype html><html><body>Cloud Sync App</body></html>');
    fs.writeFileSync(path.join(tempDir, 'assets', 'app.js'), 'console.log("ok");');

    ctx = createTestContext({ staticDir: tempDir });

    // /login HTML is public
    const loginPage = await ctx.app.request('/login');
    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain('Cloud Sync App');

    // /assets/* is public
    const asset = await ctx.app.request('/assets/app.js');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('console.log("ok")');

    // / redirects unauthenticated visitors to /login
    const unauthRoot = await ctx.app.request('/');
    expect(unauthRoot.status).toBe(302);
    expect(unauthRoot.headers.get('location')).toBe('/login');

    // Authenticated user receives the SPA shell at /
    const loginRes = await ctx.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: TEST_USERNAME,
        password: TEST_PASSWORD,
        totpCode: ctx.generateTotp(0),
      }),
    });
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0];

    const authRoot = await ctx.app.request('/', { headers: { cookie } });
    expect(authRoot.status).toBe(200);
    expect(await authRoot.text()).toContain('Cloud Sync App');
  });
});
