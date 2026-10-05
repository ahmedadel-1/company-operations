import { EventEmitter } from 'node:events';

import { getQueueToken } from '@nestjs/bullmq';
import type { WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import { QUEUE_NAMES } from '@company-ops/core';

import { bullErrorLogging } from '../src/ops/bull-error-logging.js';

class FakeProcessor {
  readonly worker = Object.assign(new EventEmitter(), { name: 'notifications' });
}

describe('BullMQ error logging', () => {
  it('logs queue and worker connection errors through the structured logger instead of console.error', () => {
    const queues = new Map(QUEUE_NAMES.map((name) => [getQueueToken(name), new EventEmitter()]));
    const processor = new FakeProcessor();
    const modules = {
      get: (token: unknown) => (token === FakeProcessor ? processor : queues.get(String(token))),
    } as unknown as ModuleRef;
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const Logging = bullErrorLogging([FakeProcessor as unknown as Type<WorkerHost>]);
      new Logging(modules).onApplicationBootstrap();

      const failure = new Error('getaddrinfo ENOTFOUND redis');
      for (const queue of queues.values()) {
        expect(queue.emit('error', failure)).toBe(true);
      }
      expect(processor.worker.emit('error', failure)).toBe(true);

      expect(warn).toHaveBeenCalledTimes(QUEUE_NAMES.length + 1);
      expect(warn).toHaveBeenCalledWith({ err: failure, queue: 'notifications' }, 'Worker error');
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      consoleError.mockRestore();
    }
  });
});
