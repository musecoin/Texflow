/**
 * Browser end-to-end test of the vertical slice through the real UI, API and PostgreSQL.
 * Desktop (1366×900) and Android-sized (412×915) viewports. Screenshots go to e2e/screenshots.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { loadDotEnv, migrate, Connection, parseDatabaseUrl, seedOrganization } from '@texflow/db';
import { loadConfig } from '../apps/api/src/config.ts';
import { createApp } from '../apps/api/src/app.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'screenshots');
const PASSWORD = 'E2e!Passw0rd';
let app: ReturnType<typeof createApp>; let base = ''; let browser: Browser;

before(async () => {
  loadDotEnv();
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; process.env.APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL;
  await migrate({ reset: true, log: () => undefined });
  const c = new Connection(parseDatabaseUrl(process.env.TEST_DATABASE_URL!)); await c.connect();
  await seedOrganization(c, { code: 'DEMO', name: 'DEMO Tekstil A.Ş.', isDemo: true, password: PASSWORD, emailDomain: 'demo.texflow.local', settings: { allowSelfApproval: true }, withDemoModel: true });
  await c.end();
  app = createApp(loadConfig({ appDatabaseUrl: process.env.TEST_APP_DATABASE_URL!, webDistDir: path.join(here, '../apps/web/dist'), apiRatePerMin: 100_000, loginRatePerMin: 1000 }));
  base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
  browser = await chromium.launch();
  fs.mkdirSync(shots, { recursive: true });
});
after(async () => { await browser?.close(); await app?.close(); });

async function loginAs(page: Page, email: string) {
  await page.goto(base + '/');
  await page.getByLabel('Organizasyon kodu').fill('DEMO');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill(PASSWORD);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await page.getByRole('heading', { name: 'Fabrika Kontrol Merkezi' }).waitFor();
}

function collectErrors(page: Page) {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  return errs;
}

/** Grouped sidebar: expand the section if needed, then follow the link. */
async function openMenu(page: Page, section: string, link: string | RegExp) {
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const btn = nav.getByRole('button', { name: section });
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
  await nav.getByRole('link', typeof link === 'string' ? { name: link, exact: true } : { name: link }).click();
}

