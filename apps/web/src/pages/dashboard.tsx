import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { get } from '../api.ts';
import { t, fmtQty, fmtDate } from '../i18n.ts';
import { useLoad, Card, Loading, ErrorBox, Timeline, PageHeader } from '../ui.tsx';
import { useMe, useCan, go } from '../app.tsx';

const ACTION_TR: Record<string, string> = {
  'order.create': 'Sipariş oluşturuldu', 'order.confirm': 'Sipariş onaylandı', 'order.cancel': 'Sipariş iptal edildi', 'order.start_production': 'Sipariş üretime alındı',
  'model.create': 'Model oluşturuldu', 'model.submit': 'Model teknik onaya gönderildi', 'model.approve': 'Model teknik onay aldı', 'model.reject': 'Model reddedildi',
  'bom.create': 'Reçete sürümü oluşturuldu', 'bom.approve': 'Reçete onaylandı', 'inventory.receive': 'Kumaş kabul edildi (karantina)', 'inventory.inspect': 'Top muayene edildi',
  'workorder.create': 'İş emri açıldı', 'workorder.release': 'İş emri serbest bırakıldı', 'reservation.create': 'Malzeme rezerve edildi', 'reservation.release': 'Rezervasyon çözüldü',
  'inventory.adjust.request': 'Stok düzeltme talebi', 'inventory.adjust.decide': 'Stok düzeltme kararı', 'auth.login': 'Oturum açıldı', 'auth.logout': 'Oturum kapatıldı',
  'customer.create': 'Müşteri oluşturuldu', 'material.create': 'Malzeme tanımlandı', 'seed.demo_model': 'DEMO verisi',
};
export const actionLabel = (a: string) => ACTION_TR[a] ?? a;

function Kpi({ icon, label, value, hint, tone, pending }: { icon: string; label: string; value: ReactNode; hint?: string; tone?: 'warn' | 'ok'; pending?: string }) {
  return (
    <div className={clsx('rounded-xl border border-line bg-surface/80 p-3.5 flex gap-3', pending && 'opacity-70')}>
      <div className={clsx('size-10 shrink-0 rounded-lg grid place-items-center text-lg', pending ? 'bg-subtle text-muted' : 'bg-brand-400/15 text-brand-700 dark:text-brand-300')} aria-hidden>{icon}</div>
      <div className="min-w-0">
        <div className="text-xs text-muted leading-tight">{label}</div>
        {pending ? <div className="text-sm font-semibold text-muted mt-1">{pending}</div> : (
          <div className={clsx('text-2xl font-bold tabular-nums leading-tight', tone === 'warn' && 'text-amber-600 dark:text-amber-300', tone === 'ok' && 'text-emerald-700 dark:text-emerald-300')}>{value}</div>
        )}
        {hint && <div className="text-[11px] text-muted mt-0.5">{hint}</div>}
      </div>
    </div>
  );
}

