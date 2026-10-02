import type { SelectionItem } from './selection';

export function directionalNeighbor(id: number, items: SelectionItem[], direction: 'up' | 'down' | 'left' | 'right'): number {
  const current = items.find(item => item.id === id);
  if (!current) return items[0]?.id ?? id;
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'up' || direction === 'left' ? -1 : 1;
  const cx = (current.left + current.right) / 2;
  const cy = (current.top + current.bottom) / 2;
  const candidates = items.filter(item => item.id !== id).map(item => {
    const dx = (item.left + item.right) / 2 - cx;
    const dy = (item.top + item.bottom) / 2 - cy;
    const along = (vertical ? dy : dx) * sign;
    const cross = Math.abs(vertical ? dx : dy);
    const aligned = vertical ? item.left < current.right && item.right > current.left : item.top < current.bottom && item.bottom > current.top;
    return { id: item.id, along, cross, aligned };
  }).filter(item => item.along > 1);
  const aligned = candidates.filter(item => item.aligned);
  const pool = aligned.length ? aligned : candidates;
  pool.sort((a, b) => a.along + a.cross * 2 - (b.along + b.cross * 2));
  return pool[0]?.id ?? id;
}
