import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import FailoverStepper from '@/components/sentry/failover-stepper.vue';
import { failoverRun } from '@/__tests__/fixtures';

describe('FailoverStepper', () => {
  it('lists every step in order and marks the running one as current', () => {
    const wrapper = mount(FailoverStepper, { props: { run: failoverRun() } });
    const steps = wrapper.findAll('li');
    expect(steps).toHaveLength(10);
    expect(steps[0]?.text()).toContain('Pre-flight checks');
    expect(steps[0]?.text()).toContain('west answers in 40 ms');
    const current = wrapper.find('[aria-current="step"]');
    expect(current.text()).toContain('Await replication webhook');
    expect(current.text()).toContain('In progress');
  });
});
