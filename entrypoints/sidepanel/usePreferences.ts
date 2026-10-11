import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';

export type ViewMode = 'grid' | 'list';
export type ThumbnailSize = 'small' | 'medium' | 'large';
type Preferences = { view: ViewMode; thumbnailSize: ThumbnailSize; onboardingCompleted: boolean };
const defaults: Preferences = { view: 'grid', thumbnailSize: 'medium', onboardingCompleted: false };
const keys = {
  view: 'preferences:view',
  thumbnailSize: 'preferences:thumbnailSize',
  onboardingCompleted: 'preferences:onboardingCompleted',
} as const;
const fields = Object.keys(keys) as (keyof Preferences)[];

function normalize(values: Record<string, unknown>): Preferences {
  return {
    view: values[keys.view] === 'list' ? 'list' : 'grid',
    thumbnailSize: ['small', 'large'].includes(String(values[keys.thumbnailSize]))
      ? (values[keys.thumbnailSize] as ThumbnailSize)
      : 'medium',
    onboardingCompleted: values[keys.onboardingCompleted] === true,
  };
}

export function usePreferences() {
  const [preferences, setPreferences] = useState(defaults);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const touched = useRef(new Set<keyof Preferences>());
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const revision = useRef(0);
  useEffect(() => {
    let mounted = true;
    const changed = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      const updated = fields.filter((field) => keys[field] in changes);
      if (!updated.length) return;
      updated.forEach((field) => touched.current.add(field));
      const values = normalize(
        Object.fromEntries(updated.map((field) => [keys[field], changes[keys[field]]?.newValue])),
      );
      setPreferences((current) => ({
        ...current,
        ...Object.fromEntries(updated.map((field) => [field, values[field]])),
      }));
    };
    browser.storage.onChanged.addListener(changed);
    void browser.storage.local
      .get(Object.values(keys))
      .then((saved) => {
        if (!mounted) return;
        const values = normalize(saved);
        setPreferences((current) => ({
          ...values,
          ...Object.fromEntries(
            fields
              .filter((field) => touched.current.has(field))
              .map((field) => [field, current[field]]),
          ),
        }));
      })
      .catch(() => {
        if (mounted) setError('未能读取偏好，已使用默认设置。');
      })
      .finally(() => {
        if (mounted) setReady(true);
      });
    return () => {
      mounted = false;
      browser.storage.onChanged.removeListener(changed);
    };
  }, []);
  const update = (patch: Partial<Preferences>) => {
    const updated = fields.filter((field) => field in patch);
    updated.forEach((field) => touched.current.add(field));
    setPreferences((current) => ({ ...current, ...patch }));
    const request = ++revision.current;
    const save = () =>
      browser.storage.local.set(
        Object.fromEntries(updated.map((field) => [keys[field], patch[field]])),
      );
    writes.current = writes.current
      .then(save, save)
      .then(() => {
        if (request === revision.current) setError('');
      })
      .catch(() => {
        if (request === revision.current)
          setError('本次调整已生效，但未能保存；重新打开后可能恢复默认。');
      });
  };
  return { preferences, ready, error, update };
}

// Card heights and virtual row heights share the same measurements.
export const THUMBNAIL_LAYOUT = {
  small: { thumbnail: 84, gridCard: 192, listCard: 150, listWidth: 72 },
  medium: { thumbnail: 110, gridCard: 218, listCard: 150, listWidth: 90 },
  large: { thumbnail: 208, gridCard: 316, listCard: 170, listWidth: 120 },
} satisfies Record<ThumbnailSize, Record<string, number>>;
