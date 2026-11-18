/** Toast notifications, announced to screen readers through the toast region (aria-live). */
import { defineStore } from 'pinia';
import { ref } from 'vue';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  message: string | null;
}

const TIMEOUT_MS: Record<ToastTone, number> = { info: 5_000, success: 5_000, warning: 8_000, error: 10_000 };

export const useNotificationsStore = defineStore('notifications', () => {
  const toasts = ref<Toast[]>([]);
  let nextId = 1;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  function notify(tone: ToastTone, title: string, message: string | null = null): number {
    const id = nextId++;
    toasts.value = [...toasts.value.slice(-4), { id, tone, title, message }];
    timers.set(
      id,
      setTimeout(() => dismiss(id), TIMEOUT_MS[tone]),
    );
    return id;
  }

  return {
    toasts,
    notify,
    dismiss,
    success: (title: string, message?: string) => notify('success', title, message ?? null),
    info: (title: string, message?: string) => notify('info', title, message ?? null),
    warning: (title: string, message?: string) => notify('warning', title, message ?? null),
    error: (title: string, message?: string) => notify('error', title, message ?? null),
  };
});
