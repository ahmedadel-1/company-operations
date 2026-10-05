import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import { WORKER_ENV } from '../config/worker-env.js';
import type { WorkerEnv } from '../config/worker-env.js';
import { OutboxRelay } from './outbox-relay.js';

/**
 * Polling loop around {@link OutboxRelay}. Drains full batches immediately, otherwise waits
 * `OUTBOX_POLL_INTERVAL_MS`. A failing tick (database or Redis down) is logged and retried on the
 * next interval; the loop never stops on its own.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    @Inject(OutboxRelay) private readonly relay: OutboxRelay,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    await this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.running = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let next = this.env.OUTBOX_POLL_INTERVAL_MS;
    try {
      const result = await this.relay.relayBatch();
      if (result.failed > 0) {
        this.logger.warn({ failed: result.failed, dispatched: result.dispatched }, 'Outbox relay failures');
      }
      if (result.claimed === this.env.OUTBOX_BATCH_SIZE) {
        next = 0;
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Outbox relay tick failed');
    }
    this.schedule(next);
  }
}
