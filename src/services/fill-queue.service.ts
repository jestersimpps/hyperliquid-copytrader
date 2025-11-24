import type { UserFillData } from '@/types/websocket.types';

export interface QueueMetrics {
  totalReceived: number;
  totalProcessed: number;
  duplicatesDropped: number;
  currentQueueSize: number;
  processingRate: number;
  lastProcessedAt: number | null;
}

export type FillProcessor = (fill: UserFillData, connectionId: number) => Promise<void>;

export class FillQueueService {
  private queue: Array<{ fill: UserFillData; connectionId: number; timestamp: number }> = [];
  private processedTids: Set<string> = new Set();
  private isProcessing = false;
  private fillProcessor: FillProcessor | null = null;

  private metrics: QueueMetrics = {
    totalReceived: 0,
    totalProcessed: 0,
    duplicatesDropped: 0,
    currentQueueSize: 0,
    processingRate: 0,
    lastProcessedAt: null
  };

  private readonly MAX_PROCESSED_TIDS = 1000;
  private readonly MAX_QUEUE_SIZE = 50;

  setFillProcessor(processor: FillProcessor): void {
    this.fillProcessor = processor;
  }

  enqueueFill(fill: UserFillData, connectionId: number): void {
    this.metrics.totalReceived++;

    const tidString = String(fill.tid);
    if (this.processedTids.has(tidString)) {
      this.metrics.duplicatesDropped++;
      console.log(`  ⊘ Duplicate fill dropped (TID: ${fill.tid}, Connection: ${connectionId})`);
      return;
    }

    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      console.warn(`⚠️  Fill queue at capacity (${this.MAX_QUEUE_SIZE}), dropping oldest fill`);
      this.queue.shift();
    }

    this.queue.push({
      fill,
      connectionId,
      timestamp: Date.now()
    });

    this.metrics.currentQueueSize = this.queue.length;
    this.processedTids.add(tidString);

    this.trimProcessedTids();

    if (!this.isProcessing) {
      this.processQueue().catch(error => {
        console.error('Error in queue processing:', error);
      });
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      this.metrics.currentQueueSize = this.queue.length;

      if (!this.fillProcessor) {
        console.error('Fill processor not set, skipping fill');
        continue;
      }

      try {
        const startTime = Date.now();
        await this.fillProcessor(item.fill, item.connectionId);
        const processingTime = Date.now() - startTime;

        this.metrics.totalProcessed++;
        this.metrics.lastProcessedAt = Date.now();
        this.metrics.processingRate = processingTime;

        const queueLatency = Date.now() - item.timestamp;
        if (queueLatency > 1000) {
          console.warn(`⚠️  High queue latency: ${queueLatency}ms (Connection ${item.connectionId})`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`✗ Error processing fill from Connection ${item.connectionId}: ${errorMessage}`);
      }
    }

    this.isProcessing = false;
  }

  private trimProcessedTids(): void {
    if (this.processedTids.size > this.MAX_PROCESSED_TIDS) {
      const tidsArray = Array.from(this.processedTids);
      this.processedTids = new Set(tidsArray.slice(-500));
    }
  }

  getMetrics(): QueueMetrics {
    return { ...this.metrics };
  }

  clear(): void {
    this.queue = [];
    this.processedTids.clear();
    this.metrics.currentQueueSize = 0;
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  getProcessedTidsCount(): number {
    return this.processedTids.size;
  }
}
