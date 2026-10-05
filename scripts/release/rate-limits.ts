// Rate-limit verification for release rehearsals (docs/runbooks/performance.md §Rate limits). Node 24,
// no dependencies. Sends bursts against each limiter with the production defaults and reports how many
// requests were served before 429, and whether 429 responses carry Retry-After.
//
//   RL_API=http://api:4000 RL_PROXY=https://ops.example RL_SESSION=<session id> node scripts/release/rate-limits.ts
const api = (process.env.RL_API ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const proxy = process.env.RL_PROXY?.replace(/\/+$/, '');
const session = process.env.RL_SESSION ?? '';

interface Burst {
  readonly name: string;
  readonly served: number;
  readonly limited: number;
  readonly other: Record<string, number>;
  readonly retryAfter: boolean;
}

async function burst(name: string, url: string, count: number, concurrency: number, cookie = false): Promise<Burst> {
  let served = 0;
  let limited = 0;
  let retryAfter = true;
  const other: Record<string, number> = {};
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < count) {
        next += 1;
        const response = await fetch(url, {
          redirect: 'manual',
          headers: cookie ? { cookie: `__Host-ops_sid=${session}` } : {},
        });
        await response.arrayBuffer();
        if (response.status === 429) {
          limited += 1;
          retryAfter &&= response.headers.has('retry-after');
        } else if (response.status < 400) {
          served += 1;
        } else {
          other[String(response.status)] = (other[String(response.status)] ?? 0) + 1;
        }
      }
    }),
  );
  const result = { name, served, limited, other, retryAfter: limited > 0 && retryAfter };
  console.log(JSON.stringify(result));
  return result;
}

const results: Burst[] = [];
results.push(await burst('auth per IP (20/min)', `${api}/api/v1/auth/login`, 30, 5));
results.push(await burst('search per user (60/min)', `${api}/api/v1/search?q=load`, 80, 8, true));
results.push(await burst('user per principal (240/min)', `${api}/api/v1/notifications/unread-count`, 300, 10, true));
if (proxy !== undefined) {
  results.push(await burst('nginx api zone (50 r/s, burst 200)', `${proxy}/api/v1/health/live`, 600, 150));
}

const checks = [
  results[0] !== undefined && results[0].served <= 20 && results[0].limited > 0,
  results[1] !== undefined && results[1].served <= 60 && results[1].limited > 0,
  // The search burst above counts against the same principal's general budget.
  results[2] !== undefined && results[2].served <= 240 && results[2].limited > 0,
  proxy === undefined || (results[3] !== undefined && results[3].limited > 0),
  results.every((result) => result.retryAfter),
];
process.exit(checks.every(Boolean) ? 0 : 1);
