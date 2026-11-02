import { useEffect, useRef, useState } from 'react';
import { get, post, ApiError } from '../api.ts';
import { t, fmtQty, fmtDateTime } from '../i18n.ts';
import { useLoad, useCommand, Card, Badge, Button, Field, Input, Select, Table, PageHeader, Loading, ErrorBox, Sheet, Kv, Timeline, errorText } from '../ui.tsx';
import { go, useCan, useMe } from '../app.tsx';

export function InventoryPage() {
  const can = useCan();
  const [status, setStatus] = useState(''); const [q, setQ] = useState(''); const [recv, setRecv] = useState(false);
  const summary = useLoad(() => get('/api/v1/inventory/summary'), []);
  const rolls = useLoad(() => get(`/api/v1/rolls?limit=100${status ? '&status=' + status : ''}${q ? '&q=' + encodeURIComponent(q) : ''}`), [status, q]);
  return (
    <>
      <PageHeader title={t('nav.inventory')} subtitle="Fiziksel, karantina, rezerve ve kullanılabilir stok ayrı tutulur"
        actions={<>{can('inventory.receive') && <Button onClick={() => setRecv(true)}>+ Top kabulü</Button>}<Button variant="secondary" onClick={() => go('scan')}>QR tara</Button></>} />
      <Card title="Malzeme bazında stok" className="mb-4">
        {summary.error ? <ErrorBox error={summary.error} /> : !summary.data ? <Loading /> : (
          <>
            <Table rows={summary.data.items} rowKey={(r: any) => r.materialId} cols={[
              { h: 'Malzeme', c: (r: any) => <span><b>{r.materialCode}</b> <span className="text-muted">{r.materialName}</span></span> },
              { h: 'Birim', c: (r: any) => r.unit }, { h: 'Fiziksel', c: (r: any) => fmtQty(r.physicalQty, 2), num: true },
              { h: 'Karantina', c: (r: any) => fmtQty(r.quarantineQty, 2), num: true }, { h: 'Red', c: (r: any) => fmtQty(r.rejectedQty, 2), num: true },
              { h: 'Rezerve', c: (r: any) => fmtQty(r.reservedQty, 2), num: true }, { h: 'Kullanılabilir', c: (r: any) => <b>{fmtQty(r.availableQty, 2)}</b>, num: true },
              { h: 'Top', c: (r: any) => r.rollCount, num: true },
            ]} />
            <p className="mt-3 text-xs text-muted">Kullanılabilir = kabul edilmiş fiziksel stok − aktif rezervasyon. Karantinadaki stok rezerve edilemez.</p>
          </>
        )}
      </Card>
      <Card title="Toplar">
        <div className="flex flex-wrap gap-2 mb-4">
          <Input placeholder="Top no, lot, QR…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" aria-label="Top ara" />
          <Select aria-label="Kalite durumu" value={status} onChange={(e) => setStatus(e.target.value)} placeholder={t('common.all')} options={['QUARANTINE', 'ACCEPTED', 'REJECTED'].map((s) => ({ value: s, label: t('status.' + s) }))} className="max-w-[12rem]" />
        </div>
        {rolls.error ? <ErrorBox error={rolls.error} /> : !rolls.data ? <Loading /> : (
          <Table rows={rolls.data.items} rowKey={(r: any) => r.id} onRow={(r: any) => go('rolls/' + r.id)} cols={[
            { h: 'Top', c: (r: any) => <span className="font-semibold">{r.rollNo}</span> }, { h: 'Malzeme', c: (r: any) => r.materialCode }, { h: 'Lot', c: (r: any) => r.lotNo },
            { h: 'Ton', c: (r: any) => r.shade }, { h: 'Fiziksel', c: (r: any) => `${fmtQty(r.physicalQty, 2)} ${r.unit}`, num: true },
            { h: 'Kullanılabilir', c: (r: any) => `${fmtQty(r.availableQty, 2)} ${r.unit}`, num: true }, { h: 'Kalite', c: (r: any) => <Badge status={r.qualityStatus} /> },
          ]} />
        )}
      </Card>
      <Sheet open={recv} title="Kumaş top kabulü" onClose={() => setRecv(false)}>{recv && <ReceiveForm onDone={() => { setRecv(false); summary.reload(); rolls.reload(); }} />}</Sheet>
    </>
  );
}

