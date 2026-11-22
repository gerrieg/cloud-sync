import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { ConfigError, parseConfig } from './config.js';
import { createDatabase } from './db/index.js';
import { createShutdown } from './shutdown.js';

function resolveStaticDir(): string | undefined {
  const compiledClientDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../client',
  );
  if (fs.existsSync(path.join(compiledClientDir, 'index.html'))) {
    return compiledClientDir;
  }

  const distClientDir = path.resolve(process.cwd(), 'dist/client');
  if (fs.existsSync(path.join(distClientDir, 'index.html'))) {
    return distClientDir;
  }

  return undefined;
}

function main(): void {
  let config;
  try {
    config = parseConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
    } else {
      console.error('Failed to load configuration:', error);
    }
    process.exit(1);
  }

  if (config.totpSecret === null) {
    console.warn('TOTP_SECRET is not set: the login asks for username and password only (no authenticator code).');
  }

  const dbContext = createDatabase(config.databasePath);
  const staticDir = resolveStaticDir();
  const { app, realtime } = createApp({ config, dbContext, staticDir });

  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  realtime.start();

  console.log(`Cloud Sync listening on http://0.0.0.0:${config.port}`);

  const shutdown = createShutdown({ server, realtime, dbContext, exit: (code) => process.exit(code) });
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
