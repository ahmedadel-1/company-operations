/**
 * Minimal Prometheus text-format registry (ADR-0024). Counters and histograms are updated in-process;
 * gauges are computed at scrape time by collectors. Labels are a fixed, low-cardinality set chosen by
 * the caller (method, route template, status class, queue, state); identifiers of people, organizations
 * or records are never labels, so the metrics cannot be used to watch individual employees.
 */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

type Labels = Readonly<Record<string, string>>;

const NAME = /^[a-z_][a-z0-9_]*$/;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelText(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return '';
  }
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

function keyOf(labelNames: readonly string[], labels: Labels): string {
  return labelNames.map((name) => labels[name] ?? '').join('\u0000');
}

function checkLabels(metric: string, labelNames: readonly string[], labels: Labels): void {
  for (const name of Object.keys(labels)) {
    if (!labelNames.includes(name)) {
      throw new Error(`metric ${metric} has no label ${name}`);
    }
  }
}

export interface Counter {
  inc(labels?: Labels, value?: number): void;
}

export interface Histogram {
  observe(labels: Labels, value: number): void;
}

interface Series {
  labels: Labels;
  value: number;
}

interface HistogramSeries {
  labels: Labels;
  buckets: number[];
  sum: number;
  count: number;
}

export interface GaugeSample {
  readonly labels?: Labels;
  readonly value: number;
}

type Renderer = () => Promise<string[]>;

/** Upper bound on distinct label combinations per metric; protects memory if a caller mislabels. */
const MAX_SERIES = 2_000;

export class MetricsRegistry {
  private readonly renderers: { name: string; render: Renderer }[] = [];

  constructor(private readonly prefix = 'ops_') {}

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    const full = this.register(name);
    const series = new Map<string, Series>();
    this.renderers.push({
      name: full,
      render: () =>
        Promise.resolve([
          `# HELP ${full} ${help}`,
          `# TYPE ${full} counter`,
          ...[...series.values()].map((entry) => `${full}${labelText(entry.labels)} ${String(entry.value)}`),
        ]),
    });
    return {
      inc: (labels: Labels = {}, value = 1) => {
        checkLabels(full, labelNames, labels);
        const key = keyOf(labelNames, labels);
        const entry = series.get(key);
        if (entry !== undefined) {
          entry.value += value;
        } else if (series.size < MAX_SERIES) {
          series.set(key, { labels, value });
        }
      },
    };
  }

  histogram(name: string, help: string, buckets: readonly number[], labelNames: readonly string[] = []): Histogram {
    const full = this.register(name);
    const bounds = [...buckets].sort((a, b) => a - b);
    const series = new Map<string, HistogramSeries>();
    this.renderers.push({
      name: full,
      render: () => {
        const lines = [`# HELP ${full} ${help}`, `# TYPE ${full} histogram`];
        for (const entry of series.values()) {
          bounds.forEach((bound, index) => {
            lines.push(
              `${full}_bucket${labelText({ ...entry.labels, le: String(bound) })} ${String(entry.buckets[index] ?? 0)}`,
            );
          });
          lines.push(`${full}_bucket${labelText({ ...entry.labels, le: '+Inf' })} ${String(entry.count)}`);
          lines.push(`${full}_sum${labelText(entry.labels)} ${String(entry.sum)}`);
          lines.push(`${full}_count${labelText(entry.labels)} ${String(entry.count)}`);
        }
        return Promise.resolve(lines);
      },
    });
    return {
      observe: (labels: Labels, value: number) => {
        checkLabels(full, labelNames, labels);
        const key = keyOf(labelNames, labels);
        let entry = series.get(key);
        if (entry === undefined) {
          if (series.size >= MAX_SERIES) {
            return;
          }
          entry = { labels, buckets: bounds.map(() => 0), sum: 0, count: 0 };
          series.set(key, entry);
        }
        bounds.forEach((bound, index) => {
          if (value <= bound && entry.buckets[index] !== undefined) {
            entry.buckets[index] += 1;
          }
        });
        entry.sum += value;
        entry.count += 1;
      },
    };
  }

  /** A gauge whose samples are read when metrics are scraped. A failing collector is reported, not thrown. */
  gauge(name: string, help: string, collect: () => Promise<readonly GaugeSample[]> | readonly GaugeSample[]): void {
    const full = this.register(name);
    this.renderers.push({
      name: full,
      render: async () => {
        const samples = await collect();
        return [
          `# HELP ${full} ${help}`,
          `# TYPE ${full} gauge`,
          ...samples.map((sample) => `${full}${labelText(sample.labels ?? {})} ${String(sample.value)}`),
        ];
      },
    });
  }

  /** Standard process gauges (uptime, memory, event-loop utilisation). */
  registerProcessMetrics(): void {
    const started = Date.now();
    this.gauge('process_uptime_seconds', 'Seconds since the process started.', () => [
      { value: Math.round((Date.now() - started) / 1000) },
    ]);
    this.gauge('process_resident_memory_bytes', 'Resident set size in bytes.', () => [
      { value: process.memoryUsage().rss },
    ]);
    this.gauge('process_heap_used_bytes', 'V8 heap in use, in bytes.', () => [
      { value: process.memoryUsage().heapUsed },
    ]);
    let previous = performance.eventLoopUtilization();
    this.gauge(
      'process_event_loop_utilization',
      'Share of time the event loop was busy since the previous scrape (0-1); near 1 means CPU-saturated.',
      () => {
        const current = performance.eventLoopUtilization();
        const delta = performance.eventLoopUtilization(current, previous);
        previous = current;
        return [{ value: Math.round(delta.utilization * 1000) / 1000 }];
      },
    );
  }

  async render(): Promise<string> {
    const failed: string[] = [];
    const blocks = await Promise.all(
      this.renderers.map(async ({ name, render }) => {
        try {
          return await render();
        } catch {
          failed.push(name);
          return [];
        }
      }),
    );
    const scrapeErrors = [
      `# HELP ${this.prefix}metrics_collector_errors Collectors that failed during this scrape.`,
      `# TYPE ${this.prefix}metrics_collector_errors gauge`,
      `${this.prefix}metrics_collector_errors ${String(failed.length)}`,
    ];
    return `${[...blocks.flat(), ...scrapeErrors].join('\n')}\n`;
  }

  private register(name: string): string {
    const full = `${this.prefix}${name}`;
    if (!NAME.test(full)) {
      throw new Error(`invalid metric name ${full}`);
    }
    if (this.renderers.some((entry) => entry.name === full)) {
      throw new Error(`metric ${full} is already registered`);
    }
    return full;
  }
}
