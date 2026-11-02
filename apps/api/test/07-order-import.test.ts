import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setup, expectStatus, rawPost, PASSWORD, type Harness } from './helpers.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

// ---- fake Messages API: records requests, answers according to `mode`
let mode: 'ok' | 'garbage' | 'notool' | 'upstream500' = 'ok';
const seen: { headers: http.IncomingHttpHeaders; body: any }[] = [];
const SHEET = {
  customer: 'DYNAMIC', partyNo: '1092', modelCode: '288-PNT', modelName: 'LYC 2IP PACA RECME PNT', productType: 'PANTOLON', fabric: 'LYC 2IP PACA RECME PNT',
  composition: '%92 pamuk, %8 elastan', labelBrand: 'sportline', cuttingDate: '2026-10-13', dueDate: null, workshop: null,
  notes: ['1 çuval 64lük', 'bedenler ayrı ayrı paketlenecek', 'baskı renkleri için yetkili onayı alınsın'], decorations: ['CROSS', 'REFLECTOR'],
  sizes: [{ size: 'L', ratio: 1 }, { size: 'XL', ratio: 1 }, { size: 'XXL', ratio: 1 }, { size: 'XXXL', ratio: 1 }],
  sections: [
    { title: 'ADET', kind: 'cut', printedTotal: 1496, lines: [{ color: 'siyah', size: null, quantity: 240, uncertain: false }, { color: 'laci', size: null, quantity: 624, uncertain: false }, { color: 'siyah', size: null, quantity: 632, uncertain: false }] },
    { title: 'İSTENEN PANTOLON RENK ORANTISI', kind: 'requested', printedTotal: 1420, lines: [{ color: 'SİYAH', size: null, quantity: 810, uncertain: false }, { color: 'LACİ', size: null, quantity: 610, uncertain: false }] },
  ],
  measurements: [{ name: 'EN', values: [{ size: 'L', value: 76 }, { size: 'XL', value: 80 }] }],
  uncertainties: ['Toplam satırında MONT ADET yazıyor, ürün pantolon.'],
};
const fake = http.createServer(async (req, res) => {
  let raw = ''; for await (const ch of req) raw += ch;
  seen.push({ headers: req.headers, body: JSON.parse(raw) });
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (mode === 'upstream500') return send(500, { type: 'error', error: { type: 'api_error', message: 'Overloaded' } });
  const content = mode === 'notool' ? [{ type: 'text', text: 'Okuyamadım' }]
    : [{ type: 'thinking', thinking: '…' }, { type: 'tool_use', id: 'toolu_1', name: 'record_order_sheet', input: mode === 'garbage' ? { sections: 'yok' } : SHEET }];
  send(200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: 'tool_use', usage: { input_tokens: 1800, output_tokens: 900 } });
});

let h: Harness; let fakeUrl = '';
const KEY = 'sk-test-SECRET-should-never-leak';
const IMG = { mediaType: 'image/jpeg', imageBase64: Buffer.alloc(3000, 7).toString('base64') };

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  h = await setup({ ai: { apiKey: KEY, model: 'claude-sonnet-5-5', baseUrl: fakeUrl, perHour: 8, timeoutMs: 5000 } });
});
after(async () => { await h?.close(); fake.closeAllConnections(); await new Promise((r) => fake.close(r)); });

