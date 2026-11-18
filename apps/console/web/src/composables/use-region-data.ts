/**
 * Server data about one region, through TanStack Query: cached, revalidated in the background, and cancelled when
 * the region changes or the component unmounts (Query passes an AbortSignal to the fetcher).
 */
import type { ChaosSettings, ChaosUpdate } from '@failover-sentry/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { sentryApi } from '@/api/sentry-api';

export const regionKeys = {
  monitor: (regionId: string) => ['region', regionId, 'monitor'] as const,
  chaos: (regionId: string) => ['region', regionId, 'chaos'] as const,
};

/** The region monitor's probe history (polled while visible). */
export function useRegionMonitor(regionId: MaybeRefOrGetter<string>) {
  return useQuery({
    queryKey: computed(() => regionKeys.monitor(toValue(regionId))),
    queryFn: ({ signal }) => sentryApi.monitor(toValue(regionId), signal),
    refetchInterval: 5_000,
    retry: 1,
  });
}

export function useChaosSettings(regionId: MaybeRefOrGetter<string>) {
  return useQuery({
    queryKey: computed(() => regionKeys.chaos(toValue(regionId))),
    queryFn: ({ signal }) => sentryApi.chaos(toValue(regionId), signal),
    staleTime: 10_000,
  });
}

/** Applies chaos settings optimistically; on failure the previous settings come back. */
export function useUpdateChaos(regionId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: ChaosUpdate) => sentryApi.updateChaos(toValue(regionId), update),
    onMutate: async (update) => {
      const key = regionKeys.chaos(toValue(regionId));
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ChaosSettings>(key);
      if (previous) {
        queryClient.setQueryData<ChaosSettings>(key, { ...previous, ...update });
      }
      return { previous };
    },
    onError: (_error, _update, context) => {
      if (context?.previous) {
        queryClient.setQueryData(regionKeys.chaos(toValue(regionId)), context.previous);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: regionKeys.chaos(toValue(regionId)) }),
  });
}
