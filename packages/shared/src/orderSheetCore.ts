/**
 * Deterministic part of order-sheet import (no dependencies, also bundled into the web app):
 * normalisation, matching, checks and the draft grid.
 */
export interface OrderSheetExtractionData {
  customer: string | null; partyNo: string | null; modelCode: string | null; modelName: string | null; productType: string | null;
  fabric: string | null; composition: string | null; labelBrand: string | null; cuttingDate: string | null; dueDate: string | null; workshop: string | null;
  notes: string[]; decorations: string[];
  sizes: { size: string; ratio: number | null }[];
  sections: { title: string; kind: 'requested' | 'ordered' | 'cut' | 'other'; printedTotal: number | null; lines: { color: string; size: string | null; quantity: number; uncertain: boolean }[] }[];
  measurements: { name: string; values: { size: string; value: number }[] }[];
  uncertainties: string[];
}
type OrderSheetExtraction = OrderSheetExtractionData;

// ---------------------------------------------------------------- normalisation & matching
/** Turkish-aware lowercase + strip punctuation/diacritics for comparison only. */
export function normTr(s: string): string {
  return s.toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}
const SIZE_ALIASES: Record<string, string> = { XXXL: '3XL', '2XL': 'XXL', XXXXL: '4XL', XXS: '2XS' };
export function normSize(s: string): string { const u = s.trim().toUpperCase().replace(/\s+/g, ''); return SIZE_ALIASES[u] ?? u; }
/** Conventional order for new sizes (unknown ones go last). */
export const SIZE_ORDER = ['3XS', '2XS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL', '6XL'];

export function matchColor<T extends { id: string; code: string; name: string }>(raw: string, colors: T[]): T | null {
  const r = normTr(raw); if (!r) return null;
  const exact = colors.find((c) => normTr(c.code) === r || normTr(c.name) === r);
  if (exact) return exact;
  // abbreviations written on sheets ("laci" → Lacivert); require 3+ chars and a unique hit
  if (r.length < 3) return null;
  const pref = colors.filter((c) => normTr(c.name).startsWith(r) || r.startsWith(normTr(c.name)));
  return pref.length === 1 ? pref[0] : null;
}
export function matchSize<T extends { id: string; code: string }>(raw: string, sizes: T[]): T | null {
  const r = normSize(raw); return sizes.find((s) => normSize(s.code) === r) ?? null;
}

// ---------------------------------------------------------------- deterministic checks
export interface SheetCheck { level: 'error' | 'warn' | 'info'; code: string; text: string }

