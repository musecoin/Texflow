import { useState } from 'react';
import { get, post } from '../api.ts';
import { t, fmtQty, fmtDateTime } from '../i18n.ts';
import { useLoad, useCommand, Card, Badge, Button, Field, Input, Select, Table, PageHeader, Loading, ErrorBox, Sheet, Kv } from '../ui.tsx';
import { go, useCan } from '../app.tsx';

export function ModelsPage() {
  const can = useCan();
  const [open, setOpen] = useState(false);
  const { data, error, loading, reload } = useLoad(() => get('/api/v1/models?limit=200'), []);
  return (
    <>
      <PageHeader title={t('nav.models')} subtitle="Teknik onay ve sürümlü reçeteler (BOM)" actions={can('model.write') && <Button onClick={() => setOpen(true)}>+ Yeni model</Button>} />
      <Card>
        {error ? <ErrorBox error={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
          <Table rows={data.items} rowKey={(r: any) => r.id} onRow={(r: any) => go('models/' + r.id)} cols={[
            { h: 'Kod', c: (r: any) => <span className="font-semibold">{r.code}</span> }, { h: 'Ad', c: (r: any) => r.name }, { h: 'Müşteri', c: (r: any) => r.customerName ?? '—' },
            { h: 'Sezon', c: (r: any) => r.season ?? '—' }, { h: 'Varyant', c: (r: any) => r.variantCount, num: true },
            { h: 'Onaylı BOM', c: (r: any) => (r.approvedBomVersion ? 'v' + r.approvedBomVersion : '—') }, { h: t('common.status'), c: (r: any) => <Badge status={r.status} /> },
          ]} />
        )}
      </Card>
      <Sheet open={open} title="Yeni model" onClose={() => setOpen(false)}>{open && <NewModel onDone={(id) => { setOpen(false); go('models/' + id); }} />}</Sheet>
    </>
  );
}

function NewModel({ onDone }: { onDone: (id: string) => void }) {
  const ref = useLoad(async () => {
    const [c, s, cu] = await Promise.all([get('/api/v1/colors'), get('/api/v1/sizes'), get('/api/v1/customers')]);
    return { colors: c.items, sizes: s.items, customers: cu.items };
  }, []);
  const [f, setF] = useState({ code: '', name: '', customerId: '', season: '' });
  const [colors, setColors] = useState<string[]>([]); const [sizes, setSizes] = useState<string[]>([]);
  const { run, busy } = useCommand();
  if (ref.error) return <ErrorBox error={ref.error} />;
  if (!ref.data) return <Loading />;
  const toggle = (arr: string[], set: (x: string[]) => void, id: string) => set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  return (
    <form className="flex flex-col gap-4" onSubmit={async (e) => {
      e.preventDefault();
      const r = await run((k) => post('/api/v1/models', { ...f, customerId: f.customerId || undefined, season: f.season || undefined, colorIds: colors, sizeIds: sizes }, { idempotencyKey: k }), 'Model oluşturuldu');
      if (r) onDone(r.id);
    }}>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Model kodu"><Input required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Model adı"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Müşteri"><Select value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })} placeholder="—" options={ref.data.customers.map((c: any) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Sezon"><Input value={f.season} onChange={(e) => setF({ ...f, season: e.target.value })} placeholder="SS27" /></Field>
      </div>
      <fieldset><legend className="text-sm font-medium mb-2">Renkler</legend><div className="flex flex-wrap gap-2">
        {ref.data.colors.map((c: any) => <ChipToggle key={c.id} on={colors.includes(c.id)} onClick={() => toggle(colors, setColors, c.id)} label={`${c.code} · ${c.name}`} />)}</div></fieldset>
      <fieldset><legend className="text-sm font-medium mb-2">Bedenler</legend><div className="flex flex-wrap gap-2">
        {ref.data.sizes.map((s: any) => <ChipToggle key={s.id} on={sizes.includes(s.id)} onClick={() => toggle(sizes, setSizes, s.id)} label={s.code} />)}</div></fieldset>
      <p className="text-xs text-muted">{colors.length * sizes.length} varyant oluşturulacak (renk × beden).</p>
      <Button type="submit" loading={busy} disabled={!colors.length || !sizes.length}>Oluştur</Button>
    </form>
  );
}

function ChipToggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return <button type="button" aria-pressed={on} onClick={onClick} className={`min-h-11 px-3 rounded-full text-sm ring-1 ring-inset ${on ? 'bg-brand-700 text-white ring-brand-700 dark:bg-brand-400 dark:text-onbrand dark:ring-brand-400' : 'bg-surface text-ink ring-line'}`}>{label}</button>;
}

export function ModelDetail({ id }: { id: string }) {
  const can = useCan();
  const { data: m, error, loading, reload } = useLoad(() => get(`/api/v1/models/${id}`), [id]);
  const [bomId, setBomId] = useState<string | null>(null); const [newBom, setNewBom] = useState(false);
  const { run, busy } = useCommand();
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !m) return <Loading />;
  const act = async (a: string, label: string) => { if (await run((k) => post(`/api/v1/models/${id}/${a}`, { expectedVersion: m.rowVersion }, { idempotencyKey: k }), label)) reload(); };
  return (
    <>
      <PageHeader title={<span className="flex items-center gap-3">{m.code} <Badge status={m.status} /></span>} subtitle={m.name}
        actions={<>
          {m.allowedActions.includes('submit') && can('model.write') && <Button loading={busy} onClick={() => act('submit', 'Teknik onaya gönderildi')}>Teknik onaya gönder</Button>}
          {m.allowedActions.includes('approve') && can('model.approve') && <Button loading={busy} onClick={() => act('approve', 'Teknik onay verildi')}>Teknik onay ver</Button>}
          {m.allowedActions.includes('reject') && can('model.approve') && <Button variant="secondary" loading={busy} onClick={() => act('reject', 'Model taslağa döndü')}>Reddet</Button>}
          {can('bom.write') && <Button variant="secondary" onClick={() => setNewBom(true)}>+ Reçete sürümü</Button>}
        </>} />
      <div className="grid gap-4">
        <Card title="Bilgiler"><Kv items={[['Müşteri', m.customerName ?? '—'], ['Sezon', m.season ?? '—'], ['Revizyon', m.revision], ['Teknik onay', m.approvedAt ? fmtDateTime(m.approvedAt) : '—']]} /></Card>
        <Card title="Reçete (BOM) sürümleri">
          <Table rows={m.boms} rowKey={(r: any) => r.id} onRow={(r: any) => setBomId(r.id)} empty="Henüz reçete yok" cols={[
            { h: 'Sürüm', c: (r: any) => 'v' + r.version }, { h: 'Oluşturma', c: (r: any) => fmtDateTime(r.createdAt) }, { h: 'Onay', c: (r: any) => fmtDateTime(r.approvedAt) },
            { h: t('common.status'), c: (r: any) => <Badge status={r.status} /> },
          ]} />
        </Card>
        <Card title={`Varyantlar (${m.variants.length})`}>
          <div className="flex flex-wrap gap-2">{m.variants.map((v: any) => <span key={v.id} className="text-xs rounded bg-subtle px-2 py-1 font-mono">{v.sku}</span>)}</div>
        </Card>
      </div>
      <Sheet open={!!bomId} title="Reçete" onClose={() => setBomId(null)}>{bomId && <BomView id={bomId} onChanged={reload} />}</Sheet>
      <Sheet open={newBom} title="Yeni reçete sürümü" onClose={() => setNewBom(false)}>{newBom && <NewBom modelId={id} onDone={(bid) => { setNewBom(false); reload(); setBomId(bid); }} />}</Sheet>
    </>
  );
}

