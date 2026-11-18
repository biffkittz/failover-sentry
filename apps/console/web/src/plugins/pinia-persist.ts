/**
 * A small Pinia plugin: stores that declare `persist: { key, pick }` keep those state keys in localStorage. Only for
 * harmless UI preferences; tokens never go to localStorage (they live in HTTP-only cookies).
 */
import type { PiniaPluginContext } from 'pinia';

export interface PersistOptions {
  key: string;
  pick: string[];
}

declare module 'pinia' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the generics must match Pinia's declaration
  export interface DefineStoreOptionsBase<S, Store> {
    persist?: PersistOptions;
  }
}

export function persistPlugin({ store, options }: PiniaPluginContext): void {
  const persist = options.persist;
  if (!persist || typeof localStorage === 'undefined') {
    return;
  }
  try {
    const saved = localStorage.getItem(persist.key);
    if (saved) {
      const parsed = JSON.parse(saved) as Record<string, unknown>;
      store.$patch((state) => {
        for (const [key, value] of Object.entries(parsed)) {
          if (persist.pick.includes(key)) {
            (state as Record<string, unknown>)[key] = value;
          }
        }
      });
    }
  } catch {
    localStorage.removeItem(persist.key);
  }
  store.$subscribe((_mutation, state) => {
    const picked = Object.fromEntries(
      persist.pick.map((key) => [key, (state as Record<string, unknown>)[key]]),
    );
    localStorage.setItem(persist.key, JSON.stringify(picked));
  });
}
