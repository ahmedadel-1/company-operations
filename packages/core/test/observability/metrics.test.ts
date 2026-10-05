import { describe, expect, it } from 'vitest';

import { MetricsRegistry, PROMETHEUS_CONTENT_TYPE, startOpsServer } from '../../src/index.js';

describe('MetricsRegistry', () => {
  it('renders counters, histograms and gauges in the Prometheus text format', async () => {
    const metrics = new MetricsRegistry();
    const counter = metrics.counter('jobs_total', 'Jobs.', ['queue']);
    counter.inc({ queue: 'sla' });
    counter.inc({ queue: 'sla' }, 2);
    const histogram = metrics.histogram('latency_seconds', 'Latency.', [0.1, 1], ['route']);
    histogram.observe({ route: '/a' }, 0.05);
    histogram.observe({ route: '/a' }, 0.5);
    histogram.observe({ route: '/a' }, 5);
    metrics.gauge('depth', 'Depth.', () => [{ labels: { queue: 'q"1\\' }, value: 4 }]);
    const text = await metrics.render();
    expect(text).toContain('# TYPE ops_jobs_total counter');
    expect(text).toContain('ops_jobs_total{queue="sla"} 3');
    expect(text).toContain('ops_latency_seconds_bucket{route="/a",le="0.1"} 1');
    expect(text).toContain('ops_latency_seconds_bucket{route="/a",le="1"} 2');
    expect(text).toContain('ops_latency_seconds_bucket{route="/a",le="+Inf"} 3');
    expect(text).toContain('ops_latency_seconds_count{route="/a"} 3');
    expect(text).toContain('ops_depth{queue="q\\"1\\\\"} 4');
    expect(text).toContain('ops_metrics_collector_errors 0');
  });

  it('reports a failing collector instead of failing the scrape', async () => {
    const metrics = new MetricsRegistry();
    metrics.gauge('broken', 'Broken.', () => Promise.reject(new Error('db down')));
    metrics.gauge('fine', 'Fine.', () => [{ value: 1 }]);
    const text = await metrics.render();
    expect(text).toContain('ops_fine 1');
    expect(text).not.toContain('db down');
    expect(text).toContain('ops_metrics_collector_errors 1');
  });

  it('reports process memory and event-loop utilisation between 0 and 1', async () => {
    const metrics = new MetricsRegistry();
    metrics.registerProcessMetrics();
    const busyUntil = Date.now() + 20;
    while (Date.now() < busyUntil) {
      // Keep the event loop busy so the utilisation since registration is measurable.
    }
    const text = await metrics.render();
    expect(text).toMatch(/^ops_process_resident_memory_bytes \d+$/m);
    const utilization = Number(/^ops_process_event_loop_utilization ([\d.]+)$/m.exec(text)?.[1]);
    expect(utilization).toBeGreaterThan(0);
    expect(utilization).toBeLessThanOrEqual(1);
  });

  it('rejects unknown labels, invalid and duplicate names', () => {
    const metrics = new MetricsRegistry();
    const counter = metrics.counter('a_total', 'A.', ['route']);
    expect(() => {
      counter.inc({ userId: 'u1' });
    }).toThrow(/no label userId/);
    expect(() => metrics.counter('a_total', 'A.')).toThrow(/already registered/);
    expect(() => metrics.counter('Bad-Name', 'B.')).toThrow(/invalid metric name/);
  });
});

describe('startOpsServer', () => {
  it('serves fixed GET routes only and hides route failures', async () => {
    const server = await startOpsServer({
      host: '127.0.0.1',
      port: 0,
      routes: {
        '/metrics': () => Promise.resolve({ status: 200, body: 'ops_up 1\n', contentType: PROMETHEUS_CONTENT_TYPE }),
        '/health/ready': () => Promise.reject(new Error('secret detail')),
      },
    });
    const base = `http://127.0.0.1:${String(server.port)}`;
    try {
      const metrics = await fetch(`${base}/metrics?x=1`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get('content-type')).toBe(PROMETHEUS_CONTENT_TYPE);
      expect(await metrics.text()).toBe('ops_up 1\n');
      const failing = await fetch(`${base}/health/ready`);
      expect(failing.status).toBe(503);
      expect(await failing.text()).not.toContain('secret detail');
      expect((await fetch(`${base}/other`)).status).toBe(404);
      expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(405);
    } finally {
      await server.close();
    }
  });
});