test('desktop: order → work order → receive & inspect roll → reserve → ledger', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'tr-TR' });
  const page = await ctx.newPage(); const errs = collectErrors(page);
  await loginAs(page, 'admin@demo.texflow.local');
  await page.screenshot({ path: path.join(shots, '01-desktop-dashboard.png') });

  // create order
  await openMenu(page, 'Sipariş Yönetimi', 'Siparişler');
  await page.getByRole('button', { name: '+ Yeni sipariş' }).click();
  const sheet = page.getByRole('dialog', { name: 'Yeni sipariş' });
  await sheet.getByLabel('Müşteri', { exact: true }).selectOption({ label: 'DEMO Nordic Apparel AB' });
  await sheet.getByLabel('Müşteri PO').fill('PO-E2E-1');
  await sheet.getByLabel('Termin').fill('2027-02-15');
  await sheet.getByLabel('Model').selectOption({ index: 1 });
  await sheet.getByLabel('TS-1001-SYH-M adet').fill('120');
  await sheet.getByLabel('TS-1001-SYH-M fiyat').fill('4,85');
  await sheet.getByLabel('TS-1001-SYH-L adet').fill('80');
  await sheet.getByLabel('TS-1001-SYH-L fiyat').fill('4,85');
  await sheet.getByRole('button', { name: 'Taslak sipariş oluştur' }).click();
  await page.getByText('Sipariş taslak olarak kaydedildi').waitFor();
  await page.getByRole('button', { name: 'Siparişi onayla' }).click();
  await page.getByText('Sipariş onaylandı', { exact: true }).waitFor();
  await page.locator('[aria-current="step"]', { hasText: 'İş emri' }).waitFor();
  const orderNo = (await page.getByRole('heading', { level: 1 }).innerText()).split(/\s/)[0];
  assert.match(orderNo, /^SIP\d\d-\d{5}$/);

  // work order + release
  await page.getByRole('button', { name: '+ İş emri' }).click();
  await page.getByLabel('Planlanan adet').fill('200');
  await page.getByRole('dialog', { name: 'İş emri oluştur' }).getByRole('button', { name: 'Oluştur' }).click();
  await page.getByText('İş emri oluşturuldu').waitFor();
  await page.getByRole('button', { name: 'Serbest bırak' }).click();
  await page.getByText('İş emri serbest bırakıldı; malzeme ihtiyacı hesaplandı').waitFor();
  await page.getByRole('button', { name: 'FIFO rezerve et' }).first().waitFor();
  assert.match(await page.locator('main').innerText(), /KUM-SUP-180[\s\S]*197,6 M/);
  const woUrl = page.url();
  await page.screenshot({ path: path.join(shots, '02-desktop-work-order-released.png'), fullPage: true });

  // receive a roll into quarantine
  await page.goto(base + '/#/inventory');
  await page.getByRole('button', { name: '+ Top kabulü' }).click();
  const recv = page.getByRole('dialog', { name: 'Kumaş top kabulü' });
  await recv.getByLabel('Tedarikçi').selectOption({ index: 1 });
  await recv.getByLabel('Depo').selectOption({ label: 'KMS-IST · Kumaş Deposu' });
  await recv.getByLabel('Malzeme').selectOption({ label: 'KUM-SUP-180 (M)' });
  await recv.getByLabel('Lot').fill('LOT-E2E');
  await recv.getByLabel('Ton (shade)').fill('a');
  await recv.getByLabel('Miktar').fill('250');
  await recv.getByRole('button', { name: 'Kabul et → karantina' }).click();
  await recv.getByText(/Sunucu onayladı: MK-\d{5} — 1 top karantinaya alındı/).waitFor();
  await recv.getByRole('link', { name: /TOP-\d{6}/ }).click();

  // 4-point inspection (2 small defects → pass with the DEMO plan)
  await page.getByRole('button', { name: '4 puan muayene' }).click();
  const insp = page.getByRole('dialog', { name: /4 puan muayene/ });
  await insp.getByLabel('Kesilebilir en (cm)').fill('176');
  await insp.getByRole('button', { name: '+ Hata ekle' }).click();
  await insp.getByLabel('Hata kodu').fill('nope');
  await insp.getByLabel('Uzunluk (inç)').fill('2');
  await insp.getByLabel('Konum (m)').fill('12');
  await insp.getByRole('button', { name: 'Muayeneyi kaydet' }).click();
  await insp.getByText(/Sonuç: Geçti — 1 puan/).waitFor();
  await insp.getByRole('button', { name: 'Kapat' }).last().click();
  await page.locator('h1 [data-status="ACCEPTED"]').waitFor();
  await page.screenshot({ path: path.join(shots, '03-desktop-roll-accepted.png'), fullPage: true });

  // reserve (FIFO) on the work order
  await page.goto(woUrl);
  await page.locator('div.rounded-lg', { hasText: 'KUM-SUP-180' }).getByRole('button', { name: 'FIFO rezerve et' }).click();
  await page.getByText(/Sunucu onayladı — KUM-SUP-180: TOP-\d{6} \(197,6, ton A\)/).waitFor();
  await page.screenshot({ path: path.join(shots, '04-desktop-reserved.png'), fullPage: true });

  // ledger shows the reservation with its source document
  await openMenu(page, 'Kumaş & Stok (WMS)', 'Stok Defteri');
  const firstRow = page.locator('tbody tr').first();
  await firstRow.getByText('Rezervasyon').waitFor();
  assert.match(await firstRow.innerText(), /IE-\d{5}/);
  assert.match(await firstRow.innerText(), /\+197,6/);
  await page.screenshot({ path: path.join(shots, '05-desktop-ledger.png'), fullPage: true });

  // order status reflects material coverage
  await page.getByLabel('Genel arama').fill(orderNo);
  await page.getByRole('link', { name: new RegExp(orderNo) }).click();
  await page.locator('[aria-current="step"]', { hasText: 'Malzeme' }).first().waitFor();
  await page.goto(base + '/#/');
  await page.getByText('Siparişin dijital yolculuğu').waitFor();
  await page.getByText(orderNo).first().waitFor();
  await page.screenshot({ path: path.join(shots, '00-desktop-control-center.png'), fullPage: true });
  assert.deepEqual(errs, []);
  // menu follows the design's sections; unbuilt sections open an honest roadmap page with no data
  await openMenu(page, 'Satın Alma', /^Tedarikçiler/);
  await page.getByRole('heading', { level: 1, name: 'Satın Alma' }).waitFor();
  await page.getByRole('note').filter({ hasText: 'henüz yapılmadı' }).waitFor();
  assert.equal(await page.getByRole('table').count(), 0);
  await page.screenshot({ path: path.join(shots, '05b-roadmap-purchasing.png'), fullPage: true });
  await ctx.close();
});

