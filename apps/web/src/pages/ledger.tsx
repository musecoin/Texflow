import { useState } from 'react';
import { get } from '../api.ts';
import { t, fmtQty, fmtDateTime } from '../i18n.ts';
import { useLoad, Card, Badge, Select, Table, PageHeader, Loading, ErrorBox, Button } from '../ui.tsx';
import { go } from '../app.tsx';
import { actionLabel } from './dashboard.tsx';

const TYPES = ['RECEIPT', 'QC_RELEASE', 'QC_REJECT', 'RESERVE', 'UNRESERVE', 'ADJUSTMENT'];
const signed = (v: string) => (v === '0.0000' ? '' : (v.startsWith('-') ? '' : '+') + fmtQty(v));

export function LedgerPage() {
  const [materialId, setMaterialId] = useState(''); const [type, setType] = useState(''); const [offset, setOffset] = useState(0);
  const mats = useLoad(() => get('/api/v1/materials'), []);
  const { data, error, loading, reload } = useLoad(() => get(`/api/v1/inventory/ledger?limit=100&offset=${offset}${materialId ? '&materialId=' + materialId : ''}${type ? '&movementType=' + type : ''}`), [materialId, type, offset]);
  return (
    <>
      <PageHeader title={t('nav.ledger')} subtitle="Değiştirilemez stok hareketleri — her satır kaynak belgesine bağlıdır" />
      <Card>
        <div className="flex flex-wrap gap-2 mb-4">
          <Select aria-label="Malzeme" value={materialId} onChange={(e) => { setMaterialId(e.target.value); setOffset(0); }} placeholder="Tüm malzemeler" options={(mats.data?.items ?? []).map((m: any) => ({ value: m.id, label: m.code }))} className="max-w-xs" />
          <Select aria-label="Hareket tipi" value={type} onChange={(e) => { setType(e.target.value); setOffset(0); }} placeholder="Tüm hareketler" options={TYPES.map((x) => ({ value: x, label: t('mv.' + x) }))} className="max-w-xs" />
        </div>
        {error ? <ErrorBox error={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
          <>
            <Table rows={data.items} rowKey={(r: any) => String(r.id)} cols={[
              { h: '#', c: (r: any) => <span className="tabular-nums text-muted">{r.id}</span> },
              { h: 'Zaman', c: (r: any) => fmtDateTime(r.occurredAt) },
              { h: 'Hareket', c: (r: any) => t('mv.' + r.movementType) },
              { h: 'Top', c: (r: any) => (r.rollNo ? <button className="underline" onClick={() => go('rolls/' + r.rollId)}>{r.rollNo}</button> : '—') },
              { h: 'Malzeme / lot', c: (r: any) => `${r.materialCode} / ${r.lotNo ?? '—'}` },
              { h: 'Kova', c: (r: any) => <Badge status={r.stockStatus} /> },
              { h: 'Fiziksel Δ', c: (r: any) => signed(r.qtyDelta), num: true },
              { h: 'Rezerve Δ', c: (r: any) => signed(r.reservedDelta), num: true },
              { h: 'Birim', c: (r: any) => r.unit },
              { h: 'Kaynak', c: (r: any) => `${r.sourceRef ?? r.sourceType}` },
              { h: 'Kullanıcı', c: (r: any) => r.actorName },
            ]} />
            <div className="mt-3 flex items-center justify-between text-sm text-muted">
              <span>{data.page.total} hareket</span>
              <div className="flex gap-2"><Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>‹</Button><Button variant="secondary" disabled={!data.page.hasMore} onClick={() => setOffset(offset + 100)}>›</Button></div>
            </div>
          </>
        )}
      </Card>
    </>
  );
}

export function AuditPage() {
  const { data, error, loading, reload } = useLoad(() => get('/api/v1/audit?limit=200'), []);
  return (
    <>
      <PageHeader title={t('nav.audit')} subtitle="Tüm komutların değiştirilemez kaydı (önce/sonra durumu ile)" />
      <Card>
        {error ? <ErrorBox error={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
          <Table rows={data.items} rowKey={(r: any) => String(r.id)} cols={[
            { h: 'Zaman', c: (r: any) => fmtDateTime(r.occurredAt) }, { h: 'İşlem', c: (r: any) => actionLabel(r.action) }, { h: 'Varlık', c: (r: any) => r.entityType },
            { h: 'Kullanıcı', c: (r: any) => r.actorName ?? '—' },
            { h: 'Değişiklik', c: (r: any) => <code className="text-xs break-all">{r.beforeState ? JSON.stringify(r.beforeState).slice(0, 60) + ' → ' : ''}{JSON.stringify(r.afterState ?? {}).slice(0, 80)}</code> },
          ]} />
        )}
      </Card>
    </>
  );
}
