/** Wires the server's state stream into the sentry store. Used once, by the authenticated app shell. */
import type { SentryStateView } from '@failover-sentry/contracts';
import { useRouter } from 'vue-router';
import { STREAM_URL } from '@/api/sentry-api';
import { useAuthStore } from '@/stores/auth';
import { useSentryStore } from '@/stores/sentry';
import { useEventSource, type UseEventSourceOptions } from './use-event-source';

interface StreamEvents {
  state: SentryStateView;
  unavailable: { running: false; workflowId: string; reason: string };
}

export function useSentryStream(
  options: Pick<UseEventSourceOptions<StreamEvents>, 'createEventSource'> = {},
) {
  const sentry = useSentryStore();
  const auth = useAuthStore();
  const router = useRouter();

  return useEventSource<StreamEvents>(STREAM_URL, {
    ...options,
    handlers: {
      state: (snapshot) => sentry.applySnapshot(snapshot),
      unavailable: (payload) => sentry.markUnavailable(payload.reason),
    },
    onStatusChange: (status) => sentry.setConnection(status === 'closed' ? 'idle' : status),
    // An EventSource can't see status codes: ask whether the session is still valid before reconnecting.
    shouldReconnect: async () => {
      const status = await auth.fetchMe().catch(() => 'authenticated' as const);
      if (status === 'anonymous') {
        await router.push({
          name: 'login',
          query: { returnTo: router.currentRoute.value.fullPath, error: 'expired' },
        });
        return false;
      }
      return true;
    },
  });
}
