import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/http';
import { sentryApi } from '@/api/sentry-api';
import ManualFailoverDialog from '@/components/sentry/manual-failover-dialog.vue';
import { useSentryStore } from '@/stores/sentry';
import { sentryState } from '@/__tests__/fixtures';

const push = vi.fn();

/** VeeValidate validates on a macrotask, so let a few timers and promises run. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await flushPromises();
  }
}
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }));

describe('ManualFailoverDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useSentryStore().applySnapshot(sentryState());
    push.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function mountDialog() {
    return mount(ManualFailoverDialog, { props: { open: true }, attachTo: document.body });
  }

  it('validates the reason and the FORCE confirmation before calling the sentry', async () => {
    const trigger = vi.spyOn(sentryApi, 'triggerFailover');
    const wrapper = mountDialog();
    await settle();
    const form = document.querySelector('form');
    form?.dispatchEvent(new Event('submit'));
    await settle();
    expect(document.body.textContent).toContain('Say briefly why');
    expect(trigger).not.toHaveBeenCalled();

    const forced = document.querySelector<HTMLInputElement>('input[value="forced"]');
    forced?.click();
    forced?.dispatchEvent(new Event('change'));
    const reason = document.querySelector<HTMLTextAreaElement>('#failover-reason');
    if (reason) {
      reason.value = 'East is on fire';
      reason.dispatchEvent(new Event('input'));
    }
    await settle();
    form?.dispatchEvent(new Event('submit'));
    await settle();
    expect(document.body.textContent).toContain('Type FORCE to confirm');
    expect(trigger).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('starts the failover and opens its page; shows the sentry refusing otherwise', async () => {
    const trigger = vi
      .spyOn(sentryApi, 'triggerFailover')
      .mockResolvedValueOnce({
        failoverId: 'fo-9',
        epoch: 4,
        fromRegionId: 'east',
        toRegionId: 'west',
        mode: 'planned',
      })
      .mockRejectedValueOnce(new ApiError(409, 'rejected', 'A failover is already in progress'));
    const wrapper = mountDialog();
    await settle();
    const reason = document.querySelector<HTMLTextAreaElement>('#failover-reason');
    if (reason) {
      reason.value = 'Game day drill';
      reason.dispatchEvent(new Event('input'));
    }
    await settle();
    document.querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
    expect(trigger).toHaveBeenCalledWith({ mode: 'planned', reason: 'Game day drill' });
    expect(push).toHaveBeenCalledWith({ name: 'failover', params: { failoverId: 'fo-9' } });
    expect(wrapper.emitted('close')).toHaveLength(1);

    document.querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
    expect(document.body.textContent).toContain('The sentry refused: A failover is already in progress');
    wrapper.unmount();
  });
});
