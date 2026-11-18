import type { RegionalHealthResponse } from '@failover-sentry/contracts';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/** The demo storefront: shows which region served the request and what its database thinks it is. */
export function renderStorefront(input: { regionName: string; health: RegionalHealthResponse }): string {
  const { regionName, health } = input;
  const region = escapeHtml(regionName);
  const role = health.db.role === 'primary' ? 'Primary (read-write)' : 'Replica (read-only)';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kittz Supply Co. · ${region}</title>
<style>
  :root { color-scheme: light dark; --accent: #2563eb; }
  body { font-family: system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; }
  main { max-width: 34rem; padding: 2rem; border-radius: 1rem; border: 1px solid #8884; }
  h1 { margin-top: 0; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; }
  dt { font-weight: 600; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; background: var(--accent); color: #fff; }
</style>
</head>
<body>
<main>
  <h1>Kittz Supply Co.</h1>
  <p>Served from <span class="badge">${region}</span></p>
  <dl>
    <dt>Region</dt><dd>${escapeHtml(health.regionId)}</dd>
    <dt>Database</dt><dd>${escapeHtml(role)}</dd>
    <dt>Epoch</dt><dd>${health.db.epoch}</dd>
    <dt>Log position</dt><dd>${health.db.appliedLsn}</dd>
    <dt>Version</dt><dd>${escapeHtml(health.version)}</dd>
  </dl>
  <p><small>A demo workload protected by the Failover Sentry.</small></p>
</main>
</body>
</html>`;
}
