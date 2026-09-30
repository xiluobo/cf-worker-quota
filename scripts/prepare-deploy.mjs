// Read existing bindings before deployment; never create a replacement database.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function buildConfig(settings, account) {
  const bindings = settings.bindings || [];
  const unsupported = bindings.filter(b => !['d1', 'plain_text', 'secret_text'].includes(b.type));
  if (unsupported.length) throw new Error('Existing Worker has additional bindings; reconcile its configuration before deploying.');
  const databases = bindings.filter(b => b.type === 'd1');
  const db = databases.find(b => b.name === 'D1');
  if (!db?.id) throw new Error('Bind the original database as D1 before deployment.');
  if (!bindings.some(b => ['UUID', 'uuid'].includes(b.name) && ['plain_text','secret_text'].includes(b.type))) {
    throw new Error('Configure the original UUID in the Worker environment before deployment.');
  }
  return {
    name: 'cf-worker-quota', main: '../worker.js', account_id: account,
    compatibility_date: '2026-09-30', keep_vars: true,
    ...(settings.compatibility_flags?.length ? { compatibility_flags: settings.compatibility_flags } : {}),
    d1_databases: databases.map(b => ({ binding: b.name, database_id: b.id }))
  };
}

if (typeof process !== 'undefined' && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!token || !/^[a-f0-9]{32}$/i.test(account || '')) throw new Error('Cloudflare token and account ID are required.');
    const result = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/cf-worker-quota/settings`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000)
    });
    if (!result.ok) throw new Error(`Cannot read existing Worker settings (HTTP ${result.status}).`);
    const data = await result.json();
    if (!data.success || !data.result) throw new Error('Cloudflare did not return Worker settings.');
    const config = buildConfig(data.result, account);
    await mkdir(new URL('../.deploy/', import.meta.url), { recursive: true });
    await writeFile(new URL('../.deploy/wrangler.jsonc', import.meta.url), JSON.stringify(config, null, 2));
    console.log('Deployment config prepared using existing D1 bindings; dashboard variables will be preserved.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