test('photo import: reads the sheet, matches master data, runs deterministic checks — and creates no records', async () => {
  const plan = await h.login('A', 'admin');
  const o = await h.owner();
  await o.query("SELECT set_config('app.org_id', $1, false)", [h.a.orgId]);
  const ordersBefore = (await o.query<{ n: number }>('SELECT count(*)::int AS n FROM sales_order')).rows[0].n;

  mode = 'ok';
  const d = expectStatus(await plan.post('/api/v1/orders/import/extract', IMG), 200);
  // request sent to the AI service
  const call = seen.at(-1)!;
  assert.equal(call.headers['x-api-key'], KEY);
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.body.model, 'claude-sonnet-5-5');
  assert.equal(call.body.tool_choice, undefined, 'forced tool_choice is rejected by current models');
  assert.equal(call.body.messages[0].content[0].type, 'image');
  assert.equal(call.body.messages[0].content[0].source.data, IMG.imageBase64);
  // matching: abbreviations and Turkish case, unknown values flagged
  const col = Object.fromEntries(d.matches.colors.map((m: any) => [m.written, m.colorId]));
  assert.equal(col.siyah, h.a.colors.SYH);
  assert.equal(col.laci, h.a.colors.LCV);
  const sz = Object.fromEntries(d.matches.sizes.map((m: any) => [m.written, m.sizeId]));
  assert.equal(sz.L, h.a.sizes.L); assert.equal(sz.XL, h.a.sizes.XL);
  assert.equal(sz.XXL, null); assert.equal(sz['3XL'], null, 'XXXL normalised to 3XL');
  assert.equal(d.matches.model.modelId, null);
  const codes = d.checks.map((c: any) => c.code);
  for (const c of ['TOTAL_OK', 'DUPLICATE_LINE', 'CUT_VS_REQUESTED', 'RATIO_REMAINDER', 'DUE_DATE_MISSING', 'SIZE_UNKNOWN', 'MODEL_UNKNOWN', 'AI_NOTE']) assert.ok(codes.includes(c), c);
  assert.ok(!codes.includes('TOTAL_MISMATCH'));
  assert.match(d.checks.find((c: any) => c.code === 'CUT_VS_REQUESTED').text, /\+76/);
  // nothing was created; the read is audited without the image
  assert.equal((await o.query<{ n: number }>('SELECT count(*)::int AS n FROM sales_order')).rows[0].n, ordersBefore);
  const a = (await o.query<{ after_state: any }>(`SELECT after_state FROM audit_event WHERE action = 'order.import.extract' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(a.after_state.modelCode, '288-PNT');
  assert.deepEqual(a.after_state.usage, { inputTokens: 1800, outputTokens: 900 });
  assert.ok(!JSON.stringify(a.after_state).includes(IMG.imageBase64.slice(0, 40)));
  await o.end();
});

test('photo import: AI failures are reported honestly; key never leaks; permissions and validation enforced', async () => {
  const admin = await h.login('A', 'admin');
  for (const m of ['garbage', 'notool', 'upstream500'] as const) {
    mode = m;
    const r = await admin.post('/api/v1/orders/import/extract', IMG);
    const b = expectStatus(r, 502, 'AI_FAILED');
    assert.ok(!JSON.stringify(b).includes('SECRET'), 'API key must not appear in errors');
  }
  mode = 'ok';
  expectStatus(await (await h.login('A', 'depo')).post('/api/v1/orders/import/extract', IMG), 403, 'FORBIDDEN');
  expectStatus(await admin.post('/api/v1/orders/import/extract', { mediaType: 'image/gif', imageBase64: IMG.imageBase64 }), 400, 'VALIDATION_FAILED');
  expectStatus(await admin.post('/api/v1/orders/import/extract', { mediaType: 'image/jpeg', imageBase64: '<script>'.repeat(30) }), 400, 'VALIDATION_FAILED');
  assert.deepEqual(expectStatus(await admin.get('/api/v1/orders/import/status'), 200), { enabled: true, model: 'claude-sonnet-5-5', perHour: 8 });

  // a server without a key: feature reported as disabled, extract refused with a clear code
  const off = createApp(loadConfig({ appDatabaseUrl: process.env.TEST_APP_DATABASE_URL, apiRatePerMin: 100_000, loginRatePerMin: 1000, webDistDir: null, corsOrigins: [],
    ai: { apiKey: null, model: 'x', baseUrl: fakeUrl, perHour: 5, timeoutMs: 1000 } }));
  const port = await off.listen(0, '127.0.0.1');
  try {
    const lr = await rawPost(`http://127.0.0.1:${port}`, '/api/v1/auth/login', { organizationCode: 'ACME', email: h.a.users.admin.email, password: PASSWORD });
    const tok = lr.body.accessToken;
    const st = await fetch(`http://127.0.0.1:${port}/api/v1/orders/import/status`, { headers: { authorization: 'Bearer ' + tok } });
    assert.equal((await st.json()).enabled, false);
    const ex = await fetch(`http://127.0.0.1:${port}/api/v1/orders/import/extract`, { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify(IMG) });
    assert.equal(ex.status, 503);
    assert.equal((await ex.json()).error.code, 'AI_NOT_CONFIGURED');
  } finally { await off.close(); }
});

