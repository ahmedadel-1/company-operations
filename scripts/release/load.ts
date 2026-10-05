// HTTP load generator for release rehearsals (docs/runbooks/performance.md). No dependencies; Node 24
// (native type stripping). Uses an existing authenticated session; it never signs in or stores secrets.
//
//   LOAD_BASE=http://api:4000 LOAD_ORIGIN=https://ops.example LOAD_SESSION_FILE=/run/session \
//   LOAD_WRITES=300 LOAD_SECONDS=60 LOAD_CONCURRENCY=32 node scripts/release/load.ts
//
// Phase 1 creates LOAD_WRITES employees, customers and support tickets concurrently (write path, audit,
// outbox, notifications). Phase 2 runs a fixed read mix for LOAD_SECONDS with LOAD_CONCURRENCY workers.
// Prints p50/p95/p99/max latency, throughput and status codes per route as JSON lines.
import { readFileSync } from 'node:fs';

const base = (process.env.LOAD_BASE ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const origin = process.env.LOAD_ORIGIN ?? base;
const session = (process.env.LOAD_SESSION ?? readFileSync(process.env.LOAD_SESSION_FILE ?? '', 'utf8')).trim();
const writes = Number(process.env.LOAD_WRITES ?? '0');
const seconds = Number(process.env.LOAD_SECONDS ?? '30');
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? '16');
const writeConcurrency = Number(process.env.LOAD_WRITE_CONCURRENCY ?? '8');
const runId = Date.now().toString(36);
const cookie = `__Host-ops_sid=${session}`;

interface Sample {
  readonly route: string;
  readonly status: number;
  readonly ms: number;
}

const READS: readonly string[] = [
  '/api/v1/me',
  '/api/v1/dashboard/me',
  '/api/v1/dashboard/needs-attention',
  '/api/v1/notifications/unread-count',
  '/api/v1/notifications?limit=20',
  '/api/v1/employees?limit=50',
  '/api/v1/support/tickets?limit=50',
  '/api/v1/customers?limit=50',
  '/api/v1/approvals/summary',
  '/api/v1/attendance/today',
  '/api/v1/search?q=load',
  '/api/v1/audit/events?limit=50',
];

async function call(method: string, path: string, body?: unknown, csrf?: string): Promise<Sample & { json: unknown }> {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      origin,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const ms = performance.now() - started;
  let json: unknown;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = text;
  }
  return { route: `${method} ${path.split('?')[0] ?? path}`, status: response.status, ms, json };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function report(phase: string, samples: readonly Sample[], elapsedMs: number): void {
  const groups = new Map<string, Sample[]>([['ALL', [...samples]]]);
  for (const sample of samples) {
    groups.set(sample.route, [...(groups.get(sample.route) ?? []), sample]);
  }
  for (const [route, group] of groups) {
    const sorted = group.map((sample) => sample.ms).sort((a, b) => a - b);
    const statuses: Record<string, number> = {};
    for (const sample of group) {
      statuses[String(sample.status)] = (statuses[String(sample.status)] ?? 0) + 1;
    }
    console.log(
      JSON.stringify({
        phase,
        route,
        requests: group.length,
        rps: Math.round((group.length / elapsedMs) * 100_000) / 100,
        p50: Math.round(percentile(sorted, 50)),
        p95: Math.round(percentile(sorted, 95)),
        p99: Math.round(percentile(sorted, 99)),
        max: Math.round(sorted.at(-1) ?? 0),
        statuses,
      }),
    );
  }
}

async function pool(count: number, workers: number, task: (index: number) => Promise<Sample>): Promise<Sample[]> {
  const samples: Sample[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, count) }, async () => {
      while (next < count) {
        const index = next;
        next += 1;
        const { route, status, ms } = await task(index);
        samples.push({ route, status, ms });
      }
    }),
  );
  return samples;
}

const csrfResponse = await call('GET', '/api/v1/auth/csrf');
if (csrfResponse.status !== 200) {
  throw new Error(`session not accepted (csrf endpoint answered ${String(csrfResponse.status)})`);
}
const csrf = (csrfResponse.json as { data: { csrfToken: string } }).data.csrfToken;

if (writes > 0) {
  const started = performance.now();
  const samples = await pool(writes * 3, writeConcurrency, async (index) => {
    const n = Math.floor(index / 3);
    switch (index % 3) {
      case 0:
        return call(
          'POST',
          '/api/v1/employees',
          {
            fullName: `Load ${runId} ${String(n)}`,
            employeeNumber: `L${runId}-${String(n)}`.slice(0, 32),
            employmentType: 'FULL_TIME',
          },
          csrf,
        );
      case 1:
        return call(
          'POST',
          '/api/v1/customers',
          { name: `Load customer ${runId} ${String(n)}`, type: 'PRIVATE' },
          csrf,
        );
      default:
        return call(
          'POST',
          '/api/v1/support/tickets',
          {
            title: `Load ticket ${runId} ${String(n)}`,
            description: 'Generated by the release load rehearsal.',
            severity: (['LOW', 'MEDIUM', 'HIGH'] as const)[n % 3],
            impact: 'SINGLE_USER',
          },
          csrf,
        );
    }
  });
  report('write', samples, performance.now() - started);
}

const deadline = performance.now() + seconds * 1000;
const started = performance.now();
const reads: Sample[] = [];
let cursor = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (performance.now() < deadline) {
      const path = READS[cursor % READS.length] ?? '/api/v1/me';
      cursor += 1;
      const { route, status, ms } = await call('GET', path);
      reads.push({ route, status, ms });
    }
  }),
);
report('read', reads, performance.now() - started);
