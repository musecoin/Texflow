/**
 * Web build: esbuild (TS/TSX → one ESM bundle) + Tailwind v4 (compile API, candidates
 * scanned from the source). Output: apps/web/dist, served by the API in production and
 * copied into the Capacitor Android project.
 *   node apps/web/build.mjs            production build
 *   node apps/web/build.mjs --watch    rebuild on change
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { compile } from 'tailwindcss';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, 'src');
const out = path.join(root, 'dist');
const twDir = path.dirname(fileURLToPath(import.meta.resolve('tailwindcss'))).replace(/[/\\]dist$/, '');

function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)])); }

async function buildCss() {
  const input = fs.readFileSync(path.join(src, 'styles.css'), 'utf8');
  const compiler = await compile(input, {
    base: src,
    loadStylesheet: async (id, base) => {
      const file = id === 'tailwindcss' ? path.join(twDir, 'index.css') : id.startsWith('tailwindcss/') ? path.join(twDir, id.slice(12)) : path.resolve(base, id);
      return { content: fs.readFileSync(file, 'utf8'), base: path.dirname(file), path: file };
    },
  });
  const candidates = new Set();
  for (const f of walk(src).filter((f) => /\.(tsx?|html)$/.test(f))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/[^\s"'`<>{}()=,;]+/g)) candidates.add(m[0]);
  }
  return compiler.build([...candidates]);
}

async function build() {
  const t0 = Date.now();
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(src, 'main.tsx')], bundle: true, format: 'esm', target: ['chrome100', 'safari15', 'firefox100'],
    outfile: path.join(out, 'assets', 'app.js'), minify: true, sourcemap: true, jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' }, legalComments: 'none',
  });
  fs.writeFileSync(path.join(out, 'assets', 'app.css'), await buildCss());
  fs.copyFileSync(path.join(root, 'index.html'), path.join(out, 'index.html'));
  for (const f of fs.readdirSync(path.join(root, 'public'))) fs.copyFileSync(path.join(root, 'public', f), path.join(out, f));
  const size = (f) => (fs.statSync(path.join(out, 'assets', f)).size / 1024).toFixed(0) + ' KB';
  console.log(`web built in ${Date.now() - t0} ms → dist/ (app.js ${size('app.js')}, app.css ${size('app.css')})`);
}

await build();
if (process.argv.includes('--watch')) {
  let timer;
  fs.watch(src, { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(() => build().catch((e) => console.error(e.message)), 150); });
  console.log('watching apps/web/src …');
}
