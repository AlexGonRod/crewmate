import net from 'node:net';
import { CrewError } from '../core/errors';

export const DEFAULT_PREVIEW_PORT = 4321;
const DEFAULT_ATTEMPTS = 100;

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function previewUrl(port: number): string {
  return `http://localhost:${port}`;
}

/**
 * True when nothing is listening on 127.0.0.1:port. It binds instead of
 * connecting so a port held by any local process is detected.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1' }, () => {
      server.close(() => resolve(true));
    });
  });
}

export interface PickPortOptions {
  /** Ports remembered by other live previews; never reused. */
  isUsed?: (port: number) => boolean;
  /** Availability probe, injectable for tests. Defaults to binding. */
  isAvailable?: (port: number) => Promise<boolean>;
  attempts?: number;
}

/**
 * Base plus the first free port: skips ports of other live previews and
 * ports the system already holds.
 */
export async function pickFreePort(
  base: number,
  options: PickPortOptions = {},
): Promise<number> {
  if (!isValidPort(base)) {
    throw new CrewError(
      'PREVIEW_INVALID_PORT',
      `Invalid preview base port: ${base}. Use an integer between 1 and 65535.`,
    );
  }
  const isUsed = options.isUsed ?? (() => false);
  const isAvailable = options.isAvailable ?? isPortFree;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = base + offset;
    if (!isValidPort(port)) {
      break;
    }
    if (isUsed(port)) {
      continue;
    }
    if (await isAvailable(port)) {
      return port;
    }
  }
  throw new CrewError(
    'PREVIEW_NO_PORT',
    `No free preview port from ${base} to ${base + attempts - 1}`,
  );
}
