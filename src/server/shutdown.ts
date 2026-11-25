export interface ShutdownDeps {
  readonly server: {
    close(callback?: (error?: Error) => void): unknown;
    closeIdleConnections?(): void;
  };
  readonly realtime: { stop(): Promise<void> };
  readonly dbContext: { close(): void };
  readonly exit: (code: number) => void;
  /** Upper bound for the whole shutdown, after which the process exits with code 1. */
  readonly timeoutMs?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

/**
 * Returns the signal handler for a clean stop: no new HTTP requests, no more scheduled work, IDLE
 * connections closed, SQLite checkpointed and closed. Repeated signals join the first shutdown.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let running: Promise<void> | null = null;
  return (signal) => {
    running ??= runShutdown(deps, signal);
    return running;
  };
}

async function runShutdown(deps: ShutdownDeps, signal: string): Promise<void> {
  const { server, realtime, dbContext, exit, timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS } = deps;
  console.log(`Received ${signal}, shutting down`);
  let failed = false;
  const forceExit = setTimeout(() => {
    console.error(`Shutdown took longer than ${timeoutMs} ms, exiting anyway`);
    exit(1);
  }, timeoutMs);

  const runStep = async (step: string, work: () => Promise<unknown> | void): Promise<void> => {
    try {
      await work();
    } catch (error) {
      failed = true;
      console.error(`Shutdown step "${step}" failed:`, error);
    }
  };

  // Stop accepting requests and let those in flight finish; idle keep-alive sockets would hold this up
  await runStep(
    'http server',
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(error);
          } else {
            resolve();
          }
        });
        server.closeIdleConnections?.();
      }),
  );
  // Stops the scheduler, closes the IDLE connections and waits for running syncs
  await runStep('real-time workers', () => realtime.stop());
  await runStep('database', () => dbContext.close());

  clearTimeout(forceExit);
  exit(failed ? 1 : 0);
}
