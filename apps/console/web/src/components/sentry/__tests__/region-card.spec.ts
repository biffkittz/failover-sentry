import { mount, RouterLinkStub } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import RegionCard from '@/components/sentry/region-card.vue';
import { region } from '@/__tests__/fixtures';

function mountCard(props: InstanceType<typeof RegionCard>['$props']) {
  return mount(RegionCard, { props, global: { stubs: { RouterLink: RouterLinkStub } } });
}

describe('RegionCard', () => {
  it('shows role, health and database facts in words, not only colours', () => {
    const wrapper = mountCard({ region: region('east'), probes: [] });
    expect(wrapper.text()).toContain('Primary');
    expect(wrapper.text()).toContain('Healthy');
    expect(wrapper.text()).toContain('primary · epoch 3');
    expect(wrapper.find('[role="img"]').exists()).toBe(false);
  });

  it('offers recovery for a stopped standby and emits the region id', async () => {
    const wrapper = mountCard({ region: region('west', { compute: 'stopped' }), probes: [] });
    const button = wrapper.findAll('button').find((candidate) => candidate.text().includes('Recover region'));
    expect(button).toBeDefined();
    await button?.trigger('click');
    expect(wrapper.emitted('recover')).toEqual([['west']]);
  });

  it('renders a sparkline with a text alternative when probes exist', () => {
    const probe = region('west').health?.lastProbe;
    const wrapper = mountCard({
      region: region('west'),
      probes: probe ? [probe, { ...probe, ok: false, error: 'HTTP 503' }] : [],
    });
    const svg = wrapper.find('svg[role="img"]');
    expect(svg.attributes('aria-label')).toContain('2 probes, 1 failed');
  });
});
