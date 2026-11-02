/**
 * Photo → order draft. POST /api/v1/orders/import/extract reads the sheet (AI), matches the
 * written values against master data and runs deterministic checks. It creates NO business
 * records: the user reviews the draft and the order is created through POST /api/v1/orders.
 * Also: small master-data endpoints (colours, sizes) so missing values can be added from the
 * review screen by users allowed to edit models.
 */
import { AppError, ExtractOrderSheetReq, CreateColorReq, CreateSizeReq, matchColor, matchSize, normTr, normSize, checkExtraction } from '@texflow/shared';
import type { Route } from '../http/kernel.ts';
import type { Config } from '../config.ts';
import { RateLimiter } from '../http/rateLimit.ts';
import { camel, camelAll } from '../lib.ts';
import { extractOrderSheet } from '../ai/orderSheet.ts';

export function orderImportRoutes(config: Config): Route[] {
  const limiter = new RateLimiter(config.ai.perHour, 3_600_000);
  return [
    { method: 'GET', path: '/api/v1/orders/import/status', tag: 'sales', summary: 'Fotoğraftan sipariş özelliği açık mı', permission: 'order.create',
      handler: async () => ({ enabled: !!config.ai.apiKey, model: config.ai.apiKey ? config.ai.model : null, perHour: config.ai.perHour }) },

    { method: 'POST', path: '/api/v1/orders/import/extract', tag: 'sales', summary: 'Sipariş/kesim föyü fotoğrafını oku → düzenlenebilir taslak (kayıt oluşturmaz)',
      permission: 'order.create', body: ExtractOrderSheetReq, idempotent: false, maxBodyBytes: 9_000_000,
      handler: async (c) => {
        // per-organization budget: each call costs money
        const wait = limiter.check('org:' + c.auth.orgId);
        if (wait) throw Object.assign(new AppError('RATE_LIMITED', `Saatlik okuma sınırına ulaşıldı; ${Math.ceil(wait / 60)} dk sonra tekrar deneyin.`), { retryAfter: wait });
        const bytes = Math.floor(c.body.imageBase64.length * 3 / 4);
        if (bytes > 6_000_000) throw new AppError('PAYLOAD_TOO_LARGE', 'Fotoğraf çok büyük (en fazla 6 MB)');
        const started = Date.now();
        const r = await extractOrderSheet(config, { mediaType: c.body.mediaType, base64: c.body.imageBase64 });
        const x = r.extraction;

        // ---- match written values against master data (read-only)
        const colors = camelAll((await c.db.query('SELECT id, code, name FROM color ORDER BY code')).rows) as { id: string; code: string; name: string }[];
        const sizes = camelAll((await c.db.query('SELECT id, code, sort_order FROM size ORDER BY sort_order, code')).rows) as { id: string; code: string }[];
        const firstSpelling = new Map<string, string>(); // first spelling wins (same rule as buildDraft)
        for (const s of x.sections) for (const l of s.lines) if (!firstSpelling.has(normTr(l.color))) firstSpelling.set(normTr(l.color), l.color.trim());
        const writtenColors = [...firstSpelling.values()];
        const writtenSizes = [...new Set([...x.sizes.map((s) => normSize(s.size)), ...x.sections.flatMap((s) => s.lines.flatMap((l) => (l.size ? [normSize(l.size)] : [])))])];
        const colorMatches = writtenColors.map((w) => { const m = matchColor(w, colors); return { written: w, colorId: m?.id ?? null, label: m ? `${m.code} · ${m.name}` : null }; });
        const sizeMatches = writtenSizes.map((w) => { const m = matchSize(w, sizes); return { written: w, sizeId: m?.id ?? null }; });

        let customer: { written: string | null; customerId: string | null; candidates: { id: string; name: string; currency: string }[] } = { written: x.customer, customerId: null, candidates: [] };
        if (c.can('customer.read')) {
          const all = camelAll((await c.db.query('SELECT id, code, name, currency FROM customer WHERE is_active ORDER BY name')).rows) as { id: string; code: string; name: string; currency: string }[];
          const w = x.customer ? normTr(x.customer) : '';
          const strip = (s: string) => normTr(s).replace(/^demo/, '');
          const hits = w.length >= 3 ? all.filter((cu) => normTr(cu.code) === w || strip(cu.name) === w || strip(cu.name).includes(w)) : [];
          customer = { written: x.customer, customerId: hits.length === 1 ? hits[0].id : null, candidates: hits.slice(0, 5).map((h) => ({ id: h.id, name: h.name, currency: h.currency })) };
        }
        let model: { written: string | null; modelId: string | null; status: string | null; variants: { colorId: string; sizeId: string }[] } = { written: x.modelCode, modelId: null, status: null, variants: [] };
        if (x.modelCode && c.can('model.read')) {
          const m = (await c.db.query('SELECT id, status FROM product_model WHERE lower(code) = lower($1)', [x.modelCode.trim()])).rows[0];
          if (m) model = { written: x.modelCode, modelId: m.id, status: m.status, variants: camelAll((await c.db.query('SELECT color_id, size_id FROM product_variant WHERE model_id = $1', [m.id])).rows) };
        }

        const checks = checkExtraction(x);
        for (const cm of colorMatches) if (!cm.colorId) checks.push({ level: 'error', code: 'COLOR_UNKNOWN', text: `"${cm.written}" rengi sistemde yok.` });
        for (const sm of sizeMatches) if (!sm.sizeId) checks.push({ level: 'error', code: 'SIZE_UNKNOWN', text: `"${sm.written}" bedeni sistemde yok.` });
        if (x.modelCode && !model.modelId) checks.push({ level: 'error', code: 'MODEL_UNKNOWN', text: `"${x.modelCode}" modeli sistemde yok.` });
        if (x.customer && !customer.customerId) checks.push({ level: 'warn', code: 'CUSTOMER_UNMATCHED', text: `"${x.customer}" müşterisi tek bir kayıtla eşleşmedi; listeden seçin.` });

        // audit: what was read and by which model — the image itself is not stored
        await c.audit('order.import.extract', 'order_import', null, null, {
          aiModel: r.model, usage: r.usage, ms: Date.now() - started, imageBytes: bytes,
          modelCode: x.modelCode, customer: x.customer, sections: x.sections.map((s) => ({ title: s.title, kind: s.kind, lines: s.lines.length, printedTotal: s.printedTotal })),
        });
        // a read, not a creation: 200
        return { status: 200, body: { extraction: x, matches: { customer, model, colors: colorMatches, sizes: sizeMatches }, checks, ai: { model: r.model, usage: r.usage } } };
      } },

    { method: 'POST', path: '/api/v1/colors', tag: 'plm', summary: 'Renk tanımla', permission: 'model.write', body: CreateColorReq,
      handler: async (c) => {
        const r = (await c.db.query('INSERT INTO color (organization_id, code, name) VALUES ($1,$2,$3) RETURNING id, code, name, pantone', [c.auth.orgId, c.body.code.toUpperCase(), c.body.name])).rows[0];
        await c.audit('color.create', 'color', r.id, null, r);
        return { status: 201, body: camel(r) };
      } },
    { method: 'POST', path: '/api/v1/sizes', tag: 'plm', summary: 'Beden tanımla', permission: 'model.write', body: CreateSizeReq,
      handler: async (c) => {
        const codeU = normSize(c.body.code);
        // appended after existing sizes; existing rows are never renumbered
        const order = ((await c.db.query<{ m: number | null }>('SELECT max(sort_order) AS m FROM size')).rows[0].m ?? -1) + 1;
        const r =(await c.db.query('INSERT INTO size (organization_id, code, sort_order) VALUES ($1,$2,$3) RETURNING id, code, sort_order', [c.auth.orgId, codeU, order])).rows[0];
        await c.audit('size.create', 'size', r.id, null, r);
        return { status: 201, body: camel(r) };
      } },
  ];
}