test('mobile (Android size): bottom navigation, QR lookup, offline guard blocks commands honestly', async () => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'tr-TR' });
  const page = await ctx.newPage(); const errs = collectErrors(page);
  await loginAs(page, 'depo@demo.texflow.local');
  const bottom = page.getByRole('navigation', { name: 'Alt menü' });
  assert.ok(await bottom.isVisible());
  assert.equal(await page.getByRole('navigation', { name: 'Ana menü' }).isVisible(), false);
  // large tap targets: every bottom-nav item is at least 44px tall
  for (const box of await bottom.locator('a,button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) assert.ok(box >= 44, `tap target ${box}px`);
  await page.screenshot({ path: path.join(shots, '06-mobile-dashboard.png') });

  // QR lookup of the roll received in the desktop test
  const qr = await page.evaluate(async () => {
    const tok = JSON.parse(localStorage.getItem('texflow.session')!).accessToken;
    const r = await fetch('/api/v1/rolls?limit=1', { headers: { authorization: 'Bearer ' + tok } });
    return (await r.json()).items[0].qrCode as string;
  });
  // phone menu sheet shows the same sections as the desktop sidebar
  await bottom.getByRole('button', { name: 'Menü' }).click();
  const sheet = page.getByRole('navigation', { name: 'Bölümler' });
  for (const name of ['Sipariş Yönetimi', 'Planlama (APS)', 'Üretim Takibi (MES)', 'Kalite Kontrol (QMS)', 'AI Kontrol Merkezi']) await sheet.getByRole('button', { name }).waitFor();
  await sheet.getByRole('button', { name: 'Kumaş & Stok (WMS)' }).click();
  await page.screenshot({ path: path.join(shots, '06b-mobile-menu.png') });
  await sheet.getByRole('link', { name: 'QR Tara', exact: true }).click();
  await page.getByLabel('QR / top kodu').fill(qr);
  await page.getByRole('button', { name: 'Bul' }).click();
  await page.getByRole('heading', { name: /TOP-\d{6}/ }).waitFor();
  await page.screenshot({ path: path.join(shots, '07-mobile-roll-by-qr.png'), fullPage: true });

  // offline: indicator appears and a command is refused without a fake success
  await bottom.getByRole('link', { name: 'Kumaş Stoğu' }).click();
  await page.getByRole('button', { name: '+ Top kabulü' }).click();
  const recv = page.getByRole('dialog', { name: 'Kumaş top kabulü' });
  await recv.getByLabel('Tedarikçi').selectOption({ index: 1 });
  await recv.getByLabel('Depo').selectOption({ index: 1 });
  await recv.getByLabel('Malzeme').selectOption({ label: 'KUM-SUP-180 (M)' });
  await recv.getByLabel('Lot').fill('OFF'); await recv.getByLabel('Ton (shade)').fill('A'); await recv.getByLabel('Miktar').fill('10');
  await ctx.setOffline(true);
  await page.getByRole('status').filter({ hasText: 'Çevrimdışı' }).waitFor();
  await recv.getByRole('button', { name: 'Kabul et → karantina' }).click();
  await page.getByRole('alert').filter({ hasText: 'Çevrimdışı' }).waitFor();
  assert.equal(await page.getByText(/Sunucu onayladı/).count(), 0, 'no success shown while offline');
  await page.screenshot({ path: path.join(shots, '08-mobile-offline-refused.png') });
  await ctx.setOffline(false);
  assert.deepEqual(errs, []);
  await ctx.close();
});