function BomView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const can = useCan();
  const { data: b, error, reload } = useLoad(() => get(`/api/v1/boms/${id}`), [id]);
  const { run, busy } = useCommand();
  if (error) return <ErrorBox error={error} />;
  if (!b) return <Loading />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between"><div className="font-semibold">{b.modelCode} · v{b.version} <Badge status={b.status} /></div>
        {b.allowedActions.includes('approve') && can('bom.approve') && <Button loading={busy} onClick={async () => { if (await run((k) => post(`/api/v1/boms/${id}/approve`, { expectedVersion: b.rowVersion }, { idempotencyKey: k }), 'Reçete onaylandı')) { reload(); onChanged(); } }}>Reçeteyi onayla</Button>}</div>
      <Table rows={b.items} rowKey={(r: any) => r.id} cols={[
        { h: 'Malzeme', c: (r: any) => `${r.materialCode} · ${r.materialName}` }, { h: 'Yer', c: (r: any) => r.placement ?? '—' },
        { h: 'Sarfiyat/adet', c: (r: any) => `${fmtQty(r.consumptionPerPiece, 6)} ${r.unit}`, num: true }, { h: 'Fire %', c: (r: any) => fmtQty(r.wastePct, 2), num: true },
      ]} />
      <p className="text-xs text-muted">İhtiyaç formülü: planlanan adet × sarfiyat × (1 + fire/100), 4 haneye yukarı yuvarlanır ve malzemenin ana birimine yalnızca kesin katsayıyla çevrilir.</p>
    </div>
  );
}

function NewBom({ modelId, onDone }: { modelId: string; onDone: (id: string) => void }) {
  const mats = useLoad(() => get('/api/v1/materials'), []);
  const [items, setItems] = useState([{ materialId: '', consumptionPerPiece: '', unit: 'M', wastePct: '0', placement: '' }]);
  const { run, busy } = useCommand();
  if (mats.error) return <ErrorBox error={mats.error} />;
  if (!mats.data) return <Loading />;
  const upd = (i: number, k: string, v: string) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <form className="flex flex-col gap-3" onSubmit={async (e) => {
      e.preventDefault();
      const r = await run((k) => post(`/api/v1/models/${modelId}/boms`, { items: items.map((x) => ({ ...x, placement: x.placement || undefined })) }, { idempotencyKey: k }), 'Reçete taslağı oluşturuldu');
      if (r) onDone(r.id);
    }}>
      {items.map((it, i) => (
        <div key={i} className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end rounded-lg border border-line p-3">
          <Field label="Malzeme" className="col-span-2"><Select required value={it.materialId} placeholder="Seçin" onChange={(e) => { upd(i, 'materialId', e.target.value); const m = mats.data.items.find((x: any) => x.id === e.target.value); if (m) upd(i, 'unit', m.baseUnit); }}
            options={mats.data.items.map((m: any) => ({ value: m.id, label: `${m.code} (${m.baseUnit})` }))} /></Field>
          <Field label="Sarfiyat/adet"><Input required inputMode="decimal" value={it.consumptionPerPiece} onChange={(e) => upd(i, 'consumptionPerPiece', e.target.value.replace(',', '.'))} /></Field>
          <Field label="Birim"><Select value={it.unit} onChange={(e) => upd(i, 'unit', e.target.value)} options={['M', 'CM', 'YD', 'KG', 'G', 'PCS'].map((u) => ({ value: u, label: u }))} /></Field>
          <Field label="Fire %"><Input inputMode="decimal" value={it.wastePct} onChange={(e) => upd(i, 'wastePct', e.target.value.replace(',', '.'))} /></Field>
          <Field label="Yer" className="col-span-2 sm:col-span-4"><Input value={it.placement} onChange={(e) => upd(i, 'placement', e.target.value)} placeholder="Gövde, yaka…" /></Field>
          {items.length > 1 && <Button type="button" variant="ghost" onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}>{t('common.remove')}</Button>}
        </div>
      ))}
      <Button type="button" variant="secondary" onClick={() => setItems((xs) => [...xs, { materialId: '', consumptionPerPiece: '', unit: 'M', wastePct: '0', placement: '' }])}>{t('common.add')}</Button>
      <Button type="submit" loading={busy}>Reçete taslağı kaydet</Button>
    </form>
  );
}