type StepState = 'done' | 'active' | 'todo' | 'later';
function Journey({ order }: { order: any }) {
  const s = order.summary.stage as string;
  const rank = ['AWAITING_CONFIRMATION', 'AWAITING_WORK_ORDER', 'AWAITING_RELEASE', 'AWAITING_MATERIAL', 'MATERIAL_RESERVED'].indexOf(s);
  const st = (i: number): StepState => (rank > i ? 'done' : rank === i ? 'active' : 'todo');
  const coverage = order.workOrders.length ? order.workOrders.map((w: any) => `%${fmtQty(w.coveragePct, 0)}`).join(' · ') : '';
  const steps: { label: string; sub?: string; state: StepState }[] = [
    { label: 'Sipariş onayı', sub: order.confirmedAt ? fmtDate(order.confirmedAt) : 'Bekliyor', state: st(0) },
    { label: 'Teknik onay & BOM', sub: order.summary.unapprovedModels.length ? `Bekleyen: ${order.summary.unapprovedModels.join(', ')}` : 'Tamam', state: order.summary.unapprovedModels.length ? 'active' : 'done' },
    { label: 'İş emri', sub: order.workOrders.map((w: any) => w.woNo).join(', ') || 'Açılmadı', state: rank >= 2 ? (rank > 2 ? 'done' : 'active') : 'todo' },
    { label: 'Kumaş kabul, KK & rezervasyon', sub: coverage ? `Karşılama ${coverage}` : 'Bekliyor', state: st(3) === 'done' || s === 'MATERIAL_RESERVED' ? 'done' : rank === 3 ? 'active' : 'todo' },
    { label: 'Pastal & kesim', sub: 'Faz 2', state: 'later' },
    { label: 'Baskı / nakış', sub: 'Faz 3', state: 'later' },
    { label: 'Dikim', sub: 'Faz 3', state: 'later' },
    { label: 'Yıkama, ütü & son işlem', sub: 'Faz 3', state: 'later' },
    { label: 'Kalite & paketleme', sub: 'Faz 3', state: 'later' },
    { label: 'Sevkiyat', sub: `Termin ${fmtDate(order.dueDate)}`, state: 'later' },
  ];
  return (
    <ol className="flex flex-col">
      {steps.map((x, i) => (
        <li key={i} className={clsx('relative flex gap-3 pb-3 last:pb-0', x.state === 'active' && 'rounded-lg bg-brand-400/10 ring-1 ring-brand-400/40 -mx-2 px-2 pt-2')}>
          {i < steps.length - 1 && <span className="absolute left-[11px] top-7 bottom-0 w-0.5 bg-line" aria-hidden />}
          <span aria-hidden className={clsx('relative z-10 size-6 shrink-0 rounded-full grid place-items-center text-xs font-bold',
            x.state === 'done' && 'bg-emerald-500 text-white', x.state === 'active' && 'bg-brand-400 text-onbrand', x.state === 'todo' && 'bg-subtle text-muted ring-1 ring-line', x.state === 'later' && 'bg-subtle text-muted')}>
            {x.state === 'done' ? '✓' : i + 1}
          </span>
          <div className="min-w-0">
            <div className={clsx('text-sm font-semibold', x.state === 'later' ? 'text-muted' : 'text-ink')}>{x.label}</div>
            <div className="text-xs text-muted">{x.state === 'later' ? `Bekliyor · ${x.sub}` : x.sub}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

const STATIONS: { name: string; phase?: string; key?: 'store' | 'qc' }[] = [
  { name: 'Kumaş depo', key: 'store' }, { name: 'Giriş kalite', key: 'qc' }, { name: 'Kesim', phase: 'Faz 2' }, { name: 'Baskı / nakış', phase: 'Faz 3' },
  { name: 'Dikim', phase: 'Faz 3' }, { name: 'Yıkama', phase: 'Faz 3' }, { name: 'Ütü & son işlem', phase: 'Faz 3' }, { name: 'Paketleme', phase: 'Faz 3' },
];
const MODULES: { name: string; items: string[]; status: string; live?: boolean }[] = [
  { name: 'Modelhane & PLM', items: ['Model & varyant', 'Teknik onay', 'Sürümlü BOM'], status: 'Çalışıyor (temel)', live: true },
  { name: 'Depo & stok', items: ['Top QR kimliği', 'Karantina / kabul / red', 'Değiştirilemez defter'], status: 'Çalışıyor', live: true },
  { name: 'Kalite kontrol', items: ['4 puan muayene', 'Plan bazlı kabul', 'AQL'], status: 'Giriş KK çalışıyor', live: true },
  { name: 'Satın alma', items: ['Tedarikçi', 'Sipariş', 'Teslimat'], status: 'Faz 1 devamı' },
  { name: 'Pastal & kesim', items: ['Pastal planı', 'Serim', 'Demet (bundle)'], status: 'Faz 2' },
  { name: 'Maliyet & finans', items: ['Birim maliyet', 'Sipariş marjı', 'Kur geçmişi'], status: 'Faz 4' },
];

export function Dashboard() {
  const me = useMe(); const can = useCan();
  const { data: d, error, loading, reload } = useLoad(() => get('/api/v1/dashboard'), []);
  const focus = useLoad(() => (d?.focusOrderId ? get(`/api/v1/orders/${d.focusOrderId}`) : Promise.resolve(null)), [d?.focusOrderId]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !d) return <Loading />;
  const n = (arr: { status?: string; quality_status?: string; n: number }[], k: string) => arr.find((x) => (x.status ?? x.quality_status) === k)?.n ?? 0;
  const active = n(d.ordersByStatus, 'CONFIRMED') + n(d.ordersByStatus, 'IN_PRODUCTION');
  const rollsTotal = d.rollsByStatus.reduce((a: number, r: any) => a + r.n, 0);
  const inspected = n(d.rollsByStatus, 'ACCEPTED') + n(d.rollsByStatus, 'REJECTED');
  return (
    <>
      <PageHeader title="Fabrika Kontrol Merkezi" subtitle={`Kumaştan son ürüne, üretim süreçleri tek ekranda · ${me.organization.name}`} />

      {/* operator quick actions (phones) */}
      <div className="lg:hidden grid grid-cols-2 gap-2 mb-4">
        {can('inventory.read') && <QuickAction color="bg-emerald-600" icon="⌗" label="QR oku" sub="Top / iş emri" onClick={() => go('scan')} />}
        {can('inventory.receive') && <QuickAction color="bg-sky-600" icon="⇩" label="Top kabulü" sub="Karantinaya giriş" onClick={() => go('inventory')} />}
        <QuickAction color="bg-orange-600" icon="⚠" label="Hata bildir" sub="Faz 3" disabled />
        <QuickAction color="bg-slate-600" icon="⏸" label="Duruş bildir" sub="Faz 3" disabled />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
        <Kpi icon="☰" label="Aktif sipariş" value={active} hint={`${n(d.ordersByStatus, 'DRAFT')} taslak`} />
        <Kpi icon="⚙" label="Serbest iş emri" value={n(d.workOrdersByStatus, 'RELEASED') + n(d.workOrdersByStatus, 'IN_PROGRESS')} hint={`${n(d.workOrdersByStatus, 'PLANNED')} planlı`} />
        <Kpi icon="◷" label="Termin ≤ 14 gün" value={d.dueWithin14Days} tone={d.dueWithin14Days ? 'warn' : undefined} hint="Onaylı / üretimde" />
        <Kpi icon="◫" label="Karantinadaki top" value={n(d.rollsByStatus, 'QUARANTINE')} tone={n(d.rollsByStatus, 'QUARANTINE') ? 'warn' : undefined} hint={`${rollsTotal} top toplam`} />
        <Kpi icon="✓" label="Malzeme karşılama" value={`%${fmtQty(d.materialCoverage.pct, 1)}`} tone={d.materialCoverage.lines && d.materialCoverage.coveredLines === d.materialCoverage.lines ? 'ok' : undefined} hint={`${d.materialCoverage.coveredLines}/${d.materialCoverage.lines} satır tam`} />
        <Kpi icon="◎" label="OEE · kârlılık" value="" pending="Faz 4" hint="Ölçüm verisi henüz yok" />
      </div>

      <div className="grid xl:grid-cols-[1fr_22rem] gap-4">
        <div className="grid gap-4 min-w-0">
          <Card title="Üretim akışı (istasyonlar)">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {STATIONS.map((s) => {
                const live = !!s.key;
                const val = s.key === 'store' ? `${n(d.rollsByStatus, 'ACCEPTED')} top kabul` : s.key === 'qc' ? `${inspected} muayene · ${n(d.rollsByStatus, 'REJECTED')} red` : s.phase;
                return (
                  <div key={s.name} className={clsx('rounded-lg p-3 border', live ? 'border-brand-400/50 bg-brand-400/10 dark:glow' : 'border-line bg-subtle/50')}>
                    <div className="flex items-center gap-2 text-sm font-semibold"><span className={clsx('size-2 rounded-full', live ? 'bg-emerald-400' : 'bg-slate-500')} aria-hidden />{s.name}</div>
                    <div className={clsx('text-xs mt-1', live ? 'text-ink' : 'text-muted')}>{live ? val : `Sonraki faz · ${val}`}</div>
                  </div>
                );
              })}
            </div>
          </Card>
          <div className="grid lg:grid-cols-2 gap-4">
            <Card title={<span className="flex items-center gap-2"><span aria-hidden className="text-brand-500">✦</span>Fabrika asistanı · kural tabanlı uyarılar</span>}>
              <ul className="flex flex-col gap-2">
                {d.alerts.map((a: any, i: number) => (
                  <li key={i}>
                    <a href={a.link ? '#/' + a.link : undefined} className={clsx('flex gap-2 rounded-lg p-2.5 text-sm', a.link && 'hover:bg-subtle')}>
                      <span aria-hidden className={a.level === 'warn' ? 'text-amber-500' : 'text-emerald-500'}>{a.level === 'warn' ? '▲' : '●'}</span>
                      <span><span className="text-ink">{a.text}</span><span className="block text-[11px] text-muted">Kaynak: {a.source}</span></span>
                    </a>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted">Katman 1: deterministik kurallar. İstatistiksel tahmin ve sohbet asistanı Faz 5'te; hiçbir öneri otomatik işlem yapmaz.</p>
            </Card>
            <Card title="Son hareketler">
              <Timeline items={d.recentActivity.slice(0, 6).map((a: any) => ({ at: a.occurredAt, title: actionLabel(a.action), who: a.actorName }))} />
            </Card>
          </div>
        </div>

        <Card title="Siparişin dijital yolculuğu" className="xl:row-span-2">
          {!d.focusOrderId ? <p className="text-sm text-muted">Onaylı veya üretimde sipariş yok.</p> : focus.error ? <ErrorBox error={focus.error} /> : !focus.data ? <Loading /> : (
            <>
              <a href={'#/orders/' + focus.data.id} className="block mb-3 rounded-lg border border-line p-3 hover:bg-subtle">
                <div className="font-bold text-ink">{focus.data.orderNo}</div>
                <div className="text-xs text-muted">{focus.data.customerName} · {fmtQty(focus.data.summary.totalQty, 0)} adet · {t('status.' + focus.data.status)}</div>
              </a>
              <Journey order={focus.data} />
            </>
          )}
        </Card>
      </div>

      <h2 className="mt-6 mb-3 text-sm font-semibold text-muted uppercase tracking-wide">Modüller</h2>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {MODULES.map((m) => (
          <div key={m.name} className={clsx('rounded-xl border p-3', m.live ? 'border-brand-400/40 bg-surface' : 'border-line bg-surface/60')}>
            <div className="font-semibold text-sm text-ink">{m.name}</div>
            <ul className="mt-2 text-xs space-y-1">{m.items.map((i) => <li key={i} className={m.live ? 'text-ink' : 'text-muted'}><span aria-hidden className={m.live ? 'text-emerald-500' : 'text-muted'}>{m.live ? '✓ ' : '○ '}</span>{i}</li>)}</ul>
            <div className={clsx('mt-2 text-[11px] font-semibold', m.live ? 'text-emerald-600 dark:text-emerald-300' : 'text-muted')}>{m.status}</div>
          </div>
        ))}
      </div>
      <details className="mt-6 text-xs text-muted"><summary className="cursor-pointer">KPI tanımları</summary>
        <ul className="mt-2 list-disc pl-5 space-y-1">{Object.entries(d.kpiDefinitions).map(([k, v]) => <li key={k}><b>{k}</b>: {String(v)}</li>)}</ul>
      </details>
    </>
  );
}

function QuickAction({ color, icon, label, sub, onClick, disabled }: { color: string; icon: string; label: string; sub: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className={clsx('rounded-xl min-h-24 p-3 text-white flex flex-col items-center justify-center gap-1 font-semibold active:scale-[0.98] disabled:opacity-45', color)}>
      <span className="text-2xl leading-none" aria-hidden>{icon}</span><span>{label}</span><span className="text-[11px] font-normal opacity-90">{sub}</span>
    </button>
  );
}
