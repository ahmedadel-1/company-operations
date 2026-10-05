const UNAVAILABLE_NAMES: ReadonlySet<string> = new Set([
  'MaxRetriesPerRequestError',
  'PrismaClientInitializationError',
]);

const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  // Prisma: database unreachable, connect timeout, connection closed, pool timeout.
  'P1001',
  'P1002',
  'P1017',
  'P2024',
  // PostgreSQL: shutting down, cannot connect now, too many connections.
  '57P01',
  '57P03',
  '53300',
]);

const UNAVAILABLE_MESSAGES: readonly RegExp[] = [/^Connection is closed\.?$/, /^Stream isn't writeable/];

const MAX_CAUSE_DEPTH = 5;

/**
 * True when an error means PostgreSQL or Redis could not be reached (the request may succeed once the
 * dependency recovers), as opposed to a bug. Follows `cause` chains, where drivers nest the network error.
 */
export function isDependencyFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    const { name, message } = current;
    if (UNAVAILABLE_NAMES.has(name) || UNAVAILABLE_MESSAGES.some((pattern) => pattern.test(message))) {
      return true;
    }
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
