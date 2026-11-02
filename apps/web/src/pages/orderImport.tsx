/**
 * "Fotoğraftan sipariş": photograph an order / cutting sheet → AI transcribes it → the user reviews
 * an editable draft (matching, checks, size split) → a DRAFT sales order is created through the
 * normal order endpoint. Nothing is saved before the user presses "Taslak sipariş oluştur".
 */
import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { get, post } from '../api.ts';
import { localToday, fmtQty } from '../i18n.ts';
import { useLoad, useCommand, Card, Button, Field, Input, Select, PageHeader, Loading, ErrorBox, errorText } from '../ui.tsx';
import { useCan, go } from '../app.tsx';
import { buildDraft, normSize, normTr, type OrderSheetExtractionData as OrderSheetExtraction, type SheetCheck } from '../../../../packages/shared/src/orderSheetCore.ts';

interface Extract {
  extraction: OrderSheetExtraction; checks: SheetCheck[]; ai: { model: string; usage: { inputTokens: number; outputTokens: number } | null };
  matches: {
    customer: { written: string | null; customerId: string | null; candidates: { id: string; name: string; currency: string }[] };
    model: { written: string | null; modelId: string | null; status: string | null; variants: { colorId: string; sizeId: string }[] };
    colors: { written: string; colorId: string | null }[]; sizes: { written: string; sizeId: string | null }[];
  };
}

/** Downscale to ≤ 2000 px on the long edge and re-encode as JPEG (keeps text legible, ~0.3–1 MB). */
async function compress(file: File): Promise<{ dataUrl: string; base64: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Fotoğraf açılamadı')); i.src = url; });
    const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.naturalWidth * scale); cv.height = Math.round(img.naturalHeight * scale);
    const ctx = cv.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const dataUrl = cv.toDataURL('image/jpeg', 0.85);
    return { dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  } finally { URL.revokeObjectURL(url); }
}