export function checkExtraction(x: OrderSheetExtraction): SheetCheck[] {
  const out: SheetCheck[] = [];
  for (const s of x.sections) {
    const sum = s.lines.reduce((a, l) => a + l.quantity, 0);
    if (s.printedTotal !== null) {
      if (s.printedTotal === sum) out.push({ level: 'info', code: 'TOTAL_OK', text: `"${s.title}": satır toplamı ${sum}, kağıttaki toplamla tutuyor.` });
      else out.push({ level: 'error', code: 'TOTAL_MISMATCH', text: `"${s.title}": satırların toplamı ${sum}, kağıtta yazan toplam ${s.printedTotal}. Bir rakam yanlış okunmuş olabilir.` });
    } else out.push({ level: 'warn', code: 'TOTAL_MISSING', text: `"${s.title}": kağıtta toplam yok; satırları tek tek kontrol edin.` });
    const seen = new Map<string, number>();
    for (const l of s.lines) { const k = normTr(l.color) + '|' + (l.size ? normSize(l.size) : ''); seen.set(k, (seen.get(k) ?? 0) + 1); }
    for (const [k, n] of seen) if (n > 1) out.push({ level: 'warn', code: 'DUPLICATE_LINE', text: `"${s.title}": ${k.split('|')[0]} ${k.split('|')[1] || ''} ${n} kez geçiyor; taslakta toplanır — ayrı lot/pastal ise kontrol edin.`.replace(/\s+/g, ' ') });
    const unc = s.lines.filter((l) => l.uncertain);
    if (unc.length) out.push({ level: 'warn', code: 'UNCERTAIN', text: `"${s.title}": ${unc.map((l) => `${l.color} ${l.quantity}`).join(', ')} net okunamadı.` });
  }
  const req = x.sections.find((s) => s.kind === 'requested' || s.kind === 'ordered');
  const cut = x.sections.find((s) => s.kind === 'cut');
  if (req && cut) {
    const tot = (s: typeof req) => s.lines.reduce((a, l) => a + l.quantity, 0);
    const d = tot(cut) - tot(req);
    if (d !== 0) out.push({ level: 'warn', code: 'CUT_VS_REQUESTED', text: `Kesilen (${tot(cut)}) ile istenen (${tot(req)}) farklı: ${d > 0 ? '+' : ''}${d}. Siparişe hangisinin yazılacağını seçin.` });
  }
  const ratios = x.sizes.filter((s) => s.ratio !== null);
  if (ratios.length && x.sections.some((s) => s.lines.some((l) => !l.size))) {
    const total = ratios.reduce((a, s) => a + (s.ratio ?? 0), 0);
    for (const s of x.sections) for (const l of s.lines) if (!l.size && total > 0 && l.quantity % total !== 0) {
      out.push({ level: 'warn', code: 'RATIO_REMAINDER', text: `"${s.title}" ${l.color} ${l.quantity} adet, beden oranına (${ratios.map((r) => r.ratio).join(':')}) tam bölünmüyor; kalan ${l.quantity % total} adedi siz dağıtın.` });
    }
  }
  if (!x.dueDate) out.push({ level: 'warn', code: 'DUE_DATE_MISSING', text: 'Termin tarihi kağıtta yok; sipariş için girilmesi zorunlu.' });
  for (const u of x.uncertainties) out.push({ level: 'warn', code: 'AI_NOTE', text: u });
  return out;
}

// ---------------------------------------------------------------- draft grid
export interface DraftCell { color: string; size: string; qty: number }
export interface DraftResult { cells: DraftCell[]; unassigned: { color: string; qty: number }[]; colors: string[]; sizes: string[] }

/**
 * Builds a colour × size grid from one section. Lines with a size are used as written; lines
 * without a size are split by the written size ratio using whole multiples only. Any remainder is
 * reported as unassigned — it is never distributed by guesswork.
 */
export function buildDraft(x: OrderSheetExtraction, sectionIndex: number): DraftResult {
  const s = x.sections[sectionIndex]; if (!s) return { cells: [], unassigned: [], colors: [], sizes: [] };
  const colorKey = new Map<string, string>(); // normalised → first spelling
  const cell = new Map<string, number>(); const unassigned = new Map<string, number>();
  const sizes: string[] = x.sizes.map((z) => normSize(z.size));
  const add = (c: string, sz: string, q: number) => { const k = c + '|' + sz; cell.set(k, (cell.get(k) ?? 0) + q); if (!sizes.includes(sz)) sizes.push(sz); };
  const ratios = x.sizes.filter((z) => z.ratio !== null && z.ratio > 0);
  const ratioTotal = ratios.reduce((a, z) => a + (z.ratio ?? 0), 0);
  for (const l of s.lines) {
    const nk = normTr(l.color); if (!colorKey.has(nk)) colorKey.set(nk, l.color.trim());
    const c = colorKey.get(nk)!;
    if (l.size) { add(c, normSize(l.size), l.quantity); continue; }
    if (!ratioTotal || !Number.isInteger(ratioTotal)) { unassigned.set(c, (unassigned.get(c) ?? 0) + l.quantity); continue; }
    const sets = Math.floor(l.quantity / ratioTotal);
    for (const r of ratios) add(c, normSize(r.size), sets * (r.ratio ?? 0));
    const rem = l.quantity - sets * ratioTotal;
    if (rem) unassigned.set(c, (unassigned.get(c) ?? 0) + rem);
  }
  const colors = [...colorKey.values()];
  const cells: DraftCell[] = [];
  for (const c of colors) for (const sz of sizes) { const q = cell.get(c + '|' + sz); if (q) cells.push({ color: c, size: sz, qty: q }); }
  return { cells, unassigned: [...unassigned].map(([color, qty]) => ({ color, qty })), colors, sizes };
}
