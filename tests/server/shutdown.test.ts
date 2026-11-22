import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/server/db/index.js';
import { createShutdown } from '../../src/server/shutdown.js';
import { setupMail } from '../helpers/mail-scenario.js';

describe('graceful shutdown', () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  /** A running app: real HTTP server, real orchestrator with one open IDLE connection, on-disk SQLite. */
  async function runningApp() {
    const s = await setupMail();
    await s.createRule('INBOX');
    cleanups.push(() => s.ctx.close());

    const tickSpy = vi.spyOn(s.ctx.realtime, 'tick');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    s.ctx.realtime.start();
    await s.ctx.realtime.tick();
    await s.ctx.realtime.settled();
    expect(s.world.openIdleConnections(s.appleId)).toBe(1);

    const server = serve({ fetch: s.ctx.app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    cleanups.push(() => server.close());
    const port = (server.address() as AddressInfo).port;

    const exit = vi.fn<(code: number) => void>();
    const shutdown = createShutdown({
      server,
      realtime: s.ctx.realtime,
      dbContext: s.ctx.dbContext,
      exit,
      timeoutMs: 5_000,
    });
    tickSpy.mockClear();
    return { ...s, server, port, exit, shutdown, tickSpy };
  }

  function get(port: number, agent?: http.Agent): Promise<number> {
    return new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/health', agent }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        })
        .on('error', reject);
    });
  }

  it('stops serving, stops the cron timer, closes the IDLE connection and SQLite, then exits 0', async () => {
    const s = await runningApp();
    await expect(get(s.port)).resolves.toBe(200);

    await s.shutdown('SIGTERM');

    await expect(get(s.port)).rejects.toThrow();
    expect(s.world.openIdleConnections(s.appleId)).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(s.tickSpy).not.toHaveBeenCalled();
    expect(s.ctx.dbContext.sqlite.open).toBe(false);
    expect(s.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('is not held up by idle keep-alive connections', async () => {
    const s = await runningApp();
    const agent = new http.Agent({ keepAlive: true });
    cleanups.push(() => agent.destroy());
    await expect(get(s.port, agent)).resolves.toBe(200);

    await s.shutdown('SIGINT');

    expect(s.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('first stops accepting requests, then stops real-time work, then closes the database', async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      server: {
        close: (cb) => {
          order.push('server.close');
          cb?.();
        },
        closeIdleConnections: () => order.push('server.closeIdleConnections'),
      },
      realtime: {
        stop: async () => {
          order.push('realtime.stop');
        },
      },
      dbContext: { close: () => order.push('db.close') },
      exit: (code) => order.push(`exit(${code})`),
      timeoutMs: 1_000,
    });

    await shutdown('SIGTERM');

    expect(order).toEqual([
      'server.close',
      'server.closeIdleConnections',
      'realtime.stop',
      'db.close',
      'exit(0)',
    ]);
  });

  it('shuts down only once when signals arrive repeatedly', async () => {
    const s = await runningApp();
    const stop = vi.spyOn(s.ctx.realtime, 'stop');

    await Promise.all([s.shutdown('SIGTERM'), s.shutdown('SIGINT')]);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(s.exit).toHaveBeenCalledTimes(1);
  });

  it('still closes the database and exits 1 when stopping real-time work fails', async () => {
    const s = await runningApp();
    vi.spyOn(s.ctx.realtime, 'stop').mockRejectedValue(new Error('IDLE close blew up'));

    await s.shutdown('SIGTERM');

    expect(s.ctx.dbContext.sqlite.open).toBe(false);
    expect(s.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('forces exit 1 when shutdown hangs longer than the timeout', async () => {
    vi.useFakeTimers();
    const exit = vi.fn<(code: number) => void>();
    const shutdown = createShutdown({
      server: { close: () => undefined },
      realtime: { stop: () => new Promise<void>(() => undefined) },
      dbContext: { close: () => undefined },
      exit,
      timeoutMs: 10_000,
    });

    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  describe('SQLite on disk', () => {
    it('checkpoints the WAL into the main database file when closing', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-sync-wal-'));
      cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      const file = path.join(dir, 'cloud-sync.db');

      const dbContext = createDatabase(file);
      dbContext.sqlite.pragma('wal_autocheckpoint = 0');
      dbContext.sqlite.exec('CREATE TABLE shutdown_probe (value TEXT)');
      dbContext.sqlite.prepare('INSERT INTO shutdown_probe VALUES (?)').run('kept');
      expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);

      dbContext.close();

      expect(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0).toBe(0);
      const reopened = createDatabase(file);
      try {
        expect(reopened.sqlite.prepare('SELECT value FROM shutdown_probe').get()).toEqual({ value: 'kept' });
      } finally {
        reopened.close();
      }
    });
  });
});
