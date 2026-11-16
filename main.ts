import { createApp } from './app.ts';

const environment = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const requestTimeoutMs = 30_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt: number): number {
  return Math.min(2_000, 250 * 2 ** Math.min(attempt, 3));
}

async function register(env: string, port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${env}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      await pause(retryDelay(attempt));
      continue;
    }

    if (response.status === 200 || response.status === 409) return;
    if (response.status === 400 || response.status === 405) {
      throw new Error(`Registration was rejected with HTTP ${response.status}: ${await response.text()}`);
    }
    await pause(retryDelay(attempt));
  }
}

async function waitUntilDone(env: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${env}/done`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.ok) {
        const result: unknown = await response.json();
        if (typeof result === 'object' && result !== null && 'done' in result && result.done === true) return;
      }
    } catch {
      // A failed poll is retried just like a not-yet-done response.
    }
    await pause(retryDelay(attempt));
  }
}

if (environment === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is missing; cannot register with the environment\n');
  process.exitCode = 1;
} else {
  const server = createApp();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The forge did not receive a TCP port');
    }
    process.stdout.write(`[entry] forge listening on port ${address.port}\n`);

    await register(environment, address.port);
    process.stdout.write('[entry] environment registration accepted\n');

    await waitUntilDone(environment);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    process.stdout.write('[entry] environment finished; forge closed\n');
  } catch (error) {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
