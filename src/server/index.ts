import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { ConfigError, parseConfig } from './config.js';
import { createDatabase } from './db/index.js';

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

  const dbContext = createDatabase(config.databasePath);
  const staticDir = resolveStaticDir();
  const { app, realtime } = createApp({ config, dbContext, staticDir });

  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  realtime.start();

  console.log(`Cloud Sync listening on http://0.0.0.0:${config.port}`);

  const shutdown = () => {
    server.close(() => {
      void realtime.stop().finally(() => {
        dbContext.close();
        process.exit(0);
      });
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