test('photo import → full flow: add missing sizes, create model, create DRAFT order from the reviewed draft', async () => {
  const admin = await h.login('A', 'admin');
  const plan = await h.login('A', 'planlama');
  expectStatus(await plan.post('/api/v1/sizes', { code: 'XXL' }), 403, 'FORBIDDEN');
  const xxl = expectStatus(await admin.post('/api/v1/sizes', { code: 'xxl' }), 201);
  const x3 = expectStatus(await admin.post('/api/v1/sizes', { code: 'XXXL' }), 201);
  assert.equal(x3.code, '3XL');
  assert.ok(x3.sortOrder > xxl.sortOrder);
  expectStatus(await admin.post('/api/v1/sizes', { code: '3XL' }), 409);
  const gri = expectStatus(await admin.post('/api/v1/colors', { code: 'gri', name: 'Gri' }), 201);
  assert.equal(gri.code, 'GRI');

  mode = 'ok';
  const d = expectStatus(await admin.post('/api/v1/orders/import/extract', IMG), 200);
  assert.ok(d.matches.sizes.every((m: any) => m.sizeId), 'all sizes now match');
  const sizeIds = d.matches.sizes.map((m: any) => m.sizeId);
  const colorIds = d.matches.colors.map((m: any) => m.colorId);
  const model = expectStatus(await admin.post('/api/v1/models', { code: '288-PNT', name: d.extraction.modelName, productType: 'Pantolon', colorIds, sizeIds }), 201);
  const again = expectStatus(await admin.post('/api/v1/orders/import/extract', IMG), 200);
  assert.equal(again.matches.model.modelId, model.id);
  assert.equal(again.matches.model.variants.length, colorIds.length * sizeIds.length);
  // the user resolved remainders (202+202+203+203 = 810) and entered a due date
  const q: Record<string, number[]> = { siyah: [202, 202, 203, 203], laci: [152, 152, 153, 153] };
  const lines = d.matches.colors.flatMap((c: any) => d.matches.sizes.map((s: any, i: number) => ({ modelId: model.id, colorId: c.colorId, sizeId: s.sizeId, quantity: String(q[c.written][i]), unitPrice: '0' })));
  const order = expectStatus(await admin.post('/api/v1/orders', { factoryId: h.a.factoryId, customerId: h.a.customerId, currency: 'EUR', orderDate: '2026-11-02', dueDate: '2026-12-15',
    notes: 'Fotoğraftan içe aktarıldı · Parti 1092', lines }), 201);
  assert.equal(order.status, 'DRAFT');
  assert.equal(order.summary.totalQty, '1420');
});

test('photo import: hourly budget per organization', async () => {
  const admin = await h.login('A', 'admin');
  mode = 'ok';
  let limited = false;
  for (let i = 0; i < 10 && !limited; i++) limited = (await admin.post('/api/v1/orders/import/extract', IMG)).status === 429;
  assert.ok(limited, 'extract calls are capped per hour');
  // another organization has its own budget
  expectStatus(await (await h.login('B', 'admin')).post('/api/v1/orders/import/extract', IMG), 200);
});

test('text import (no AI): pasted TEXFLOW-FOY text is validated, matched and checked; no AI call, no records', async () => {
  const admin = await h.login('A', 'admin');
  const calls = seen.length;
  const text = 'TEXFLOW-FOY v1\n' + JSON.stringify(SHEET, null, 1) + '\n';
  const d = expectStatus(await admin.post('/api/v1/orders/import/parse', { text }), 200);
  assert.equal(seen.length, calls, 'the AI service is not called');
  assert.equal(d.ai, null);
  assert.equal(d.extraction.partyNo, '1092');
  assert.ok(d.checks.some((c: any) => c.code === 'CUT_VS_REQUESTED'));
  assert.equal(d.matches.colors.find((m: any) => m.written === 'siyah').colorId, h.a.colors.SYH);
  // truncated / foreign / wrongly shaped text is rejected with a clear message, never guessed
  expectStatus(await admin.post('/api/v1/orders/import/parse', { text: text.slice(0, text.length / 2) }), 400, 'VALIDATION_FAILED');
  expectStatus(await admin.post('/api/v1/orders/import/parse', { text: 'siyah 810 laci 610' }), 400, 'VALIDATION_FAILED');
  expectStatus(await admin.post('/api/v1/orders/import/parse', { text: '{"sections":[{"title":"x","lines":[{"color":"a","quantity":-1}]}]}' }), 400, 'VALIDATION_FAILED');
  expectStatus(await (await h.login('A', 'depo')).post('/api/v1/orders/import/parse', { text }), 403, 'FORBIDDEN');
});
