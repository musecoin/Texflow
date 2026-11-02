/**
 * Reads a photographed order / cutting sheet with Claude (Messages API, vision + tool use).
 * The model is asked to transcribe only; it does not compute totals or fill gaps. Its output is
 * validated with Zod — invalid output is an error, never silently repaired.
 */
import { AppError, OrderSheetExtraction } from '@texflow/shared';
import type { Config } from '../config.ts';

const TOOL = {
  name: 'record_order_sheet',
  description: 'Records the contents of ONE photographed textile order sheet / cutting sheet (kesim föyü, sipariş formu) exactly as written. Call it exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      customer: { type: ['string', 'null'], description: 'Customer / brand name as written (e.g. at the top-left). null if absent.' },
      partyNo: { type: ['string', 'null'], description: 'PARTİ NO / lot / job number.' },
      modelCode: { type: ['string', 'null'], description: 'MODEL NO / style code exactly as written, e.g. "288-PNT".' },
      modelName: { type: ['string', 'null'], description: 'Model description / title.' },
      productType: { type: ['string', 'null'], description: 'Product type if written, e.g. "PANTOLON".' },
      fabric: { type: ['string', 'null'], description: 'KUMAŞ value.' },
      composition: { type: ['string', 'null'], description: 'Fibre composition, e.g. "%92 pamuk, %8 elastan".' },
      labelBrand: { type: ['string', 'null'], description: 'ETİKET MARKASI.' },
      cuttingDate: { type: ['string', 'null'], description: 'KESİM TARİHİ as YYYY-MM-DD (sheet uses DD.MM.YYYY). null if empty.' },
      dueDate: { type: ['string', 'null'], description: 'TERMİN as YYYY-MM-DD. null if the cell is empty — never guess.' },
      workshop: { type: ['string', 'null'], description: 'ATÖLYE value, null if empty.' },
      notes: { type: 'array', items: { type: 'string' }, description: 'Free-text instructions written on the sheet (packing, approvals, warnings), one per item, verbatim.' },
      decorations: { type: 'array', items: { type: 'string' }, description: 'Print / embroidery / accessory words (e.g. CROSS, REFLECTOR, NAKIŞ) that have content.' },
      sizes: { type: 'array', description: 'Size columns in sheet order, with the size ratio (asorti) if one is written under them.',
        items: { type: 'object', properties: { size: { type: 'string' }, ratio: { type: ['number', 'null'] } }, required: ['size', 'ratio'] } },
      sections: { type: 'array', description: 'Each separate quantity table on the sheet. A sheet may have e.g. a cut-quantity table (ADET next to colours) and a requested colour breakdown (İSTENEN ... RENK ORANTISI). Do not merge tables.',
        items: { type: 'object', properties: {
          title: { type: 'string', description: 'Heading as written, e.g. "ADET" or "İSTENEN PANTOLON RENK ORANTISI".' },
          kind: { type: 'string', enum: ['requested', 'ordered', 'cut', 'other'], description: 'requested/ordered = what the customer wants; cut = cutting quantities; other = anything else.' },
          printedTotal: { type: ['integer', 'null'], description: 'The total written on the sheet for this table, null if none. Read it, do not compute it.' },
          lines: { type: 'array', items: { type: 'object', properties: {
            color: { type: 'string', description: 'Colour as written (e.g. "siyah", "laci").' },
            size: { type: ['string', 'null'], description: 'Size if the quantity is per size, otherwise null.' },
            quantity: { type: 'integer', description: 'Pieces as an integer. "1.496" means 1496 (dot is a thousands separator).' },
            uncertain: { type: 'boolean', description: 'true if the digits are hard to read.' },
          }, required: ['color', 'size', 'quantity', 'uncertain'] } },
        }, required: ['title', 'kind', 'printedTotal', 'lines'] } },
      measurements: { type: 'array', description: 'Measurement rows (e.g. EN, BOY) with a value per size.',
        items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'object', properties: { size: { type: 'string' }, value: { type: 'number' } }, required: ['size', 'value'] } } }, required: ['name', 'values'] } },
      uncertainties: { type: 'array', items: { type: 'string' }, description: 'Short Turkish notes about anything ambiguous or unreadable, or inconsistencies you notice (e.g. a label that does not match the product).' },
    },
    required: ['customer', 'partyNo', 'modelCode', 'modelName', 'productType', 'fabric', 'composition', 'labelBrand', 'cuttingDate', 'dueDate', 'workshop', 'notes', 'decorations', 'sizes', 'sections', 'measurements', 'uncertainties'],
  },
};

