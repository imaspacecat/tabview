import type { CloseResult, CloseTarget, RecoveryBatch, RestoreResult, TabRecord } from './types';

export interface RecoveryGateway {
  list(): Promise<TabRecord[]>;
  get(id: number): Promise<TabRecord>;
  remove(id: number): Promise<void>;
  reopen(tab: TabRecord, windowId: number): Promise<number>;
  load(): Promise<RecoveryBatch[]>;
  save(batches: RecoveryBatch[]): Promise<void>;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const canReopen = (status: string): boolean => status === 'closed' || status === 'uncertain';
export class RecoveryService {
  constructor(private gateway: RecoveryGateway) {}

  async reconcile(): Promise<void> {
    const batches = await this.gateway.load();
    if (!batches.some(batch => batch.entries.some(entry => entry.status === 'pending' || entry.status === 'reopening'))) return;
    const liveKeys = new Set((await this.gateway.list()).map(tab => tab.key));
    for (const entry of batches.flatMap(batch => batch.entries)) {
      if (entry.status === 'pending') {
        entry.status = liveKeys.has(entry.tab.key) ? 'failed' : 'uncertain';
        entry.error = entry.status === 'failed' ? 'Close was interrupted; the original tab is still open.' : 'Close was interrupted. Check whether this URL is already open before reopening.';
      } else if (entry.status === 'reopening') {
        entry.status = 'reopen-uncertain';
        entry.error = 'Reopening was interrupted; this URL may already be open. Check your tabs before opening it manually.';
      }
    }
    await this.gateway.save(batches);
  }

  async close(targets: CloseTarget[], includePinned: boolean, includeAudible: boolean): Promise<CloseResult> {
    const result: CloseResult = { closed: 0, skipped: 0, failed: 0, interrupted: false };
    const candidates: TabRecord[] = [];
    const canClose = (tab: TabRecord, target: CloseTarget) => tab.key === target.key && tab.url === target.url && (!tab.pinned || includePinned) && (!tab.audible || includeAudible);
    for (const target of new Map(targets.map(target => [target.id, target])).values()) {
      try {
        const tab = await this.gateway.get(target.id);
        if (!canClose(tab, target)) result.skipped++;
        else candidates.push(tab);
      } catch { result.skipped++; }
    }
    if (!candidates.length) return result;
    const batches = await this.gateway.load();
    const batch: RecoveryBatch = {
      id: crypto.randomUUID(), createdAt: Date.now(),
      entries: candidates.sort((a, b) => a.windowId - b.windowId || a.index - b.index).map(tab => ({ tab, status: 'pending' })),
    };
    batches.unshift(batch);
    batches.splice(20);
    await this.gateway.save(batches);
    for (const entry of batch.entries) {
      try {
        const live = await this.gateway.get(entry.tab.id);
        if (!canClose(live, entry.tab)) {
          entry.status = 'failed'; entry.error = 'Tab changed after the preview; it was kept open.'; result.skipped++;
        } else {
          await this.gateway.remove(entry.tab.id);
          entry.status = 'closed'; result.closed++;
        }
      } catch (error) { entry.status = 'failed'; entry.error = errorText(error); result.failed++; }
      try { await this.gateway.save(batches); }
      catch { result.interrupted = true; break; }
    }
    return result;
  }

  async restore(id: string, windowId: number): Promise<RestoreResult> {
    const batches = await this.gateway.load();
    const batch = batches.find(batch => batch.id === id);
    if (!batch) throw new Error('This recovery batch no longer exists.');
    const result: RestoreResult = { reopened: 0, failed: 0 };
    for (const entry of batch.entries) {
      if (!canReopen(entry.status)) continue;
      const previous = entry.status;
      entry.status = 'reopening';
      await this.gateway.save(batches);
      try {
        entry.reopenedTabId = await this.gateway.reopen(entry.tab, windowId);
        entry.status = 'reopened'; delete entry.error; result.reopened++;
      } catch (error) { entry.status = previous; entry.error = errorText(error); result.failed++; }
      await this.gateway.save(batches);
    }
    return result;
  }

  async delete(id: string): Promise<void> {
    const batches = await this.gateway.load();
    await this.gateway.save(batches.filter(batch => batch.id !== id));
  }
}
