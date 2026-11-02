/**
 * TEXFLOW 3.1 role-based home screens: Fabrika Yönetimi, Üretim, Depo, Operatör.
 * All numbers come from GET /api/v1/home (permission- and factory-scoped). Anything the system
 * does not record yet is shown as "ölçülmüyor" with the reason — never estimated.
 */
import { useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { get } from '../api.ts';
import { t, fmtQty, fmtDate, fmtDateTime, fmtMoney } from '../i18n.ts';
import { useLoad, Card, Loading, ErrorBox, PageHeader, Badge, Select, Field, Table } from '../ui.tsx';
import { useMe, useCan, go } from '../app.tsx';
import { Kpi, Journey } from './dashboard.tsx';

type Panel = 'factory' | 'production' | 'warehouse' | 'operator';
const PANEL_LABEL: Record<Panel, string> = { factory: 'Fabrika Yönetimi', production: 'Üretim', warehouse: 'Depo', operator: 'Operatör' };
const PANEL_TITLE: Record<Panel, string> = { factory: 'Fabrika Yönetim Paneli', production: 'Üretim Müdürü Paneli', warehouse: 'Depo Paneli', operator: 'Operatör Paneli' };
const UNIT: Record<string, string> = { M: 'm', KG: 'kg', PCS: 'adet' };
const u = (x: string) => UNIT[x] ?? x;
const MV: Record<string, string> = { RECEIPT: 'Mal kabul', QC_RELEASE: 'KK kabul', QC_REJECT: 'KK red', RESERVE: 'Rezervasyon', UNRESERVE: 'Rezervasyon iptali', ISSUE: 'Çıkış', ADJUSTMENT: 'Düzeltme', TRANSFER_OUT: 'Transfer çıkış', TRANSFER_IN: 'Transfer giriş' };

const readPanel = (): Panel | null => { try { return (localStorage.getItem('texflow.homePanel') as Panel) || null; } catch { return null; } };
const savePanel = (p: Panel) => { try { localStorage.setItem('texflow.homePanel', p); } catch { /* ignore */ } };

export function Home() {
  const me = useMe();
  const [factoryId, setFactoryId] = useState('');
  const [salesOrderId, setSalesOrderId] = useState('');
  const [woStatus, setWoStatus] = useState('');
  const qs = new URLSearchParams(Object.entries({ factoryId, salesOrderId, woStatus }).filter(([, v]) => v)).toString();
  const { data: d, error, loading, reload } = useLoad<any>(() => get(`/api/v1/home${qs ? '?' + qs : ''}`), [qs]);
  const [chosen, setChosen] = useState<Panel | null>(readPanel());
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!d) return <Loading />;
  const panels: Panel[] = d.panels;
  if (!panels.length) return <ErrorBox error={new Error('Bu hesabın görebileceği bir ana ekran yok. Yöneticinizden yetki isteyin.')} />;
  const panel: Panel = chosen && panels.includes(chosen) ? chosen : d.defaultPanel;
  const factories: { id: string; code: string; name: string }[] = d.scope.factories;
  return (
    <>
      <PageHeader title={PANEL_TITLE[panel]}
        subtitle={<>{me.organization.name} · Veri zamanı {fmtDateTime(d.generatedAt)}{loading && ' · yenileniyor…'}</>}
        actions={factories.length > 1 ? (
          <Field label="Fabrika" className="min-w-48"><Select value={factoryId} onChange={(e) => setFactoryId(e.target.value)} placeholder="Tüm yetkili fabrikalar"
            options={factories.map((f) => ({ value: f.id, label: `${f.code} · ${f.name}` }))} /></Field>
        ) : <span className="text-sm text-muted">{factories[0]?.name}</span>} />
      {panels.length > 1 && (
        <div role="tablist" aria-label="Ana ekran görünümü" className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1">
          {panels.map((p) => (
            <button key={p} role="tab" aria-selected={p === panel} onClick={() => { setChosen(p); savePanel(p); }}
              className={clsx('min-h-11 flex-1 whitespace-nowrap rounded-lg px-4 text-sm font-semibold', p === panel ? 'bg-brand-700 text-white dark:bg-brand-400 dark:text-onbrand' : 'text-muted hover:bg-subtle hover:text-ink')}>
              {PANEL_LABEL[p]}{p === d.defaultPanel && <span className="sr-only"> (rolünüzün varsayılanı)</span>}
            </button>
          ))}
        </div>
      )}
      <div role="tabpanel" aria-label={PANEL_TITLE[panel]}>
        {panel === 'factory' && <FactoryPanel d={d} />}
        {panel === 'production' && <ProductionPanel d={d} salesOrderId={salesOrderId} setSalesOrderId={setSalesOrderId} woStatus={woStatus} setWoStatus={setWoStatus} />}
        {panel === 'warehouse' && <WarehousePanel d={d} />}
        {panel === 'operator' && <OperatorPanel d={d} />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- shared pieces
const n = (arr: { status: string; n: number }[] | undefined, k: string) => arr?.find((x) => x.status === k)?.n ?? 0;
const qtyList = (rows: { unit: string; qty: string }[]) => (rows.length ? rows.map((r) => `${fmtQty(r.qty, 0)} ${u(r.unit)}`).join(' · ') : '0');

function NotMeasured({ title, items, reason }: { title: string; items: string[]; reason: string }) {
  return (
    <Card title={title}>
      <ul className="grid sm:grid-cols-2 gap-2">
        {items.map((i) => <li key={i} className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-sm"><span className="text-ink">{i}</span><span className="text-xs text-muted whitespace-nowrap">ölçülmüyor</span></li>)}
      </ul>
      <p className="mt-3 text-xs text-muted">{reason}</p>
    </Card>
  );
}

function Alerts({ alerts }: { alerts: any[] }) {
  return (
    <Card title={<span className="flex items-center gap-2"><span aria-hidden className="text-brand-600 dark:text-brand-300">✦</span>Uyarılar · kural tabanlı</span>}>
      <ul className="flex flex-col gap-1">
        {alerts.map((a, i) => (
          <li key={i}><a href={a.link ? '#/' + a.link : undefined} className={clsx('flex gap-2 rounded-lg p-2.5 text-sm', a.link && 'hover:bg-subtle')}>
            <span aria-hidden className={a.level === 'warn' ? 'text-warn' : 'text-emerald-500'}>{a.level === 'warn' ? '▲' : '●'}</span>
            <span><span className="text-ink">{a.text}</span><span className="block text-[11px] text-muted">Kaynak: {a.source}</span></span>
          </a></li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-muted">Deterministik kurallar; tahmin yapılmaz, otomatik işlem yapılmaz.</p>
    </Card>
  );
}

// ---------------------------------------------------------------- process map (clickable)
function ProcessMap({ d }: { d: any }) {
  const inv = d.inventory; const q = d.quality;
  const stations: { name: string; icon: string; link: string; live?: string; phase?: string }[] = [
    { name: 'Kumaş deposu', icon: '◫', link: 'inventory', live: inv ? `${n(inv.rollsByStatus, 'ACCEPTED')} top kullanılabilir · ${n(inv.rollsByStatus, 'QUARANTINE')} karantina` : undefined },
    { name: 'Giriş kalite', icon: '✓', link: 'inventory', live: q ? `${q.inspections30d} muayene (30 gün) · ${q.failed} red` : undefined },
    { name: 'Kesim', icon: '✂', link: 'plan/mes', phase: 'Faz D' },
    { name: 'Baskı', icon: '▣', link: 'plan/mes', phase: 'Faz D' },
    { name: 'Nakış', icon: '✳', link: 'plan/mes', phase: 'Faz D' },
    { name: 'Dikim', icon: '⚙', link: 'plan/mes', phase: 'Faz D' },
    { name: 'Son işlem', icon: '♨', link: 'plan/mes', phase: 'Faz D' },
    { name: 'Final kalite', icon: '◎', link: 'plan/qms', phase: 'Faz D' },
    { name: 'Paketleme', icon: '▤', link: 'plan/mes', phase: 'Faz D' },
    { name: 'Sevkiyat', icon: '⇨', link: 'plan/mes', phase: 'Faz D' },
  ];
  return (
    <Card title="Fabrika süreç haritası">
      <ol className="grid grid-cols-2 sm:grid-cols-5 gap-2" aria-label="Süreç adımları">
        {stations.map((s, i) => {
          const live = s.live !== undefined;
          return (
            <li key={s.name}>
              <a href={'#/' + s.link} className={clsx('flex h-full flex-col gap-1 rounded-lg border p-3 min-h-24 hover:bg-subtle', live ? 'border-brand-600/60 bg-brand-600/10' : 'border-line border-dashed')}>
                <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <span className="text-[11px] text-muted tabular-nums">{String(i + 1).padStart(2, '0')}</span><span aria-hidden>{s.icon}</span>{s.name}
                </span>
                <span className={clsx('text-xs', live ? 'text-ink' : 'text-muted')}>{live ? s.live : `Kayıt yok · ${s.phase}`}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

// ---------------------------------------------------------------- A. Fabrika Yönetim Paneli
function FactoryPanel({ d }: { d: any }) {
  const o = d.orders; const w = d.workOrders; const inv = d.inventory; const q = d.quality;
  const focus = useLoad<any>(() => (o?.focusOrderId ? get(`/api/v1/orders/${o.focusOrderId}`) : Promise.resolve(null)), [o?.focusOrderId]);
  const stockWarnings = inv ? n(inv.rollsByStatus, 'QUARANTINE') : null;
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        {o && <Kpi icon="☰" label="Aktif sipariş" value={o.active} hint={`${o.draft} taslak`} />}
        {o && <Kpi icon="⏱" label="Geciken sipariş" value={o.delayed} tone={o.delayed ? 'warn' : 'ok'} hint={`Termin ≤ 14 gün: ${o.dueSoon}`} />}
        {w && <Kpi icon="⚙" label="Planlanan üretim (açık iş emri)" value={qtyList(w.plannedOpen)} hint={`${n(w.byStatus, 'RELEASED') + n(w.byStatus, 'IN_PROGRESS')} iş emri`} />}
        <Kpi icon="▶" label="Gerçekleşen üretim (bugün)" value="" pending="Ölçülmüyor" hint="Üretim kaydı Faz D" />
        {w && <Kpi icon="◧" label="Malzeme karşılama" value={`%${fmtQty(w.materialCoverage.pct, 1)}`} hint={`${w.materialCoverage.coveredLines}/${w.materialCoverage.lines} satır tam`} />}
        {q && <Kpi icon="✓" label="Giriş kalite geçme (30 gün)" value={q.passRatePct === null ? '—' : `%${fmtQty(q.passRatePct, 1)}`} hint={`${q.inspections30d} muayene · ${q.failed} red`} />}
        {stockWarnings !== null && <Kpi icon="◫" label="Stok uyarısı (karantina)" value={stockWarnings} tone={stockWarnings ? 'warn' : 'ok'} hint={`${inv.activeLots} aktif lot`} />}
        {o?.activeValueByCurrency
          ? <Kpi icon="₺" label="Aktif sipariş tutarı" value={o.activeValueByCurrency.length ? o.activeValueByCurrency.map((v: any) => fmtMoney(v.amount, v.currency)).join(' · ') : '—'} hint="Kâr: ölçülmüyor (Faz E)" />
          : <Kpi icon="₺" label="Maliyet & kâr" value="" pending="Ölçülmüyor" hint="Faz E" />}
      </div>
      <div className="grid gap-4 mb-4"><ProcessMap d={d} /></div>
      <div className="grid xl:grid-cols-[1fr_24rem] gap-4">
        <div className="grid gap-4 min-w-0 content-start">
          {o && (
            <Card title="Geciken ve termini yaklaşan siparişler">
              <Table rows={o.risky} rowKey={(r: any) => r.id} onRow={(r: any) => go('orders/' + r.id)} empty="Termin riski olan sipariş yok"
                cols={[
                  { h: 'Sipariş', c: (r: any) => <span className="font-semibold">{r.orderNo}</span> },
                  { h: 'Müşteri', c: (r: any) => r.customerName },
                  { h: 'Termin', c: (r: any) => fmtDate(r.dueDate) },
                  { h: 'Durum', c: (r: any) => r.delayed ? <span className="font-semibold text-danger">{-r.daysLeft} gün gecikti</span> : <span className="text-warn">{r.daysLeft} gün kaldı</span> },
                ]} />
            </Card>
          )}
          <Alerts alerts={d.alerts} />
        </div>
        <Card title="Siparişin yolculuğu">
          {!o ? <p className="text-sm text-muted">Sipariş görme yetkiniz yok.</p> : !o.focusOrderId ? <p className="text-sm text-muted">Onaylı veya üretimde sipariş yok.</p>
            : focus.error ? <ErrorBox error={focus.error} /> : !focus.data ? <Loading /> : (
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
    </>
  );
}

// ---------------------------------------------------------------- B. Üretim Müdürü Paneli
function WoTable({ rows }: { rows: any[] }) {
  return (
    <Table rows={rows} rowKey={(r: any) => r.id} onRow={(r: any) => go('work-orders/' + r.id)} empty="Filtreye uyan iş emri yok"
      cols={[
        { h: 'İş emri', c: (r: any) => <span className="font-semibold">{r.woNo}</span> },
        { h: 'Sipariş', c: (r: any) => r.orderNo },
        { h: 'Model / renk', c: (r: any) => `${r.modelCode} · ${r.colorCode}` },
        { h: 'Planlanan', num: true, c: (r: any) => `${fmtQty(r.plannedQty, 0)} ${u(r.unit)}` },
        { h: 'Gerçekleşen', num: true, c: () => <span className="text-muted">—</span> },
        { h: 'Malzeme', num: true, c: (r: any) => r.coveragePct === null ? '—' : `%${fmtQty(r.coveragePct, 0)}` },
        { h: 'Durum', c: (r: any) => <Badge status={r.status} /> },
      ]} />
  );
}

function ProductionPanel({ d, salesOrderId, setSalesOrderId, woStatus, setWoStatus }: { d: any; salesOrderId: string; setSalesOrderId: (v: string) => void; woStatus: string; setWoStatus: (v: string) => void }) {
  const w = d.workOrders; const p = d.production;
  return (
    <>
      <Card title="Filtreler" className="mb-4">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {d.orders && <Field label="Sipariş"><Select value={salesOrderId} onChange={(e) => setSalesOrderId(e.target.value)} placeholder="Tümü" options={d.orders.options.map((o: any) => ({ value: o.id, label: o.orderNo }))} /></Field>}
          <Field label="İş emri durumu"><Select value={woStatus} onChange={(e) => setWoStatus(e.target.value)} placeholder="Açık olanlar"
            options={['PLANNED', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].map((s) => ({ value: s, label: t('status.' + s) }))} /></Field>
        </div>
        <p className="mt-3 text-xs text-muted">Fabrika filtresi sayfanın üstünde. Hat, vardiya, bölüm ve tarih filtreleri üretim kaydı olmadığı için henüz uygulanamaz (Faz D).</p>
      </Card>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Kpi icon="⚙" label="Açık iş emri" value={n(w.byStatus, 'RELEASED') + n(w.byStatus, 'IN_PROGRESS')} hint={`${n(w.byStatus, 'PLANNED')} planlı, serbest bırakılmadı`} />
        <Kpi icon="▦" label="Planlanan adet" value={qtyList(w.plannedOpen)} hint="Serbest + devam eden" />
        <Kpi icon="◧" label="Malzeme karşılama" value={`%${fmtQty(w.materialCoverage.pct, 1)}`} hint={`${w.materialCoverage.coveredLines}/${w.materialCoverage.lines} satır tam`} />
        <Kpi icon="▶" label="Plan / gerçekleşen" value="" pending="Ölçülmüyor" hint="Üretim kaydı Faz D" />
      </div>
      <Card title="Üretim emirleri" className="mb-4"><WoTable rows={w.list} /></Card>
      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <Card title={`Hatlar (${p.lines.length}) · makine ${p.machines}`}>
          <ul className="divide-y divide-line">
            {p.lines.map((l: any) => (
              <li key={l.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span><span className="font-semibold text-ink">{l.code}</span> <span className="text-muted">{l.name} · {l.factoryCode} · {l.workstations} istasyon</span></span>
                <span className="text-xs text-muted">performans ölçülmüyor</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Vardiyalar">
          <ul className="divide-y divide-line">
            {p.shifts.map((s: any) => (
              <li key={s.factoryCode + s.code} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="text-ink">{s.factoryCode} · {s.name} <span className="text-muted">{s.startsAt.slice(0, 5)}–{s.endsAt.slice(0, 5)}</span></span>
                {s.isCurrent ? <span className="text-xs font-semibold text-brand-700 dark:text-brand-300">Şu anki vardiya</span> : <span className="text-xs text-muted">—</span>}
              </li>
            ))}
            {!p.shifts.length && <li className="py-2 text-sm text-muted">Tanımlı vardiya yok.</li>}
          </ul>
        </Card>
      </div>
      <NotMeasured title="Henüz ölçülmeyen üretim göstergeleri" items={p.notMeasured} reason={p.reason} />
    </>
  );
}

// ---------------------------------------------------------------- C. Depo Paneli
function WarehousePanel({ d }: { d: any }) {
  const can = useCan(); const inv = d.inventory;
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <BigAction icon="⌗" label="QR / barkod okut" onClick={() => go('scan')} tone="brand" />
        {can('inventory.receive') && <BigAction icon="⇩" label="Top kabulü" onClick={() => go('inventory')} />}
        <BigAction icon="≣" label="Stok defteri" onClick={() => go('ledger')} />
        <BigAction icon="⇄" label="Transfer" sub="Faz C" disabled />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Kpi icon="◫" label="Kullanılabilir top" value={n(inv.rollsByStatus, 'ACCEPTED')} />
        <Kpi icon="⏸" label="Karantina" value={n(inv.rollsByStatus, 'QUARANTINE')} tone={n(inv.rollsByStatus, 'QUARANTINE') ? 'warn' : undefined} hint="Muayene bekliyor" />
        <Kpi icon="✕" label="Red" value={n(inv.rollsByStatus, 'REJECTED')} />
        <Kpi icon="#" label="Aktif lot" value={inv.activeLots} />
      </div>
      <Card title="Stok miktarları (birim bazında, birimler toplanmaz)" className="mb-4">
        <Table rows={inv.qtyByUnit} rowKey={(r: any) => r.unit + r.status} empty="Stokta top yok"
          cols={[
            { h: 'Durum', c: (r: any) => <Badge status={r.status} /> },
            { h: 'Birim', c: (r: any) => u(r.unit) },
            { h: 'Top', num: true, c: (r: any) => r.rolls },
            { h: 'Fiziksel', num: true, c: (r: any) => fmtQty(r.physical, 2) },
            { h: 'Rezerve', num: true, c: (r: any) => fmtQty(r.reserved, 2) },
            { h: 'Kullanılabilir', num: true, c: (r: any) => r.status === 'ACCEPTED' ? <b>{fmtQty(r.available, 2)}</b> : <span className="text-muted">—</span> },
          ]} />
        <p className="mt-2 text-xs text-muted">Karantina ve red stok kullanılabilir sayılmaz. Tüketim (son 30 gün): {inv.consumption30d.length ? qtyList(inv.consumption30d) : 'kayıt yok (kesime çıkış Faz D)'}.</p>
      </Card>
      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <Card title="Lokasyonlar">
          <ul className="divide-y divide-line text-sm">
            {inv.locations.map((l: any) => <li key={l.warehouseCode + l.binCode} className="flex justify-between py-2"><span className="text-ink">{l.warehouseCode} / {l.binCode}{l.isQuarantine && <span className="ml-1 text-xs text-warn">karantina</span>}</span><span className="tabular-nums text-muted">{l.rolls} top</span></li>)}
            {!inv.locations.length && <li className="py-2 text-muted">Dolu lokasyon yok.</li>}
          </ul>
        </Card>
        <Card title="Son mal kabuller">
          <ul className="divide-y divide-line text-sm">
            {inv.recentReceipts.map((r: any) => <li key={r.id} className="py-2"><div className="font-semibold text-ink">{r.receiptNo} · {r.rolls} top</div><div className="text-xs text-muted">{r.supplierName} · {fmtDateTime(r.receivedAt)}</div></li>)}
            {!inv.recentReceipts.length && <li className="py-2 text-muted">Mal kabul kaydı yok.</li>}
          </ul>
        </Card>
        <Card title="Son stok hareketleri">
          <ul className="divide-y divide-line text-sm">
            {inv.recentMovements.map((m: any) => (
              <li key={m.id} className="py-2"><a href={m.rollId ? '#/rolls/' + m.rollId : undefined} className="block">
                <div className="flex justify-between gap-2"><span className="text-ink">{MV[m.movementType] ?? m.movementType} · {m.rollNo ?? '—'}</span>
                  <span className="tabular-nums text-muted">{Number(m.qtyDelta) !== 0 ? fmtQty(m.qtyDelta, 2) : fmtQty(m.reservedDelta, 2) + ' rez.'} {u(m.unit)}</span></div>
                <div className="text-xs text-muted">{fmtDateTime(m.occurredAt)}</div></a></li>
            ))}
            {!inv.recentMovements.length && <li className="py-2 text-muted">Hareket yok.</li>}
          </ul>
        </Card>
      </div>
      <Alerts alerts={d.alerts.filter((a: any) => a.source.startsWith('fabric') || a.level === 'ok' || a.source === 'work_order_material')} />
    </>
  );
}

// ---------------------------------------------------------------- D. Operatör Android Paneli
function BigAction({ icon, label, sub, onClick, disabled, tone, n: num }: { icon: string; label: string; sub?: string; onClick?: () => void; disabled?: boolean; tone?: 'brand'; n?: number }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-disabled={disabled}
      className={clsx('relative flex w-full min-h-24 flex-col items-center justify-center gap-1 rounded-xl border p-3 text-center font-semibold active:scale-[0.98]',
        disabled ? 'border-dashed border-line bg-surface text-muted cursor-not-allowed' : tone === 'brand' ? 'border-brand-700 bg-brand-700 text-white' : 'border-line bg-surface text-ink hover:bg-subtle')}>
      {num !== undefined && <span className={clsx('absolute left-2 top-2 text-[11px] tabular-nums', disabled ? 'text-muted' : tone === 'brand' ? 'text-white/80' : 'text-muted')}>{num}</span>}
      <span className="text-2xl leading-none" aria-hidden>{icon}</span>
      <span>{label}</span>
      {sub && <span className="text-[11px] font-normal">{sub}</span>}
    </button>
  );
}

function OperatorPanel({ d }: { d: any }) {
  const can = useCan(); const w = d.workOrders; const p = d.production;
  const current = p.shifts.find((s: any) => s.isCurrent);
  const first = w?.list.find((x: any) => x.status === 'RELEASED' || x.status === 'IN_PROGRESS');
  const metric = (label: string): ReactNode => (
    <div className="rounded-lg border border-line bg-surface p-3"><div className="text-xs text-muted">{label}</div><div className="text-lg font-bold text-muted">—</div><div className="text-[11px] text-muted">kayıt yok</div></div>
  );
  return (
    <>
      <div className="grid grid-cols-2 gap-2 mb-4">
        <BigAction n={1} icon="⌗" label="QR okut" sub="Top / iş emri" tone="brand" onClick={() => go('scan')} disabled={!can('inventory.read')} />
        <BigAction n={2} icon="+" label="Sağlam adet gir" sub="Faz D · henüz kayıt yok" disabled />
        <BigAction n={3} icon="⚠" label="Hata bildir" sub="Faz D · henüz kayıt yok" disabled />
        <BigAction n={4} icon="⏸" label="Duruş bildir" sub="Faz D · henüz kayıt yok" disabled />
        <div className="col-span-2"><BigAction n={5} icon="▤" label="İş emrini görüntüle" sub={first ? `${first.woNo} · ${first.modelCode}` : 'Açık iş emri yok'} onClick={() => go(first ? 'work-orders/' + first.id : 'work-orders')} disabled={!w} /></div>
      </div>
      <p role="note" className="mb-4 rounded-lg border border-warn/50 bg-warn/10 p-3 text-sm text-ink">
        Adet, hata ve duruş girişi henüz yok; bu düğmeler bilinçli olarak pasif. Hiçbir işlem gönderilmiş gibi gösterilmez. Çevrimdışı kuyruk ve senkron durumu (bekliyor / gönderildi / çakışma) Faz F'de gelir.
      </p>
      <Card title="Vardiya ve hedef" className="mb-4">
        <div className="text-sm text-ink mb-3">{current ? <>Şu anki vardiya: <b>{current.factoryCode} · {current.name}</b> ({current.startsAt.slice(0, 5)}–{current.endsAt.slice(0, 5)})</> : 'Şu an tanımlı bir vardiya saatinde değilsiniz.'}</div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">{metric('Hedef')}{metric('Sağlam')}{metric('Hatalı')}{metric('Tamir')}{metric('Duruş')}</div>
        <p className="mt-2 text-xs text-muted">İş emri ataması ve istasyon kaydı Faz D ile gelir; değerler o zamana kadar boş kalır.</p>
      </Card>
      {w && (
        <Card title="Fabrikanızdaki açık iş emirleri">
          <ul className="grid gap-2">
            {w.list.filter((x: any) => x.status !== 'PLANNED').map((x: any) => (
              <li key={x.id}><a href={'#/work-orders/' + x.id} className="flex items-center justify-between gap-3 rounded-xl border border-line p-3 min-h-16 hover:bg-subtle">
                <span><span className="block font-bold text-ink">{x.woNo}</span><span className="text-xs text-muted">{x.modelCode} · {x.colorCode} · {fmtQty(x.plannedQty, 0)} {u(x.unit)}</span></span>
                <Badge status={x.status} />
              </a></li>
            ))}
            {!w.list.some((x: any) => x.status !== 'PLANNED') && <li className="text-sm text-muted">Serbest bırakılmış iş emri yok.</li>}
          </ul>
        </Card>
      )}
    </>
  );
}