export function OrderImportPage() {
  const status = useLoad<{ enabled: boolean; model: string | null; perHour: number }>(() => get('/api/v1/orders/import/status'), []);
  const [photo, setPhoto] = useState<{ dataUrl: string; base64: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Extract | null>(null);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null); setResult(null);
    try { setPhoto(await compress(f)); } catch (e) { setErr(errorText(e)); }
  };
  const read = async () => {
    if (!photo) return;
    setReading(true); setErr(null);
    try { setResult(await post<Extract>('/api/v1/orders/import/extract', { mediaType: 'image/jpeg', imageBase64: photo.base64 })); }
    catch (e) { setErr(errorText(e)); }
    finally { setReading(false); }
  };

  if (status.error) return <ErrorBox error={status.error} onRetry={status.reload} />;
  if (!status.data) return <Loading />;
  return (
    <>
      <PageHeader title="Fotoğraftan sipariş" subtitle="Sipariş veya kesim föyünün fotoğrafını çekin; yapay zeka okur, siz kontrol edip onaylarsınız."
        actions={<Button variant="secondary" onClick={() => go('orders')}>Siparişlere dön</Button>} />
      {!status.data.enabled ? (
        <div role="alert" className="rounded-xl border border-warn/60 bg-warn/10 p-4 text-sm text-ink">
          Bu özellik sunucuda henüz açık değil. Yönetici, Render ortam değişkenlerine <b>ANTHROPIC_API_KEY</b> ekleyince çalışır.
        </div>
      ) : (
        <>
          <Card title="1 · Fotoğraf" className="mb-4">
            <div className="flex flex-wrap gap-2">
              <label className="inline-flex min-h-12 cursor-pointer items-center gap-2 rounded-lg bg-brand-700 px-4 font-semibold text-white">
                <span aria-hidden>📷</span>Fotoğraf çek
                <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} />
              </label>
              <label className="inline-flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-4 font-semibold text-ink">
                <span aria-hidden>🖼</span>Galeriden seç
                <input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Föy fotoğrafı" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} />
              </label>
              {photo && <Button onClick={() => void read()} loading={reading} disabled={reading}>{result ? 'Yeniden oku' : 'Oku'}</Button>}
            </div>
            <p className="mt-2 text-xs text-muted">Tüm sayfa görünsün, düz ve aydınlık çekin. Fotoğraf saklanmaz; okunan veriler siz onaylayana kadar kaydedilmez. Saatlik sınır: {status.data.perHour} okuma.</p>
            {reading && <p role="status" className="mt-3 text-sm text-ink">Okunuyor… genellikle 10–40 saniye sürer.</p>}
            {err && <p role="alert" className="mt-3 rounded-lg border border-danger/50 bg-danger/10 p-3 text-sm text-ink">{err}</p>}
            {photo && !result && <img src={photo.dataUrl} alt="Seçilen föy" className="mt-3 max-h-96 rounded-lg border border-line" />}
          </Card>
          {result && photo && <Review key={result.ai.usage?.inputTokens + photo.base64.slice(-16)} r={result} photo={photo.dataUrl} />}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- review & confirm
function Review({ r, photo }: { r: Extract; photo: string }) {
  const can = useCan();
  const x = r.extraction;
  const ref = useLoad<any>(async () => {
    const [colors, sizes, factories, customers, models] = await Promise.all([
      get('/api/v1/colors'), get('/api/v1/sizes'), get('/api/v1/factories'),
      can('customer.read') ? get('/api/v1/customers') : Promise.resolve({ items: [] }),
      can('model.read') ? get('/api/v1/models?limit=200') : Promise.resolve({ items: [] }),
    ]);
    return { colors: colors.items, sizes: sizes.items, factories: factories.factories, customers: customers.items, models: models.items };
  }, []);
  const preferred = Math.max(0, x.sections.findIndex((s) => s.kind === 'requested' || s.kind === 'ordered'));
  const [sec, setSec] = useState(preferred);
  const draft = useMemo(() => buildDraft(x, sec), [x, sec]);
  const [qty, setQty] = useState<Record<string, string>>({});
  useEffect(() => { setQty(Object.fromEntries(draft.cells.map((c) => [normTr(c.color) + '|' + c.size, String(c.qty)]))); }, [draft]);
  const [colorMap, setColorMap] = useState<Record<string, string>>(() => Object.fromEntries(r.matches.colors.map((m) => [normTr(m.written), m.colorId ?? ''])));
  const [sizeMap, setSizeMap] = useState<Record<string, string>>(() => Object.fromEntries(r.matches.sizes.map((m) => [m.written, m.sizeId ?? ''])));
  const [price, setPrice] = useState<Record<string, string>>({});
  const [customerId, setCustomerId] = useState(r.matches.customer.customerId ?? '');
  const [factoryId, setFactoryId] = useState('');
  const [modelId, setModelId] = useState(r.matches.model.modelId ?? '');
  const [orderDate, setOrderDate] = useState(localToday());
  const [dueDate, setDueDate] = useState(x.dueDate ?? '');
  const [currency, setCurrency] = useState('');
  const defaultNotes = [
    'Fotoğraftan içe aktarıldı (yapay zeka okuması, kullanıcı onaylı).',
    x.partyNo && `Parti no: ${x.partyNo}`, x.cuttingDate && `Kesim tarihi: ${x.cuttingDate}`, x.fabric && `Kumaş: ${x.fabric}`,
    x.composition && `Kompozisyon: ${x.composition}`, x.labelBrand && `Etiket: ${x.labelBrand}`, x.decorations.length ? `Baskı/aksesuar: ${x.decorations.join(', ')}` : null,
    ...x.notes.map((n) => `Not: ${n}`),
    ...x.measurements.map((m) => `Ölçü ${m.name}: ${m.values.map((v) => `${v.size} ${v.value}`).join(', ')}`),
  ].filter(Boolean).join('\n').slice(0, 2000);
  const [notes, setNotes] = useState(defaultNotes);
  const { run, busy } = useCommand();
  const [created, setCreated] = useState<Record<string, string>>({}); // locally created master data, for labels

  const d = ref.data;
  useEffect(() => { if (d && !factoryId && d.factories.length) setFactoryId(d.factories[0].id); }, [d, factoryId]);
  useEffect(() => { const cu = d?.customers.find((c: any) => c.id === customerId); if (cu) setCurrency(cu.currency); }, [d, customerId]);
  if (ref.error) return <ErrorBox error={ref.error} onRetry={ref.reload} />;
  if (!d) return <Loading />;

  const sizes = draft.sizes; const colors = draft.colors;
  const sectionTotal = (c: string) => x.sections[sec].lines.filter((l) => normTr(l.color) === normTr(c)).reduce((a, l) => a + l.quantity, 0);
  const rowSum = (c: string) => sizes.reduce((a, s) => a + (Number(qty[normTr(c) + '|' + s]) || 0), 0);
  const grand = colors.reduce((a, c) => a + rowSum(c), 0);
  const model = d.models.find((m: any) => m.id === modelId);
  const variants = modelId === r.matches.model.modelId ? r.matches.model.variants : null;

  // ---- validation (all must pass before the order can be created)
  const problems: string[] = [];
  if (!customerId) problems.push('Müşteri seçin.');
  if (!factoryId) problems.push('Fabrika seçin.');
  if (!dueDate) problems.push('Termin tarihi girin.');
  if (!modelId) problems.push('Model seçin veya oluşturun.');
  for (const c of colors) if (!colorMap[normTr(c)]) problems.push(`"${c}" rengini eşleştirin.`);
  for (const s of sizes) if (!sizeMap[s]) problems.push(`"${s}" bedenini eşleştirin.`);
  for (const k of Object.keys(qty)) if (qty[k] !== '' && !/^\d+$/.test(qty[k])) problems.push('Adetler tam sayı olmalı.');
  if (!grand) problems.push('En az bir adet girin.');
  const missingVariants = variants ? colors.flatMap((c) => sizes.filter((s) => Number(qty[normTr(c) + '|' + s]) > 0 && !variants.some((v) => v.colorId === colorMap[normTr(c)] && v.sizeId === sizeMap[s])).map((s) => `${c} ${s}`)) : [];
  if (missingVariants.length) problems.push(`Modelde tanımlı olmayan varyant: ${missingVariants.slice(0, 6).join(', ')}.`);

  const createSize = async (w: string) => {
    const s = await run((k) => post('/api/v1/sizes', { code: w }, { idempotencyKey: k }), `${w} bedeni eklendi`);
    if (s) { setSizeMap((m) => ({ ...m, [w]: (s as any).id })); setCreated((c) => ({ ...c, [(s as any).id]: (s as any).code })); }
  };
  const createColor = async (w: string, code: string, name: string) => {
    const col = await run((k) => post('/api/v1/colors', { code, name }, { idempotencyKey: k }), `${name} rengi eklendi`);
    if (col) { setColorMap((m) => ({ ...m, [normTr(w)]: (col as any).id })); setCreated((c) => ({ ...c, [(col as any).id]: `${(col as any).code} · ${(col as any).name}` })); }
  };
  const createModel = async () => {
    const m = await run((k) => post('/api/v1/models', { code: x.modelCode, name: x.modelName || x.modelCode, productType: x.productType || undefined, customerId: customerId || undefined,
      colorIds: colors.map((c) => colorMap[normTr(c)]), sizeIds: sizes.map((s) => sizeMap[s]) }, { idempotencyKey: k }), `${x.modelCode} modeli taslak olarak oluşturuldu`);
    if (m) { ref.reload(); setModelId((m as any).id); }
  };
  const submit = async () => {
    const lines = colors.flatMap((c) => sizes.flatMap((s) => {
      const q = Number(qty[normTr(c) + '|' + s]) || 0;
      return q > 0 ? [{ modelId, colorId: colorMap[normTr(c)], sizeId: sizeMap[s], quantity: String(q), unitPrice: price[normTr(c)] || '0' }] : [];
    }));
    const o = await run((k) => post('/api/v1/orders', { factoryId, customerId, currency, orderDate, dueDate, notes, customerPo: x.partyNo ? `PARTI-${x.partyNo}`.slice(0, 60) : undefined, lines }, { idempotencyKey: k }), 'Taslak sipariş oluşturuldu');
    if (o) go('orders/' + (o as any).id);
  };

  const colorOpts = [...d.colors.map((c: any) => ({ value: c.id, label: `${c.code} · ${c.name}` }))];
  const sizeOpts = d.sizes.map((s: any) => ({ value: s.id, label: s.code }));
  const level = (l: string) => (l === 'error' ? 'text-danger' : l === 'warn' ? 'text-warn' : 'text-emerald-500');
  const allColorsMapped = colors.every((c) => colorMap[normTr(c)]) && sizes.every((s) => sizeMap[s]);

  return (
    <div className="grid xl:grid-cols-[minmax(0,1fr)_26rem] gap-4">
      <div className="grid gap-4 min-w-0 content-start">
        <Card title="2 · Okuma sonucu ve kontroller">
          <ul className="flex flex-col gap-1.5 text-sm">
            {r.checks.map((c, i) => <li key={i} className="flex gap-2"><span aria-hidden className={level(c.level)}>{c.level === 'error' ? '■' : c.level === 'warn' ? '▲' : '●'}</span><span className="text-ink">{c.text}</span></li>)}
          </ul>
          <p className="mt-2 text-[11px] text-muted">Okuyan: {r.ai.model}. Toplam, tekrar ve beden kontrolleri yapay zekaya değil, sistemin kendi hesabına dayanır.</p>
        </Card>

        <Card title="3 · Sipariş bilgileri">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Müşteri" hint={r.matches.customer.written ? `Kağıtta: ${r.matches.customer.written}` : undefined}>
              <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="Seçin" options={d.customers.map((c: any) => ({ value: c.id, label: c.name }))} />
            </Field>
            <Field label="Fabrika"><Select value={factoryId} onChange={(e) => setFactoryId(e.target.value)} options={d.factories.map((f: any) => ({ value: f.id, label: `${f.code} · ${f.name}` }))} /></Field>
            <Field label="Sipariş tarihi"><Input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} /></Field>
            <Field label="Termin" hint={x.dueDate ? 'Kağıttan okundu' : 'Kağıtta yok — girin'}><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required /></Field>
            <Field label="Para birimi"><Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></Field>
            <Field label="Model" hint={x.modelCode ? `Kağıtta: ${x.modelCode}${x.modelName ? ' · ' + x.modelName : ''}` : undefined}>
              <Select value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="Seçin" options={d.models.map((m: any) => ({ value: m.id, label: `${m.code} · ${m.name}` }))} />
            </Field>
          </div>
          {!modelId && x.modelCode && (can('model.write')
            ? <div className="mt-3 flex flex-wrap items-center gap-2 text-sm"><span className="text-muted">"{x.modelCode}" sistemde yok.</span>
                <Button variant="secondary" disabled={!allColorsMapped || busy} onClick={() => void createModel()}>Modeli oluştur ({colors.length} renk × {sizes.length} beden)</Button>
                {!allColorsMapped && <span className="text-xs text-muted">Önce renk ve bedenleri eşleştirin.</span>}</div>
            : <p className="mt-3 text-sm text-muted">"{x.modelCode}" sistemde yok; Modelhane'nin modeli tanımlaması gerekiyor.</p>)}
          {model && model.status !== 'TECH_APPROVED' && <p className="mt-2 text-xs text-warn">Model teknik onaylı değil; sipariş taslak olarak kaydedilebilir, onay için model onayı gerekir.</p>}
        </Card>

        <Card title="4 · Adetler" actions={x.sections.length > 1 && (
          <div role="radiogroup" aria-label="Kullanılacak tablo" className="flex flex-wrap gap-1">
            {x.sections.map((s, i) => (
              <button key={i} role="radio" aria-checked={i === sec} onClick={() => setSec(i)} className={clsx('min-h-10 rounded-lg px-3 text-xs font-semibold', i === sec ? 'bg-brand-700 text-white' : 'border border-line text-muted')}>
                {s.kind === 'cut' ? 'Kesilen' : s.kind === 'requested' || s.kind === 'ordered' ? 'İstenen' : 'Diğer'} · {s.title}
              </button>
            ))}
          </div>
        )}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted">
                <th className="py-2 pr-2">Renk (kağıtta → sistemde)</th>
                {sizes.map((s) => (
                  <th key={s} className="px-1 py-2 min-w-20">
                    <div className="font-semibold text-ink">{s}</div>
                    <select aria-label={`${s} bedeni eşleştirmesi`} value={sizeMap[s] ?? ''} onChange={(e) => setSizeMap((m) => ({ ...m, [s]: e.target.value }))}
                      className={clsx('mt-1 w-full rounded border bg-canvas px-1 py-1 text-xs', sizeMap[s] ? 'border-line' : 'border-danger')}>
                      <option value="">—</option>{sizeOpts.map((o: any) => <option key={o.value} value={o.value}>{created[o.value] ?? o.label}</option>)}
                    </select>
                    {!sizeMap[s] && can('model.write') && <button className="mt-1 text-[11px] text-brand-700 dark:text-brand-300 underline" onClick={() => void createSize(s)}>Ekle</button>}
                  </th>
                ))}
                <th className="px-2 py-2 text-right">Toplam</th><th className="px-2 py-2 text-right">Birim fiyat</th>
              </tr></thead>
              <tbody>
                {colors.map((c) => {
                  const src = sectionTotal(c); const sum = rowSum(c); const un = draft.unassigned.find((u) => u.color === c)?.qty ?? 0;
                  return (
                    <tr key={c} className="border-t border-line align-top">
                      <td className="py-2 pr-2">
                        <div className="font-semibold text-ink">{c}</div>
                        <select aria-label={`${c} rengi eşleştirmesi`} value={colorMap[normTr(c)] ?? ''} onChange={(e) => setColorMap((m) => ({ ...m, [normTr(c)]: e.target.value }))}
                          className={clsx('mt-1 w-full max-w-48 rounded border bg-canvas px-1 py-1 text-xs', colorMap[normTr(c)] ? 'border-line' : 'border-danger')}>
                          <option value="">— eşleşmedi —</option>{colorOpts.map((o) => <option key={o.value} value={o.value}>{created[o.value] ?? o.label}</option>)}
                        </select>
                        {!colorMap[normTr(c)] && can('model.write') && <NewColor written={c} onCreate={createColor} />}
                      </td>
                      {sizes.map((s) => (
                        <td key={s} className="px-1 py-2">
                          <input aria-label={`${c} ${s} adet`} inputMode="numeric" value={qty[normTr(c) + '|' + s] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [normTr(c) + '|' + s]: e.target.value.replace(/[^\d]/g, '') }))}
                            className="w-full min-h-10 rounded border border-line bg-canvas px-2 text-right tabular-nums text-ink" />
                        </td>
                      ))}
                      <td className={clsx('px-2 py-2 text-right tabular-nums', sum === src ? 'text-ink' : 'text-warn font-semibold')}>
                        {fmtQty(sum, 0)}<div className="text-[11px] text-muted">kağıtta {fmtQty(src, 0)}{un ? ` · dağıtılmadı ${un}` : ''}</div>
                      </td>
                      <td className="px-2 py-2"><input aria-label={`${c} birim fiyat`} inputMode="decimal" placeholder="0" value={price[normTr(c)] ?? ''}
                        onChange={(e) => setPrice((p) => ({ ...p, [normTr(c)]: e.target.value.replace(',', '.').replace(/[^\d.]/g, '') }))} className="w-24 min-h-10 rounded border border-line bg-canvas px-2 text-right text-ink" /></td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr className="border-t border-line font-semibold"><td className="py-2">Genel toplam</td><td colSpan={sizes.length} />
                <td className="px-2 py-2 text-right tabular-nums">{fmtQty(grand, 0)}<div className="text-[11px] font-normal text-muted">kağıtta {fmtQty(x.sections[sec].lines.reduce((a, l) => a + l.quantity, 0), 0)}{x.sections[sec].printedTotal !== null ? ` · yazan toplam ${fmtQty(x.sections[sec].printedTotal, 0)}` : ''}</div></td><td /></tr></tfoot>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">Bedensiz adetler kağıttaki beden oranıyla yalnızca tam setler halinde dağıtıldı; kalanları siz yerleştirin. Fiyat boşsa 0 kaydedilir.</p>
        </Card>

        <Card title="5 · Not (siparişe eklenecek)">
          <textarea aria-label="Sipariş notu" value={notes} maxLength={2000} rows={8} onChange={(e) => setNotes(e.target.value)} className="w-full rounded-lg border border-line bg-canvas p-3 text-sm text-ink" />
          <p className="mt-1 text-xs text-muted">Ölçü tablosu, kompozisyon ve etiket bilgisi teknik föy bölümü gelene kadar burada saklanır.</p>
        </Card>

        <div className="rounded-xl border border-line bg-surface p-4">
          {problems.length > 0 && <ul className="mb-3 list-disc pl-5 text-sm text-warn">{[...new Set(problems)].map((p) => <li key={p}>{p}</li>)}</ul>}
          <Button disabled={problems.length > 0 || busy} loading={busy} onClick={() => void submit()}>Taslak sipariş oluştur ({fmtQty(grand, 0)} adet)</Button>
          <p className="mt-2 text-xs text-muted">Sipariş TASLAK olarak açılır; onay her zamanki gibi Siparişler ekranından yapılır.</p>
        </div>
      </div>
      <div className="xl:sticky xl:top-20 self-start">
        <Card title="Fotoğraf"><a href={photo} target="_blank" rel="noreferrer"><img src={photo} alt="Okunan föy" className="w-full rounded-lg border border-line" /></a>
          <p className="mt-2 text-xs text-muted">Rakamları buradan karşılaştırın. Büyütmek için dokunun.</p></Card>
      </div>
    </div>
  );
}

function NewColor({ written, onCreate }: { written: string; onCreate: (w: string, code: string, name: string) => Promise<void> }) {
  const cap = written.trim().toLocaleLowerCase('tr-TR').replace(/^./, (ch) => ch.toLocaleUpperCase('tr-TR'));
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState(normSize(normTr(written).slice(0, 3)));
  const [name, setName] = useState(cap);
  if (!open) return <button className="mt-1 block text-[11px] text-brand-700 dark:text-brand-300 underline" onClick={() => setOpen(true)}>Yeni renk olarak ekle</button>;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      <input aria-label="Renk kodu" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="w-16 rounded border border-line bg-canvas px-1 text-xs" />
      <input aria-label="Renk adı" value={name} onChange={(e) => setName(e.target.value)} className="w-28 rounded border border-line bg-canvas px-1 text-xs" />
      <button className="rounded bg-brand-700 px-2 text-xs text-white" onClick={() => void onCreate(written, code, name).then(() => setOpen(false))}>Ekle</button>
    </div>
  );
}
