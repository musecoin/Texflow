import { useState } from 'react';
import { get, post } from '../api.ts';
import { t, fmtQty, fmtMoney, fmtDate, localToday } from '../i18n.ts';
import { useLoad, useCommand, Card, Badge, Button, Field, Input, Select, Table, PageHeader, Loading, ErrorBox, Sheet, Stepper, Kv, Timeline } from '../ui.tsx';
import { go, useCan, useMe } from '../app.tsx';
import { actionLabel } from './dashboard.tsx';

const STATUSES = ['DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'COMPLETED', 'CANCELLED'];

export function OrdersPage() {
  const can = useCan();
  const [status, setStatus] = useState(''); const [q, setQ] = useState(''); const [creating, setCreating] = useState(false);
  const { data, error, loading, reload } = useLoad(() => get(`/api/v1/orders?limit=100${status ? '&status=' + status : ''}${q ? '&q=' + encodeURIComponent(q) : ''}`), [status, q]);
  return (
    <>
      <PageHeader title={t('nav.orders')} subtitle="Müşteri siparişleri ve üretim durumu"
        actions={can('order.create') && <><Button variant="secondary" onClick={() => go('orders/import')}>📷 Fotoğraftan sipariş</Button><Button onClick={() => setCreating(true)}>+ Yeni sipariş</Button></>} />
      <Card>
        <div className="flex flex-wrap gap-2 mb-4">
          <Input placeholder="Sipariş no, müşteri, PO…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" aria-label="Sipariş ara" />
          <Select aria-label="Durum filtresi" value={status} onChange={(e) => setStatus(e.target.value)} placeholder={t('common.all')} options={STATUSES.map((s) => ({ value: s, label: t('status.' + s) }))} className="max-w-[12rem]" />
        </div>
        {error ? <ErrorBox error={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
          <Table rows={data.items} rowKey={(r: any) => r.id} onRow={(r: any) => go('orders/' + r.id)} cols={[
            { h: 'Sipariş', c: (r: any) => <span className="font-semibold">{r.orderNo}</span> },
            { h: 'Müşteri', c: (r: any) => r.customerName },
            { h: 'PO', c: (r: any) => r.customerPo ?? '—' },
            { h: 'Termin', c: (r: any) => fmtDate(r.dueDate) },
            { h: 'Adet', c: (r: any) => fmtQty(r.totalQty, 0), num: true },
            { h: 'Tutar', c: (r: any) => fmtMoney(r.totalAmount, r.currency), num: true },
            { h: t('common.status'), c: (r: any) => <Badge status={r.status} /> },
          ]} />
        )}
      </Card>
      <Sheet open={creating} title="Yeni sipariş" onClose={() => setCreating(false)}>
        {creating && <NewOrderForm onDone={(id) => { setCreating(false); go('orders/' + id); }} />}
      </Sheet>
    </>
  );
}

function NewOrderForm({ onDone }: { onDone: (id: string) => void }) {
  const me = useMe();
  const ref = useLoad(async () => {
    const [customers, models] = await Promise.all([get('/api/v1/customers'), get('/api/v1/models?limit=200')]);
    return { customers: customers.items, models: models.items };
  }, []);
  const [form, setForm] = useState({ customerId: '', factoryId: (me.factories.find((f) => f.code === 'IST1') ?? me.factories[0])?.id ?? '', customerPo: '', currency: 'EUR', orderDate: localToday(), dueDate: '' });
  const [modelId, setModelId] = useState('');
  const model = useLoad(() => (modelId ? get(`/api/v1/models/${modelId}`) : Promise.resolve(null)), [modelId]);
  const [lines, setLines] = useState<Record<string, { qty: string; price: string }>>({});
  const { run, busy } = useCommand();
  if (ref.error) return <ErrorBox error={ref.error} />;
  if (!ref.data) return <Loading />;
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async () => {
    const payloadLines = Object.entries(lines).filter(([, l]) => l.qty && l.qty !== '0').map(([vid, l]) => {
      const v = model.data.variants.find((x: any) => x.id === vid);
      return { modelId, colorId: v.colorId, sizeId: v.sizeId, quantity: l.qty, unitPrice: l.price || '0' };
    });
    const r = await run((k) => post('/api/v1/orders', { ...form, customerPo: form.customerPo || undefined, lines: payloadLines }, { idempotencyKey: k }), 'Sipariş taslak olarak kaydedildi');
    if (r) onDone(r.id);
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Müşteri"><Select required value={form.customerId} onChange={(e) => { set('customerId', e.target.value); const c = ref.data!.customers.find((x: any) => x.id === e.target.value); if (c) set('currency', c.currency); }} placeholder="Seçin" options={ref.data.customers.map((c: any) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Fabrika"><Select required value={form.factoryId} onChange={(e) => set('factoryId', e.target.value)} options={me.factories.map((f) => ({ value: f.id, label: `${f.code} · ${f.name}` }))} /></Field>
        <Field label="Müşteri PO"><Input value={form.customerPo} onChange={(e) => set('customerPo', e.target.value)} /></Field>
        <Field label="Para birimi"><Select value={form.currency} onChange={(e) => set('currency', e.target.value)} options={['EUR', 'USD', 'TRY', 'GBP'].map((c) => ({ value: c, label: c }))} /></Field>
        <Field label="Sipariş tarihi"><Input type="date" required value={form.orderDate} onChange={(e) => set('orderDate', e.target.value)} /></Field>
        <Field label="Termin"><Input type="date" required value={form.dueDate} min={form.orderDate} onChange={(e) => set('dueDate', e.target.value)} /></Field>
      </div>
      <Field label="Model"><Select value={modelId} onChange={(e) => { setModelId(e.target.value); setLines({}); }} placeholder="Model seçin" options={ref.data.models.map((m: any) => ({ value: m.id, label: `${m.code} · ${m.name} (${t('status.' + m.status)})` }))} /></Field>
      {model.data && (
        <div className="rounded-lg border border-line divide-y divide-line">
          <div className="grid grid-cols-[1fr_6rem_6rem] gap-2 px-3 py-2 text-xs font-semibold text-muted"><span>Varyant</span><span>Adet</span><span>Birim fiyat</span></div>
          {model.data.variants.map((v: any) => (
            <div key={v.id} className="grid grid-cols-[1fr_6rem_6rem] gap-2 px-3 py-2 items-center text-sm">
              <span>{v.colorName} / {v.sizeCode}</span>
              <Input aria-label={`${v.sku} adet`} inputMode="numeric" pattern="\d*" value={lines[v.id]?.qty ?? ''} onChange={(e) => setLines((l) => ({ ...l, [v.id]: { qty: e.target.value, price: l[v.id]?.price ?? '' } }))} />
              <Input aria-label={`${v.sku} fiyat`} inputMode="decimal" value={lines[v.id]?.price ?? ''} onChange={(e) => setLines((l) => ({ ...l, [v.id]: { qty: l[v.id]?.qty ?? '', price: e.target.value.replace(',', '.') } }))} />
            </div>
          ))}
        </div>
      )}
      <Button type="submit" loading={busy} disabled={!modelId || !form.customerId || !form.dueDate}>Taslak sipariş oluştur</Button>
    </form>
  );
}

const STEPS = [
  { key: 'AWAITING_CONFIRMATION', label: 'Onay' }, { key: 'AWAITING_WORK_ORDER', label: 'İş emri' }, { key: 'AWAITING_RELEASE', label: 'Serbest bırakma' },
  { key: 'AWAITING_MATERIAL', label: 'Malzeme' }, { key: 'MATERIAL_RESERVED', label: 'Malzeme hazır' },
];

export function OrderDetail({ id }: { id: string }) {
  const can = useCan();
  const { data: o, error, loading, reload } = useLoad(() => get(`/api/v1/orders/${id}`), [id]);
  const audit = useLoad(() => (can('audit.read') ? get(`/api/v1/audit?entityType=sales_order&entityId=${id}`) : Promise.resolve({ items: [] })), [id]);
  const { run, busy } = useCommand();
  const [woOpen, setWoOpen] = useState(false);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !o) return <Loading />;
  const act = async (action: 'confirm' | 'cancel') => {
    const r = await run((k) => post(`/api/v1/orders/${id}/${action}`, { expectedVersion: o.rowVersion }, { idempotencyKey: k }), action === 'confirm' ? 'Sipariş onaylandı' : 'Sipariş iptal edildi');
    if (r) reload();
  };
  const modelColors = [...new Map(o.lines.map((l: any) => [`${l.modelId}|${l.colorId}`, l])).values()] as any[];
  return (
    <>
      <PageHeader title={<span className="flex items-center gap-3">{o.orderNo} <Badge status={o.status} /></span>}
        subtitle={`${o.customerName} · PO ${o.customerPo ?? '—'} · Rev. ${o.revision}`}
        actions={<>
          {o.allowedActions.includes('confirm') && can('order.confirm') && <Button loading={busy} onClick={() => act('confirm')}>Siparişi onayla</Button>}
          {['CONFIRMED', 'IN_PRODUCTION'].includes(o.status) && can('workorder.create') && <Button variant="secondary" onClick={() => setWoOpen(true)}>+ İş emri</Button>}
          {o.allowedActions.includes('cancel') && can('order.cancel') && <Button variant="danger" loading={busy} onClick={() => confirm('Sipariş iptal edilsin mi?') && act('cancel')}>İptal</Button>}
        </>} />
      <div className="mb-4"><Stepper steps={STEPS} current={o.summary.stage} /></div>
      {o.summary.unapprovedModels.length > 0 && <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950 dark:border-amber-800 p-3 text-sm text-amber-900 dark:text-amber-100">Teknik onay bekleyen modeller: {o.summary.unapprovedModels.join(', ')} — iş emri serbest bırakılamaz.</div>}
      <div className="grid gap-4">
        <Card title="Özet"><Kv items={[['Toplam adet', fmtQty(o.summary.totalQty, 0)], ['Tutar', fmtMoney(o.summary.totalAmount, o.currency)], ['Planlanan', fmtQty(o.summary.plannedQty, 0)], ['Planlanmamış', fmtQty(o.summary.unplannedQty, 0)],
          ['Sipariş tarihi', fmtDate(o.orderDate)], ['Termin', fmtDate(o.dueDate)], ['Fabrika', o.factoryCode], ['Aşama', t('stage.' + o.summary.stage)]]} /></Card>
        <Card title="Satırlar">
          <Table rows={o.lines} rowKey={(r: any) => r.id} cols={[
            { h: '#', c: (r: any) => r.lineNo }, { h: 'Model', c: (r: any) => <a className="underline" href={'#/models/' + r.modelId}>{r.modelCode}</a> },
            { h: 'Renk', c: (r: any) => r.colorName }, { h: 'Beden', c: (r: any) => r.sizeCode },
            { h: 'Adet', c: (r: any) => fmtQty(r.quantity, 0), num: true }, { h: 'Fiyat', c: (r: any) => fmtMoney(r.unitPrice, o.currency), num: true }, { h: 'Tutar', c: (r: any) => fmtMoney(r.amount, o.currency), num: true },
          ]} />
        </Card>
        <Card title="İş emirleri">
          <Table rows={o.workOrders} rowKey={(r: any) => r.id} onRow={(r: any) => go('work-orders/' + r.id)} empty="Henüz iş emri yok" cols={[
            { h: 'İş emri', c: (r: any) => <span className="font-semibold">{r.woNo}</span> }, { h: 'Adet', c: (r: any) => fmtQty(r.plannedQty, 0), num: true },
            { h: 'BOM', c: (r: any) => (r.bomVersion ? 'v' + r.bomVersion : '—') }, { h: 'Malzeme karşılama', c: (r: any) => `%${fmtQty(r.coveragePct, 1)} (${r.coveredLines}/${r.materialLines})`, num: true },
            { h: t('common.status'), c: (r: any) => <Badge status={r.status} /> },
          ]} />
        </Card>
        <div className="grid lg:grid-cols-2 gap-4">
          <Card title="Revizyonlar"><Timeline items={o.revisions.map((r: any) => ({ at: r.createdAt, title: `Rev. ${r.revision} — ${r.reason}` }))} /></Card>
          {can('audit.read') && <Card title="Denetim kaydı"><Timeline items={(audit.data?.items ?? []).map((a: any) => ({ at: a.occurredAt, title: actionLabel(a.action), who: a.actorName }))} /></Card>}
        </div>
      </div>
      <Sheet open={woOpen} title="İş emri oluştur" onClose={() => setWoOpen(false)}>
        {woOpen && <NewWorkOrder order={o} options={modelColors} onDone={(wid) => { setWoOpen(false); go('work-orders/' + wid); }} />}
      </Sheet>
    </>
  );
}

function NewWorkOrder({ order, options, onDone }: { order: any; options: any[]; onDone: (id: string) => void }) {
  const [sel, setSel] = useState(options[0] ? `${options[0].modelId}|${options[0].colorId}` : '');
  const [qty, setQty] = useState('');
  const { run, busy } = useCommand();
  const [modelId, colorId] = sel.split('|');
  const ordered = order.lines.filter((l: any) => l.modelId === modelId && l.colorId === colorId).reduce((a: number, l: any) => a + Number(l.quantity), 0);
  return (
    <form className="flex flex-col gap-4" onSubmit={async (e) => {
      e.preventDefault();
      const r = await run((k) => post('/api/v1/work-orders', { salesOrderId: order.id, modelId, colorId, plannedQty: qty }, { idempotencyKey: k }), 'İş emri oluşturuldu');
      if (r) onDone(r.id);
    }}>
      <Field label="Model / renk"><Select value={sel} onChange={(e) => setSel(e.target.value)} options={options.map((l) => ({ value: `${l.modelId}|${l.colorId}`, label: `${l.modelCode} · ${l.colorName}` }))} /></Field>
      <Field label="Planlanan adet" hint={`Siparişte bu model/renk için ${ordered} adet var; daha önce planlanan miktar sunucuda düşülür.`}>
        <Input required inputMode="numeric" pattern="\d+" value={qty} onChange={(e) => setQty(e.target.value)} />
      </Field>
      <Button type="submit" loading={busy}>Oluştur</Button>
    </form>
  );
}
