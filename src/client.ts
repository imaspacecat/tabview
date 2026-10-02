import type { Request, Response } from './types';

export async function request<T>(message: Request): Promise<T> {
  const response: Response<T> = await browser.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'The extension background is unavailable. Try reopening Tabview.');
  return response.value;
}

export function subscribe(callback: () => void): () => void {
  let port: browser.runtime.Port;
  let closed = false;
  let timer: ReturnType<typeof setTimeout>;
  function connect(): void {
    if (closed) return;
    port = browser.runtime.connect({ name: 'tabview' });
    port.onMessage.addListener(callback);
    port.onDisconnect.addListener(() => { if (!closed) timer = setTimeout(() => { connect(); callback(); }, 500); });
  }
  connect();
  return () => { closed = true; clearTimeout(timer); port?.disconnect(); };
}