type RollRow = { materialId: string; lotNo: string; shade: string; colorId: string; widthCm: string; gsm: string; netWeightKg: string; quantity: string; unit: string; allowGsmWidthEstimate: boolean };
const emptyRoll = (): RollRow => ({ materialId: '', lotNo: '', shade: '', colorId: '', widthCm: '', gsm: '', netWeightKg: '', quantity: '', unit: 'M', allowGsmWidthEstimate: false });

function ReceiveForm({ onDone }: { onDone: () => void }) {
  const me = useMe();
  const ref = useLoad(async () => {
    const [f, s, m, c] = await Promise.all([get('/api/v1/factories'), get('/api/v1/suppliers'), get('/api/v1/materials'), get('/api/v1/colors')]);
    return { warehouses: f.warehouses.filter((w: any) => w.kind === 'FABRIC'), suppliers: s.items, materials: m.items.filter((x: any) => x.kind === 'FABRIC'), colors: c.items };
  }, []);
  const [head, setHead] = useState({ supplierId: '', warehouseId: '', supplierDeliveryNote: '' });
  const [rows, setRows] = useState<RollRow[]>([emptyRoll()]);
  const [result, setResult] = useState<any>(null);
  const { run, busy } = useCommand();
  if (ref.error) return <ErrorBox error={ref.error} />;
  if (!ref.data) return <Loading />;
  if (result) return (
    <div className="flex flex-col gap-3">
      <div role="status" className="rounded-lg bg-emerald-50 dark:bg-emerald-950 border border-emerald-300 p-3 text-sm">Sunucu onayladı: {result.receiptNo} — {result.rolls.length} top karantinaya alındı.</div>
      <ul className="text-sm divide-y divide-line">{result.rolls.map((r: any) => <li key={r.id} className="py-2 flex justify-between"><a className="underline" href={'#/rolls/' + r.id}>{r.rollNo}</a><span className="tabular-nums">{fmtQty(r.quantity)} {r.unit}{r.quantityBasis.method === 'GSM_WIDTH' ? ' (GSM/en tahmini)' : ''}</span></li>)}</ul>
      <Button onClick={onDone}>{t('common.close')}</Button>
    </div>
  );
  const wh = ref.data.warehouses.find((w: any) => w.id === head.warehouseId);
  const upd = (i: number, patch: Partial<RollRow>) => setRows((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <form className="flex flex-col gap-4" onSubmit={async (e) => {
      e.preventDefault();
      const payload = { factoryId: wh.factoryId, supplierId: head.supplierId, warehouseId: head.warehouseId, supplierDeliveryNote: head.supplierDeliveryNote || undefined,
        rolls: rows.map((r) => ({ materialId: r.materialId, lotNo: r.lotNo, shade: r.shade, colorId: r.colorId || undefined, widthCm: r.widthCm || undefined, gsm: r.gsm || undefined,
          netWeightKg: r.netWeightKg || undefined, quantity: r.quantity, unit: r.unit, allowGsmWidthEstimate: r.allowGsmWidthEstimate })) };
      const res = await run((k) => post('/api/v1/receipts', payload, { idempotencyKey: k }));
      if (res) setResult(res);
    }}>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Tedarikçi"><Select required value={head.supplierId} placeholder="Seçin" onChange={(e) => setHead({ ...head, supplierId: e.target.value })} options={ref.data.suppliers.map((s: any) => ({ value: s.id, label: s.name }))} /></Field>
        <Field label="Depo"><Select required value={head.warehouseId} placeholder="Seçin" onChange={(e) => setHead({ ...head, warehouseId: e.target.value })} options={ref.data.warehouses.filter((w: any) => me.factories.some((f) => f.id === w.factoryId)).map((w: any) => ({ value: w.id, label: `${w.code} · ${w.name}` }))} /></Field>
        <Field label="İrsaliye no"><Input value={head.supplierDeliveryNote} onChange={(e) => setHead({ ...head, supplierDeliveryNote: e.target.value })} /></Field>
      </div>
      {rows.map((r, i) => {
        const mat = ref.data!.materials.find((m: any) => m.id === r.materialId);
        const crossUnit = mat && ((mat.baseUnit === 'M' && r.unit === 'KG') || (mat.baseUnit === 'KG' && r.unit === 'M'));
        return (
          <fieldset key={i} className="rounded-lg border border-line p-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <legend className="px-1 text-xs font-semibold text-muted">Top {i + 1}</legend>
            <Field label="Malzeme" className="col-span-2"><Select required value={r.materialId} placeholder="Seçin" onChange={(e) => { const m = ref.data!.materials.find((x: any) => x.id === e.target.value); upd(i, { materialId: e.target.value, unit: m?.baseUnit ?? 'M', widthCm: m?.widthCm ?? '', gsm: m?.gsm ?? '' }); }}
              options={ref.data!.materials.map((m: any) => ({ value: m.id, label: `${m.code} (${m.baseUnit})` }))} /></Field>
            <Field label="Lot"><Input required value={r.lotNo} onChange={(e) => upd(i, { lotNo: e.target.value })} /></Field>
            <Field label="Ton (shade)"><Input required value={r.shade} onChange={(e) => upd(i, { shade: e.target.value.toUpperCase() })} /></Field>
            <Field label="Renk"><Select value={r.colorId} placeholder="—" onChange={(e) => upd(i, { colorId: e.target.value })} options={ref.data!.colors.map((c: any) => ({ value: c.id, label: c.name }))} /></Field>
            <Field label="En (cm)"><Input inputMode="decimal" value={r.widthCm} onChange={(e) => upd(i, { widthCm: e.target.value.replace(',', '.') })} /></Field>
            <Field label="Gramaj (g/m²)"><Input inputMode="decimal" value={r.gsm} onChange={(e) => upd(i, { gsm: e.target.value.replace(',', '.') })} /></Field>
            <Field label="Net kg"><Input inputMode="decimal" value={r.netWeightKg} onChange={(e) => upd(i, { netWeightKg: e.target.value.replace(',', '.') })} /></Field>
            <Field label="Miktar"><Input required inputMode="decimal" value={r.quantity} onChange={(e) => upd(i, { quantity: e.target.value.replace(',', '.') })} /></Field>
            <Field label="Birim"><Select value={r.unit} onChange={(e) => upd(i, { unit: e.target.value })} options={['M', 'YD', 'KG'].map((u) => ({ value: u, label: u }))} /></Field>
            {crossUnit && (
              <label className="col-span-2 sm:col-span-4 flex items-start gap-2 text-xs rounded bg-amber-50 dark:bg-amber-950 p-2">
                <input type="checkbox" className="mt-0.5 size-5" checked={r.allowGsmWidthEstimate} onChange={(e) => upd(i, { allowGsmWidthEstimate: e.target.checked })} />
                <span>Malzeme ana birimi {mat.baseUnit}. {r.unit} → {mat.baseUnit} dönüşümü yalnızca en ve gramaj ile <b>tahmini</b> yapılabilir (m = kg×1000 / (GSM × en_m)). Onaylıyorum; dayanak kayda yazılır.</span>
              </label>
            )}
            {rows.length > 1 && <Button type="button" variant="ghost" className="col-span-2 sm:col-span-4" onClick={() => setRows((xs) => xs.filter((_, j) => j !== i))}>{t('common.remove')}</Button>}
          </fieldset>
        );
      })}
      <Button type="button" variant="secondary" onClick={() => setRows((xs) => [...xs, { ...xs[xs.length - 1], quantity: '', netWeightKg: '' }])}>+ Top ekle (öncekini kopyala)</Button>
      <Button type="submit" loading={busy} disabled={!wh}>Kabul et → karantina</Button>
    </form>
  );
}

export function RollDetail({ id }: { id: string }) {
  const can = useCan();
  const { data: r, error, loading, reload } = useLoad(() => get(`/api/v1/rolls/${id}`), [id]);
  const [inspect, setInspect] = useState(false);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !r) return <Loading />;
  return (
    <>
      <PageHeader title={<span className="flex items-center gap-3">{r.rollNo} <Badge status={r.qualityStatus} /></span>} subtitle={`${r.materialCode} · ${r.materialName}`}
        actions={r.allowedActions.includes('inspect') && can('inventory.inspect') && <Button onClick={() => setInspect(true)}>4 puan muayene</Button>} />
      <div className="grid gap-4">
        <Card title="Top kimliği">
          <Kv items={[['QR', <code className="text-xs break-all">{r.qrCode}</code>], ['Lot / boya lotu', `${r.lotNo}${r.dyeLot ? ' / ' + r.dyeLot : ''}`], ['Ton', r.shade], ['Renk', r.colorCode ?? '—'],
            ['Tedarikçi', r.supplierName], ['Kabul fişi', r.receiptNo], ['Depo / göz', `${r.warehouseCode} / ${r.binCode ?? '—'}`], ['Kabul tarihi', fmtDateTime(r.receivedAt)],
            ['En', r.widthCm ? `${fmtQty(r.widthCm, 2)} cm` : '—'], ['Gramaj', r.gsm ? `${fmtQty(r.gsm, 2)} g/m²` : '—'], ['Brüt / net kg', `${fmtQty(r.grossWeightKg)} / ${fmtQty(r.netWeightKg)}`],
            ['Miktar dayanağı', r.quantityBasis?.method === 'GSM_WIDTH' ? 'GSM/en tahmini' : 'Ölçülen']]} />
        </Card>
        <Card title="Stok">
          <Kv items={[['Kabul edilen', `${fmtQty(r.receivedQty)} ${r.unit}`], ['Fiziksel', `${fmtQty(r.physicalQty)} ${r.unit}`], ['Rezerve', `${fmtQty(r.reservedQty)} ${r.unit}`], ['Kullanılabilir', `${fmtQty(r.availableQty)} ${r.unit}`]]} />
        </Card>
        {r.inspections.map((i: any) => (
          <Card key={i.id} title={<span className="flex items-center gap-2">Muayene · {fmtDateTime(i.inspectedAt)} <Badge status={i.result} /></span>}>
            <Kv items={[['Puan', i.totalPoints], ['Puan / 100 yd²', fmtQty(i.pointsPer100SqYd, 2)], ['Limit (plan)', `${fmtQty(i.thresholdSnapshot.maxPointsPer100SqYd, 2)} · ${i.thresholdSnapshot.planCode}`],
              ['Başarısız kontroller', i.failedChecks.join(', ') || '—'], ['Ölçülen gramaj', fmtQty(i.measuredGsm)], ['Ölçülen en', fmtQty(i.measuredWidthCm)], ['Çekme (boy/en)', `${fmtQty(i.shrinkageLengthPct)} / ${fmtQty(i.shrinkageWidthPct)} %`], ['Ton', i.shadeResult ?? '—']]} />
          </Card>
        ))}
        <Card title="Hareket geçmişi (defter)">
          <Timeline items={r.movements.map((m: any) => ({ at: m.occurredAt, who: m.actorName, title: `${t('mv.' + m.movementType)} · ${t('status.' + m.stockStatus)}`,
            detail: <span className="tabular-nums">{m.qtyDelta !== '0.0000' && `Fiziksel ${m.qtyDelta.startsWith('-') ? '' : '+'}${fmtQty(m.qtyDelta)} ${m.unit}`} {m.reservedDelta !== '0.0000' && `Rezerve ${m.reservedDelta.startsWith('-') ? '' : '+'}${fmtQty(m.reservedDelta)} ${m.unit}`} {m.reason ? `· ${m.reason}` : ''}</span> }))} />
        </Card>
      </div>
      <Sheet open={inspect} title={`${r.rollNo} — 4 puan muayene`} onClose={() => setInspect(false)}>{inspect && <InspectForm roll={r} onDone={() => { setInspect(false); reload(); }} />}</Sheet>
    </>
  );
}

