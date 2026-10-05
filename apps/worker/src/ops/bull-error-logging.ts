import { getQueueToken } from '@nestjs/bullmq';
import type { WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Queue } from 'bullmq';

import { QUEUE_NAMES } from '@company-ops/core';

/**
 * BullMQ re-emits Redis connection errors on every Queue and Worker and, when nothing listens, prints
 * them with `console.error`: unstructured, multi-line and outside log redaction. This routes them through
 * the structured logger instead. Reconnection itself is handled by ioredis.
 */
export function bullErrorLogging(processors: readonly Type<WorkerHost>[]): Type<OnApplicationBootstrap> {
  @Injectable()
  class BullErrorLogging implements OnApplicationBootstrap {
    private readonly logger = new Logger('BullMQ');

    constructor(private readonly modules: ModuleRef) {}

    onApplicationBootstrap(): void {
      for (const name of QUEUE_NAMES) {
        this.modules.get<Queue>(getQueueToken(name), { strict: false }).on('error', (error: Error) => {
          this.logger.warn({ err: error, queue: name }, 'Queue connection error');
        });
      }
      for (const processor of processors) {
        const { worker } = this.modules.get(processor, { strict: false });
        worker.on('error', (error: Error) => {
          this.logger.warn({ err: error, queue: worker.name }, 'Worker error');
        });
      }
    }
  }
  return BullErrorLogging;
}
