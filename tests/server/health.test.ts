import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/test-app.js';

describe('GET /api/health', () => {
  let ctx: TestContext | undefined;

  afterEach(() => {
    ctx?.close();
    ctx = undefined;
  });

  it('is publicly accessible without a session and verifies SQLite readability', async () => {
    ctx = createTestContext();

    const response = await ctx.app.request('/api/health');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      database: 'ok',
    });
  });

  it('returns 503 when the SQLite database cannot be read', async () => {
    ctx = createTestContext();
    ctx.dbContext.sqlite.close();

    const response = await ctx.app.request('/api/health');
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: 'error',
      database: 'error',
    });
  });
});