function InspectForm({ roll, onDone }: { roll: any; onDone: () => void }) {
  const [f, setF] = useState({ inspectedLengthM: roll.unit === 'M' ? roll.physicalQty.replace(/\.?0+$/, '') : '', cuttableWidthCm: roll.widthCm ?? '', measuredGsm: '', measuredWidthCm: '', shrinkageLengthPct: '', shrinkageWidthPct: '', shadeResult: 'MATCH', notes: '' });
  const [defects, setDefects] = useState<{ code: string; lengthIn: string; isHole: boolean; positionM: string }[]>([]);
  const [result, setResult] = useState<any>(null);
  const { run, busy } = useCommand();
  if (result) return (
    <div className="flex flex-col gap-3">
      <div role="status" className={`rounded-lg p-3 text-sm border ${result.inspection.result === 'PASS' ? 'bg-emerald-50 border-emerald-300 dark:bg-emerald-950' : 'bg-red-50 border-red-300 dark:bg-red-950'}`}>
        Sonuç: <b>{t('status.' + result.inspection.result)}</b> — {result.inspection.totalPoints} puan, {fmtQty(result.inspection.pointsPer100SqYd, 2)} puan/100 yd². Top durumu: {t('status.' + result.roll.qualityStatus)}.
        {result.inspection.failedChecks.length > 0 && <> Başarısız: {result.inspection.failedChecks.join(', ')}.</>}
      </div>
      <Button onClick={onDone}>{t('common.close')}</Button>
    </div>
  );
  const opt = (v: string) => (v.trim() ? v.replace(',', '.') : undefined);
  return (
    <form className="flex flex-col gap-4" onSubmit={async (e) => {
      e.preventDefault();
      const body = { inspectedLengthM: f.inspectedLengthM.replace(',', '.'), cuttableWidthCm: f.cuttableWidthCm.replace(',', '.'), measuredGsm: opt(f.measuredGsm), measuredWidthCm: opt(f.measuredWidthCm),
        shrinkageLengthPct: opt(f.shrinkageLengthPct), shrinkageWidthPct: opt(f.shrinkageWidthPct), shadeResult: f.shadeResult, notes: f.notes || undefined, expectedVersion: roll.rowVersion,
        defects: defects.map((d) => ({ code: d.code || 'HATA', isHole: d.isHole, lengthIn: d.isHole ? undefined : opt(d.lengthIn), positionM: opt(d.positionM) })) };
      const r = await run((k) => post(`/api/v1/rolls/${roll.id}/inspections`, body, { idempotencyKey: k }));
      if (r) setResult(r);
    }}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Muayene edilen boy (m)"><Input required inputMode="decimal" value={f.inspectedLengthM} onChange={(e) => setF({ ...f, inspectedLengthM: e.target.value })} /></Field>
        <Field label="Kesilebilir en (cm)"><Input required inputMode="decimal" value={f.cuttableWidthCm} onChange={(e) => setF({ ...f, cuttableWidthCm: e.target.value })} /></Field>
        <Field label="Ölçülen gramaj"><Input inputMode="decimal" value={f.measuredGsm} onChange={(e) => setF({ ...f, measuredGsm: e.target.value })} /></Field>
        <Field label="Ölçülen en (cm)"><Input inputMode="decimal" value={f.measuredWidthCm} onChange={(e) => setF({ ...f, measuredWidthCm: e.target.value })} /></Field>
        <Field label="Çekme boy %"><Input inputMode="decimal" value={f.shrinkageLengthPct} onChange={(e) => setF({ ...f, shrinkageLengthPct: e.target.value })} /></Field>
        <Field label="Çekme en %"><Input inputMode="decimal" value={f.shrinkageWidthPct} onChange={(e) => setF({ ...f, shrinkageWidthPct: e.target.value })} /></Field>
        <Field label="Ton kontrolü" className="col-span-2"><Select value={f.shadeResult} onChange={(e) => setF({ ...f, shadeResult: e.target.value })} options={[{ value: 'MATCH', label: 'Uygun' }, { value: 'MINOR_VARIATION', label: 'Hafif fark' }, { value: 'REJECT', label: 'Red' }]} /></Field>
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">Hatalar ({defects.length}) — puan: ≤3" 1 · 3–6" 2 · 6–9" 3 · &gt;9" veya delik 4 (yarda başına en fazla 4)</div>
        {defects.map((d, i) => (
          <div key={i} className="grid grid-cols-[1fr_5rem_5rem_auto_auto] gap-2 items-center">
            <Input aria-label="Hata kodu" placeholder="Kod" value={d.code} onChange={(e) => setDefects((xs) => xs.map((x, j) => (j === i ? { ...x, code: e.target.value.toUpperCase() } : x)))} />
            <Input aria-label="Uzunluk (inç)" placeholder='inç' inputMode="decimal" disabled={d.isHole} value={d.lengthIn} onChange={(e) => setDefects((xs) => xs.map((x, j) => (j === i ? { ...x, lengthIn: e.target.value } : x)))} />
            <Input aria-label="Konum (m)" placeholder="m" inputMode="decimal" value={d.positionM} onChange={(e) => setDefects((xs) => xs.map((x, j) => (j === i ? { ...x, positionM: e.target.value } : x)))} />
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" className="size-5" checked={d.isHole} onChange={(e) => setDefects((xs) => xs.map((x, j) => (j === i ? { ...x, isHole: e.target.checked } : x)))} />Delik</label>
            <Button type="button" variant="ghost" aria-label="Hatayı kaldır" onClick={() => setDefects((xs) => xs.filter((_, j) => j !== i))}>✕</Button>
          </div>
        ))}
        <Button type="button" variant="secondary" onClick={() => setDefects((xs) => [...xs, { code: '', lengthIn: '', isHole: false, positionM: '' }])}>+ Hata ekle</Button>
      </div>
      <Field label="Not"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <p className="text-xs text-muted">Kabul/red kararı malzemeye bağlı muayene planındaki limitlerle sunucuda verilir; evrensel bir eşik varsayılmaz.</p>
      <Button type="submit" loading={busy}>Muayeneyi kaydet</Button>
    </form>
  );
}

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
/** QR lookup. Uses the camera via BarcodeDetector where available; manual entry always works. Native scanning arrives with the Capacitor build. */
export function ScanPage() {
  const [code, setCode] = useState(''); const [err, setErr] = useState<string | null>(null); const [cam, setCam] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const lookup = async (raw: string) => {
    setErr(null);
    try { const r = await get(`/api/v1/rolls/by-qr/${encodeURIComponent(raw.trim())}`); go('rolls/' + r.id); }
    catch (e) { setErr(e instanceof ApiError && e.status === 404 ? 'Bu QR koduna ait top bulunamadı' : errorText(e)); }
  };
  useEffect(() => {
    if (!cam) return;
    // Android app: native scanner plugin (@capacitor/barcode-scanner), hint 0 = QR_CODE
    const native = (globalThis as { Capacitor?: { Plugins?: Record<string, any> } }).Capacitor?.Plugins?.CapacitorBarcodeScanner;
    if (native) {
      native.scanBarcode({ hint: 0, scanInstructions: 'Top etiketindeki QR kodu okutun' })
        .then((r: { ScanResult?: string }) => { setCam(false); if (r?.ScanResult) void lookup(r.ScanResult); })
        .catch((e: Error) => { setCam(false); setErr('Tarama iptal edildi veya kamera izni yok: ' + e.message); });
      return;
    }
    const BD = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    if (!BD) { setErr('Bu tarayıcı kamera ile QR okumayı desteklemiyor; kodu elle girin.'); setCam(false); return; }
    let stream: MediaStream | null = null; let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        const det = new BD({ formats: ['qr_code'] });
        while (!stop && video.current) {
          const found = await det.detect(video.current).catch(() => []);
          if (found[0]) { stop = true; await lookup(found[0].rawValue); break; }
          await new Promise((r) => setTimeout(r, 300));
        }
      } catch (e) { setErr('Kamera açılamadı: ' + (e as Error).message); setCam(false); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((tr) => tr.stop()); };
  }, [cam]);
  return (
    <>
      <PageHeader title={t('nav.scan')} subtitle="Top etiketindeki QR kodu okutun veya girin" />
      <Card>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void lookup(code); }}>
          <Field label="QR / top kodu"><Input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="TFROLL:…" className="text-lg" /></Field>
          <div className="grid grid-cols-2 gap-2"><Button type="submit" className="min-h-14 text-base">Bul</Button><Button type="button" variant="secondary" className="min-h-14 text-base" onClick={() => setCam((c) => !c)}>{cam ? 'Kamerayı kapat' : 'Kamera ile tara'}</Button></div>
          {err && <div role="alert" className="text-sm text-red-700 dark:text-red-300">{err}</div>}
          {cam && !(globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor?.Plugins?.CapacitorBarcodeScanner && <video ref={video} className="w-full rounded-lg bg-black aspect-video" muted playsInline />}
        </form>
      </Card>
    </>
  );
}
