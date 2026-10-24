// Read existing bindings before deployment; never create a replacement database.
// Deployment entry is worker.js (the tested, quota-enforcing build).
// The desktop version lives in reference/desktop-version.js and is not deployed.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const WORKER_NAME = 'cf-worker-quota';
export const DEPLOY_ENTRY = '../worker.js';

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
    name: WORKER_NAME, main: DEPLOY_ENTRY, account_id: account,
    compatibility_date: '2026-09-30', keep_vars: true,
    ...(settings.compatibility_flags?.length ? { compatibility_flags: settings.compatibility_flags } : {}),
    d1_databases: databases.map(b => ({ binding: b.name, database_id: b.id }))
  };
}

// First-deploy bootstrap: when the Worker does not exist yet, there are no
// settings to read. If D1_DATABASE_ID is provided, generate a config from it
// instead of failing. The UUID variable must then be set in the dashboard
// (or via wrangler secret) before the Worker can serve traffic.
export function buildBootstrapConfig(account, databaseId) {
  if (!/^[a-f0-9-]{32,36}$/i.test(databaseId || '')) {
    throw new Error('D1_DATABASE_ID is not a valid D1 database ID.');
  }
  return {
    name: WORKER_NAME, main: DEPLOY_ENTRY, account_id: account,
    compatibility_date: '2026-09-30', keep_vars: true,
    d1_databases: [{ binding: 'D1', database_id: databaseId }]
  };
}

async function writeConfig(config) {
  await mkdir(new URL('../.deploy/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.deploy/wrangler.jsonc', import.meta.url), JSON.stringify(config, null, 2));
}

if (typeof process !== 'undefined' && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!token || !/^[a-f0-9]{32}$/i.test(account || '')) throw new Error('Cloudflare token and account ID are required.');
    const result = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${WORKER_NAME}/settings`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000)
    });
    if (result.status === 404) {
      const databaseId = process.env.D1_DATABASE_ID;
      if (databaseId) {
        await writeConfig(buildBootstrapConfig(account, databaseId));
        console.log('Worker does not exist yet; bootstrap config prepared from D1_DATABASE_ID.');
        console.log('After the first deploy, set the UUID variable in the Worker dashboard before serving traffic.');
      } else {
        throw new Error(
          `Worker '${WORKER_NAME}' does not exist yet. Create it first (bind a D1 database as 'D1' and set the UUID variable), ` +
          `or set the D1_DATABASE_ID variable to bootstrap the first deploy.`
        );
      }
    } else {
      if (!result.ok) throw new Error(`Cannot read existing Worker settings (HTTP ${result.status}).`);
      const data = await result.json();
      if (!data.success || !data.result) throw new Error('Cloudflare did not return Worker settings.');
      await writeConfig(buildConfig(data.result, account));
      console.log('Deployment config prepared using existing D1 bindings; dashboard variables will be preserved.');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
