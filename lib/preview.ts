export type PreviewState = {
  status: 'waiting' | 'loading' | 'ready' | 'failed';
  width: number;
  height: number;
};
type Entry = {
  url: string;
  state: PreviewState;
  listeners: Set<(state: PreviewState) => void>;
  image?: HTMLImageElement;
  timer?: ReturnType<typeof setTimeout>;
};
const entries = new Map<string, Entry>();
const pending: Entry[] = [];
let active = 0;
const notify = (entry: Entry) =>
  entry.listeners.forEach((listener) => listener({ ...entry.state }));
function finish(entry: Entry, success: boolean) {
  if (!entry.image) return;
  entry.state = {
    status: success ? 'ready' : 'failed',
    width: success ? entry.image.naturalWidth : 0,
    height: success ? entry.image.naturalHeight : 0,
  };
  clearTimeout(entry.timer);
  entry.image.onload = null;
  entry.image.onerror = null;
  if (!success) entry.image.removeAttribute('src');
  entry.image = undefined;
  active--;
  notify(entry);
  pump();
}
function pump() {
  while (active < 6 && pending.length) {
    const entry = pending.shift()!;
    if (!entry.listeners.size || entry.state.status !== 'waiting') continue;
    entry.state = { status: 'loading', width: 0, height: 0 };
    const image = new Image();
    entry.image = image;
    active++;
    image.referrerPolicy = 'no-referrer';
    image.onload = () => finish(entry, true);
    image.onerror = () => finish(entry, false);
    entry.timer = setTimeout(() => finish(entry, false), 15_000);
    notify(entry);
    image.src = entry.url;
  }
}
export function subscribePreview(url: string, listener: (state: PreviewState) => void): () => void {
  let entry = entries.get(url);
  if (!entry) {
    entry = { url, state: { status: 'waiting', width: 0, height: 0 }, listeners: new Set() };
    entries.set(url, entry);
    pending.push(entry);
  }
  entry.listeners.add(listener);
  listener({ ...entry.state });
  pump();
  return () => {
    entry!.listeners.delete(listener);
    if (!entry!.listeners.size && ['waiting', 'loading'].includes(entry!.state.status)) {
      const index = pending.indexOf(entry!);
      if (index >= 0) pending.splice(index, 1);
      if (entry!.image) finish(entry!, false);
      entries.delete(url);
    }
    if (entries.size > 1000) {
      for (const [key, item] of entries)
        if (!item.listeners.size) {
          entries.delete(key);
          if (entries.size <= 1000) break;
        }
    }
  };
}
export function retryPreview(url: string) {
  const entry = entries.get(url);
  if (!entry || entry.state.status !== 'failed') return;
  entry.state = { status: 'waiting', width: 0, height: 0 };
  pending.push(entry);
  notify(entry);
  pump();
}
