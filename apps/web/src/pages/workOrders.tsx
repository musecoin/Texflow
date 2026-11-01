import { useState } from 'react';
import { get, post } from '../api.ts';
import { t, fmtQty, fmtDateTime } from '../i18n.ts';
import { useLoad, useCommand, Card, Badge, Button, Field, Input, Table, PageHeader, Loading, ErrorBox, Sheet, Kv } from '../ui.tsx';
import { go, useCan } from '../app.tsx';

export function WorkOrdersPage() {
  const { data, error, loading, reload } = useLoad(() => get('/api/v1/work-orders?limit=100'), []);
  return (
    <>
      <PageHeader title={t('nav.workOrders')} subtitle="İş emri kartları — serbest bırakılınca onaylı reçetenin anlık görüntüsü kilitlenir" />
      {error ? <ErrorBox error={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {data.items.length === 0 && <Card><p className="text-sm text-muted">Henüz iş emri yok. Onaylı bir siparişten iş emri açın.</p></Card>}
          {data.items.map((w: any) => (
            <button key={w.id} onClick={() => go('work-orders/' + w.id)} className="text-left rounded-xl border border-line bg-surface p-4 active:bg-subtle hover:border-brand-500 min-h-24">
              <div className="flex items-center justify-between gap-2"><span className="font-bold text-ink">{w.woNo}</span><Badge status={w.status} /></div>
              <div className="mt-1 text-sm text-muted">{w.orderNo} · {w.modelCode} · {w.colorCode}</div>
              <div className="mt-3 flex items-center justify-between text-sm"><span className="tabular-nums font-semibold">{fmtQty(w.plannedQty, 0)} adet</span>
                <span className="text-muted">Malzeme %{w.coveragePct != null ? fmtQty(w.coveragePct, 1) : '—'}</span></div>
              <div className="mt-2 h-2 rounded-full bg-subtle overflow-hidden" aria-hidden><div className="h-full bg-brand-600" style={{ width: `${Math.min(100, Number(w.coveragePct ?? 0))}%` }} /></div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function WorkOrderDetail({ id }: { id: string }) {
  const can = useCan();
  const { data: w, error, loading, reload } = useLoad(() => get(`/api/v1/work-orders/${id}`), [id]);
  const { run, busy } = useCommand();
  const [scanFor, setScanFor] = useState<any>(null);
  const [last, setLast] = useState<any>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !w) return <Loading />;
  const release = async () => { if (await run((k) => post(`/api/v1/work-orders/${id}/release`, { expectedVersion: w.rowVersion }, { idempotencyKey: k }), 'İş emri serbest bırakıldı; malzeme ihtiyacı hesaplandı')) reload(); };
  const reserve = async (m: any) => {
    const r = await run((k) => post(`/api/v1/work-orders/${id}/materials/${m.id}/reserve`, { policy: 'FIFO', allowPartial: true, singleShade: true }, { idempotencyKey: k }));
    if (r) { setLast({ material: m.materialCode, ...r }); reload(); }
  };
  const releaseRes = async (rid: string) => { if (await run((k) => post(`/api/v1/reservations/${rid}/release`, { reason: 'Kullanıcı tarafından çözüldü' }, { idempotencyKey: k }), 'Rezervasyon çözüldü')) reload(); };
  const canReserve = ['RELEASED', 'IN_PROGRESS'].includes(w.status) && can('reservation.create');
  return (
    <>
      <PageHeader title={<span className="flex items-center gap-3">{w.woNo} <Badge status={w.status} /></span>}
        subtitle={<><a className="underline" href={'#/orders/' + w.salesOrderId}>{w.orderNo}</a> · {w.modelCode} {w.modelName} · {w.colorName}</>}
        actions={w.allowedActions.includes('release') && can('workorder.release') && <Button loading={busy} onClick={release}>Serbest bırak</Button>} />
      {last && (
        <div role="status" className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 dark:bg-emerald-950 p-3 text-sm">
          Sunucu onayladı — {last.material}: {last.reservations.map((x: any) => `${x.rollNo} (${fmtQty(x.qty)}, ton ${x.shade})`).join(', ')}.
          {last.shortfallQty !== '0' && <> Eksik: <b>{fmtQty(last.shortfallQty)}</b>.</>} {last.shadeLock && <>Ton kilidi: {last.shadeLock}.</>}
        </div>
      )}
      <div className="grid gap-4">
        <Card title="Bilgiler"><Kv items={[['Planlanan', `${fmtQty(w.plannedQty, 0)} adet`], ['BOM', w.bomVersion ? 'v' + w.bomVersion : 'Serbest bırakılmadı'], ['Serbest bırakma', fmtDateTime(w.releasedAt)], ['Sipariş durumu', t('status.' + w.orderStatus)]]} /></Card>
        <Card title="Malzeme ihtiyacı ve rezervasyon">
          {w.materials.length === 0 ? <p className="text-sm text-muted">İhtiyaçlar iş emri serbest bırakıldığında onaylı reçeteden hesaplanır.</p> : (
            <div className="grid gap-3">
              {w.materials.map((m: any) => (
                <div key={m.id} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2"><div className="font-semibold">{m.materialCode} <span className="font-normal text-muted">{m.materialName}</span></div>
                    {m.shadeLock && <span className="text-xs rounded bg-subtle px-2 py-1">Ton kilidi: {m.shadeLock}</span>}</div>
                  <dl className="mt-2 grid grid-cols-2 sm:grid-cols-5 gap-2 text-sm">
                    <div><dt className="text-xs text-muted">İhtiyaç</dt><dd className="tabular-nums font-medium">{fmtQty(m.requiredQty)} {m.unit}</dd></div>
                    <div><dt className="text-xs text-muted">Rezerve</dt><dd className="tabular-nums font-medium">{fmtQty(m.reservedQty)} {m.unit}</dd></div>
                    <div><dt className="text-xs text-muted">Eksik</dt><dd className={`tabular-nums font-medium ${m.shortfallQty !== '0' ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>{fmtQty(m.shortfallQty)} {m.unit}</dd></div>
                    <div><dt className="text-xs text-muted">Kullanılabilir stok</dt><dd className="tabular-nums">{fmtQty(m.availableStock)}</dd></div>
                    <div><dt className="text-xs text-muted">Karantinada</dt><dd className="tabular-nums">{fmtQty(m.quarantineStock)}</dd></div>
                  </dl>
                  {canReserve && m.shortfallQty !== '0' && (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button loading={busy} onClick={() => reserve(m)}>FIFO rezerve et</Button>
                      <Button variant="secondary" onClick={() => setScanFor(m)}>Top okut</Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Rezervasyonlar">
          <Table rows={w.reservations} rowKey={(r: any) => r.id} empty="Rezervasyon yok" cols={[
            { h: 'Top', c: (r: any) => r.rollNo }, { h: 'Lot', c: (r: any) => r.lotNo }, { h: 'Ton', c: (r: any) => r.shade },
            { h: 'Miktar', c: (r: any) => `${fmtQty(r.qty)} ${r.unit}`, num: true }, { h: 'Politika', c: (r: any) => r.allocationPolicy },
            { h: t('common.status'), c: (r: any) => <Badge status={r.status} /> },
            { h: '', c: (r: any) => (r.status === 'ACTIVE' && can('reservation.release') ? <Button variant="ghost" onClick={(e) => { e.stopPropagation(); void releaseRes(r.id); }}>Çöz</Button> : null) },
          ]} />
        </Card>
        {w.bomSnapshot && <details className="text-xs text-muted"><summary className="cursor-pointer">BOM anlık görüntüsü (v{w.bomVersion}, {fmtDateTime(w.bomSnapshot.snapshotAt)})</summary><pre className="mt-2 overflow-x-auto rounded bg-subtle p-3">{JSON.stringify(w.bomSnapshot.items.map((i: any) => ({ malzeme: i.materialCode, sarfiyat: i.consumptionPerPiece, birim: i.unit, fire: i.wastePct })), null, 2)}</pre></details>}
      </div>
      <Sheet open={!!scanFor} title={`Top okut — ${scanFor?.materialCode ?? ''}`} onClose={() => setScanFor(null)}>{scanFor && <ScanReserve woId={id} wm={scanFor} onDone={() => { setScanFor(null); reload(); }} />}</Sheet>
    </>
  );
}

function ScanReserve({ woId, wm, onDone }: { woId: string; wm: any; onDone: () => void }) {
  const [qr, setQr] = useState(''); const [qty, setQty] = useState('');
  const { run, busy } = useCommand();
  return (
    <form className="flex flex-col gap-3" onSubmit={async (e) => {
      e.preventDefault();
      const roll = await run(() => get(`/api/v1/rolls/by-qr/${encodeURIComponent(qr.trim())}`));
      if (!roll) return;
      const r = await run((k) => post(`/api/v1/work-orders/${woId}/materials/${wm.id}/reserve`, { rollId: roll.id, qty: qty || undefined, singleShade: true }, { idempotencyKey: k }), `${roll.rollNo} rezerve edildi`);
      if (r) onDone();
    }}>
      <Field label="QR kodu" hint="El terminali / kamera okuyucu bu alana yazar."><Input autoFocus required value={qr} onChange={(e) => setQr(e.target.value)} className="text-lg" /></Field>
      <Field label={`Miktar (${wm.unit}) — boş bırakılırsa kalan ihtiyaç kadar`}><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(',', '.'))} /></Field>
      <Button type="submit" loading={busy} className="min-h-14 text-base">Rezerve et</Button>
    </form>
  );
}