const PROMPT = `Bu fotoğraf bir tekstil fabrikasının sipariş / kesim föyü. İçeriği record_order_sheet aracıyla bir kez kaydet.
Kurallar:
- Yalnızca kağıtta yazanı aktar. Toplam hesaplama, boş alanı doldurma, tahmin etme.
- Boş hücre null olur. Okunamayan rakamı en iyi okumanla yaz ve uncertain=true işaretle.
- Ayrı tabloları ayrı "sections" olarak ver; aynı renk bir tabloda iki kez geçiyorsa iki ayrı satır olarak bırak.
- Binlik ayırıcı noktadır (1.496 = 1496). Tarihleri YYYY-AA-GG yaz.
- Fark ettiğin tutarsızlıkları "uncertainties" içine kısa Türkçe notlarla yaz.`;

export interface ExtractResult { extraction: OrderSheetExtraction; model: string; usage: { inputTokens: number; outputTokens: number } | null }

export async function extractOrderSheet(config: Config, image: { mediaType: string; base64: string }): Promise<ExtractResult> {
  if (!config.ai.apiKey) throw new AppError('AI_NOT_CONFIGURED', 'Yapay zeka okuma özelliği bu sunucuda açık değil (ANTHROPIC_API_KEY tanımlı değil).');
  let res: Response;
  try {
    res = await fetch(config.ai.baseUrl + '/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(config.ai.timeoutMs),
      headers: { 'content-type': 'application/json', 'x-api-key': config.ai.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: config.ai.model,
        max_tokens: 16000,
        // forced tool_choice is rejected by current models; the prompt asks for exactly one call
        tools: [TOOL],
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
          { type: 'text', text: PROMPT },
        ] }],
      }),
    });
  } catch (e) {
    throw new AppError('AI_FAILED', (e as Error).name === 'TimeoutError' ? 'Yapay zeka servisi zamanında yanıt vermedi; tekrar deneyin.' : 'Yapay zeka servisine ulaşılamadı.');
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = ''; try { msg = JSON.parse(text)?.error?.message ?? ''; } catch { /* ignore */ }
    // never echo the key; the upstream message is safe to show to an admin
    throw new AppError('AI_FAILED', `Yapay zeka servisi hata döndürdü (${res.status})${msg ? ': ' + msg.slice(0, 200) : ''}`, { upstreamStatus: res.status });
  }
  let body: any; try { body = JSON.parse(text); } catch { throw new AppError('AI_FAILED', 'Yapay zeka yanıtı okunamadı'); }
  const call = (body.content ?? []).find((b: any) => b?.type === 'tool_use' && b.name === TOOL.name);
  if (!call) throw new AppError('AI_FAILED', 'Fotoğraftan sipariş bilgisi çıkarılamadı. Daha net ve tüm sayfayı gösteren bir fotoğraf deneyin.', { stopReason: body.stop_reason ?? null });
  const parsed = OrderSheetExtraction.safeParse(call.input);
  if (!parsed.success) throw new AppError('AI_FAILED', 'Yapay zekanın okuduğu veri beklenen biçimde değil; tekrar deneyin.', { issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join('.') + ': ' + i.message) });
  return { extraction: parsed.data, model: body.model ?? config.ai.model, usage: body.usage ? { inputTokens: body.usage.input_tokens ?? 0, outputTokens: body.usage.output_tokens ?? 0 } : null };
}
