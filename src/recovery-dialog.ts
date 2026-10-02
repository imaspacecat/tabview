import { request } from './client';
import { create, element } from './dom';
import { canReopen } from './recovery';
import type { RecoveryBatch, RestoreResult } from './types';

interface RecoveryCallbacks {
  busy(): boolean;
  setBusy(busy: boolean): void;
  windowId(): number;
  refresh(): Promise<void>;
}

export function installRecovery(callbacks: RecoveryCallbacks): void {
  const recoveryDialog = element<HTMLDialogElement>('recovery-dialog');
  recoveryDialog.addEventListener('cancel', event => { if (callbacks.busy()) event.preventDefault(); });
  async function renderRecovery(): Promise<void> {
    const list = element('recovery-list');
    const batches = await request<RecoveryBatch[]>({ type: 'recovery' });
    list.replaceChildren();
    if (!batches.length) list.append(create('p', {}, 'No recovery batches yet.'));
    for (const batch of batches) {
      const available = batch.entries.filter(entry => canReopen(entry.status)).length;
      const reopened = batch.entries.filter(entry => entry.status === 'reopened').length;
      const reopen = create('button', { disabled: !available || callbacks.busy() }, `Reopen ${available} tabs`);
      const remove = create('button', { disabled: callbacks.busy() }, 'Delete record');
      const block = create('section', { className: 'recovery-batch' },
        create('h3', {}, new Date(batch.createdAt).toLocaleString()),
        create('p', {}, `${available} available · ${reopened} reopened · ${batch.entries.length} recorded`));
      if (batch.entries.some(entry => entry.status === 'uncertain')) block.append(create('p', {}, 'An interrupted close has an uncertain outcome. Check for existing tabs before reopening.'));
      block.append(create('details', {}, create('summary', {}, 'View tabs'),
        create('ul', { className: 'preview-list' }, ...batch.entries.map(entry => create('li', { title: entry.tab.url }, `${entry.tab.title} — ${entry.status}${entry.error ? `: ${entry.error}` : ''}`)))),
        create('div', { className: 'dialog-actions' }, reopen, remove));
      reopen.addEventListener('click', async () => {
        if (callbacks.busy()) return;
        callbacks.setBusy(true); list.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
        const output = element('recovery-status'); output.textContent = 'Reopening…';
        try {
          const result = await request<RestoreResult>({ type: 'restore', id: batch.id, windowId: callbacks.windowId() });
          output.textContent = `${result.reopened} reopened · ${result.failed} failed. View tabs for details.`;
        } catch (error) { output.textContent = String(error); }
        finally { callbacks.setBusy(false); await renderRecovery().catch(error => { output.textContent = String(error); }); await callbacks.refresh(); }
      });
      remove.addEventListener('click', async () => {
        if (callbacks.busy()) return;
        remove.disabled = true;
        try { await request({ type: 'delete-batch', id: batch.id }); await renderRecovery(); }
        catch (error) { element('recovery-status').textContent = String(error); remove.disabled = false; }
      });
      list.append(block);
    }
  }
  element('recovery-open').addEventListener('click', async () => {
    element('recovery-status').textContent = ''; recoveryDialog.showModal();
    try { await renderRecovery(); } catch (error) { element('recovery-status').textContent = String(error); }
  });
}
