export interface Point { x: number; y: number }
export interface Rect { left: number; top: number; right: number; bottom: number }
export interface SelectionItem extends Rect { id: number }

export function selectionBounds(start: Point, end: Point): Rect {
  return { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y) };
}

export function intersectingIds(bounds: Rect, items: SelectionItem[]): number[] {
  return items.filter(item => item.right > bounds.left && item.left < bounds.right && item.bottom > bounds.top && item.top < bounds.bottom).map(item => item.id);
}

interface SelectionCallbacks {
  selected(): Set<number>;
  eligible(id: number): boolean;
  apply(ids: Set<number>): void;
  finished(dragged: boolean): void;
}

interface Gesture {
  pointerId: number;
  start: Point;
  client: Point;
  baseline: Set<number>;
  active: boolean;
  items: SelectionItem[];
  signature?: string;
}
export function installDragSelection(container: HTMLElement, callbacks: SelectionCallbacks) {
  const overlay = document.createElement('div');
  overlay.className = 'selection-box';
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  document.body.append(overlay);
  let gesture: Gesture | undefined;
  let frame = 0;
  let suppressClick = false;
  let clickTimer: ReturnType<typeof setTimeout>;

  function draw(): void {
    if (!gesture?.active) return;
    const end = { x: Math.max(0, Math.min(window.innerWidth, gesture.client.x)) + window.scrollX, y: Math.max(0, Math.min(window.innerHeight, gesture.client.y)) + window.scrollY };
    const bounds = selectionBounds(gesture.start, end);
    Object.assign(overlay.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.right - bounds.left}px`, height: `${bounds.bottom - bounds.top}px` });
    const hits = intersectingIds(bounds, gesture.items);
    const signature = hits.join(',');
    if (signature === gesture.signature) return;
    gesture.signature = signature;
    const ids = new Set(gesture.baseline);
    hits.forEach(id => { if (callbacks.eligible(id)) ids.add(id); });
    callbacks.apply(ids);
  }

  function tick(): void {
    if (!gesture?.active) return;
    const edge = 48;
    const y = gesture.client.y;
    const speed = y < edge ? -Math.ceil((edge - y) / 2) : y > window.innerHeight - edge ? Math.ceil((y - window.innerHeight + edge) / 2) : 0;
    if (speed && gesture.client.x >= 0 && gesture.client.x <= window.innerWidth) window.scrollBy(0, Math.max(-24, Math.min(24, speed)));
    draw();
    frame = window.requestAnimationFrame(tick);
  }

  function finish(cancel = false): void {
    if (!gesture) return;
    const ended = gesture;
    gesture = undefined;
    window.cancelAnimationFrame(frame);
    overlay.hidden = true;
    container.classList.remove('drag-selecting');
    if (ended.active) {
      suppressClick = true;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { suppressClick = false; }, 0);
      if (cancel) callbacks.apply(ended.baseline);
    }
    if (container.hasPointerCapture?.(ended.pointerId)) container.releasePointerCapture(ended.pointerId);
    callbacks.finished(ended.active && !cancel);
  }

  container.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.pointerType && event.pointerType !== 'mouse') || document.querySelector('dialog[open]')) return;
    if ((event.target as HTMLElement).closest('.group-heading')) return;
    gesture = { pointerId: event.pointerId, start: { x: event.clientX + window.scrollX, y: event.clientY + window.scrollY }, client: { x: event.clientX, y: event.clientY }, baseline: callbacks.selected(), active: false, items: [] };
  });
  document.addEventListener('pointermove', event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.client = { x: event.clientX, y: event.clientY };
    if (!gesture.active) {
      const distance = Math.hypot(event.clientX + window.scrollX - gesture.start.x, event.clientY + window.scrollY - gesture.start.y);
      if (distance < 6) return;
      gesture.items = [...container.querySelectorAll<HTMLElement>('.tab-row, .domain-card')].flatMap(row => {
        const ids = (row.dataset.ids ?? row.dataset.id ?? '').split(',').filter(Boolean).map(Number).filter(id => callbacks.eligible(id));
        const rect = row.getBoundingClientRect();
        return ids.map(id => ({ id, left: rect.left + window.scrollX, right: rect.right + window.scrollX, top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY }));
      });
      gesture.active = true;
      container.setPointerCapture?.(event.pointerId);
      container.classList.add('drag-selecting');
      overlay.hidden = false;
      frame = window.requestAnimationFrame(tick);
    }
    event.preventDefault();
    draw();
  }, { passive: false });
  document.addEventListener('pointerup', event => {
    if (gesture?.pointerId !== event.pointerId) return;
    gesture.client = { x: event.clientX, y: event.clientY };
    draw(); finish();
  });
  document.addEventListener('pointercancel', event => { if (gesture?.pointerId === event.pointerId) finish(true); });
  container.addEventListener('lostpointercapture', () => { finish(true); });
  container.addEventListener('dragstart', event => { event.preventDefault(); });
  container.addEventListener('click', event => {
    if (!suppressClick) return;
    event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false;
  }, true);
  window.addEventListener('blur', () => { finish(true); });
  window.addEventListener('resize', () => { finish(true); });
  window.addEventListener('pagehide', () => { finish(true); }, { once: true });
  return { pending: () => gesture !== undefined, cancel: () => finish(true) };
}
