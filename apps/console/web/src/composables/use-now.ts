/**
 * A shared, reactive "now" for relative times ("12 s ago"). One interval serves every component; it stops when the
 * last one unmounts.
 */
import { onScopeDispose, readonly, ref, type Ref } from 'vue';

const now = ref(Date.now());
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export function useNow(): Readonly<Ref<number>> {
  subscribers += 1;
  if (!timer) {
    now.value = Date.now();
    timer = setInterval(() => {
      now.value = Date.now();
    }, 1_000);
  }
  onScopeDispose(() => {
    subscribers -= 1;
    if (subscribers === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  });
  return readonly(now);
}
