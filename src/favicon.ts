export function faviconSource(url: string | undefined, fallback: string): string {
  if (!url) return fallback;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
    if (parsed.protocol === 'data:' && /^data:image\//i.test(url)) return url;
    if (parsed.protocol === 'moz-extension:' && url.startsWith(new URL('.', fallback).href)) return parsed.href;
  } catch {}
  return fallback;
}
