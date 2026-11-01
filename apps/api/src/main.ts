import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultDist = path.resolve(here, '../../web/dist');
const config = loadConfig({ webDistDir: process.env.WEB_DIST_DIR ?? (fs.existsSync(defaultDist) ? defaultDist : null) });
const app = createApp(config);
const port = await app.listen();
console.log(JSON.stringify({ level: 'info', msg: 'texflow api listening', port, env: config.env, web: config.webDistDir ? 'served' : 'not built' }));

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (stopping) return; stopping = true;
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down', sig }));
    const t = setTimeout(() => process.exit(1), 10_000);
    await app.close(); clearTimeout(t); process.exit(0);
  });
}
