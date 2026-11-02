import { clsx } from 'clsx';
import { SECTIONS, nextPhase } from '../navigation.ts';
import { useCan } from '../app.tsx';
import { PageHeader, Card, ErrorBox } from '../ui.tsx';

const PHASE_NAME: Record<number, string> = {
  1: 'Sipariş, model, satın alma, stok, kalite',
  2: 'İş emri, kesim, demet, rota, üretim okutma',
  3: 'Baskı, dikim, yıkama, final kalite, paketleme',
  4: 'Maliyet, panolar, uyarılar, çevrimdışı senkron',
  5: 'AI asistan, tahmin, optimizasyon',
};

/** Roadmap page for a menu section: what works today and what is planned. Shows no business data. */
export function RoadmapPage({ sectionKey }: { sectionKey: string }) {
  const can = useCan();
  const s = SECTIONS.find((x) => x.key === sectionKey);
  if (!s) return <ErrorBox error={new Error('Sayfa bulunamadı')} />;
  const links = s.links.filter((l) => can(l.perm));
  const np = nextPhase(s);
  const phases = [...new Set(s.planned.map((p) => p.phase))].sort();
  return (
    <>
      <PageHeader title={<span className="flex items-center gap-2"><span aria-hidden>{s.icon}</span>{s.label}</span>} subtitle={s.summary} />
      <div role="note" className="mb-4 rounded-xl border border-amber-400/50 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100 p-3 text-sm">
        {links.length
          ? <>Bu bölümün bir kısmı çalışıyor. Aşağıdaki diğer ekranlar henüz yapılmadı; bu sayfa örnek veri göstermez.</>
          : <>Bu bölüm henüz yapılmadı{np ? <> ve <b>Faz {np}</b>'de başlayacak</> : null}. Bu sayfa örnek veri göstermez; yalnızca bölümün içeriğini listeler.</>}
      </div>
      {links.length > 0 && (
        <Card title="Şu an çalışan ekranlar" className="mb-4">
          <ul className="flex flex-wrap gap-2">
            {links.map((l) => <li key={l.label}><a href={'#/' + l.path} className="inline-flex items-center min-h-11 rounded-lg px-3 bg-brand-700 text-white dark:bg-brand-400 dark:text-onbrand text-sm font-medium">✓ {l.label}</a></li>)}
          </ul>
        </Card>
      )}
      {phases.map((ph) => (
        <Card key={ph} title={<>Faz {ph} <span className="font-normal text-muted text-xs">· {PHASE_NAME[ph]}</span></>} className="mb-4">
          <ul className="divide-y divide-line">
            {s.planned.filter((p) => p.phase === ph).map((p) => (
              <li key={p.label} className="py-2.5 flex gap-3">
                <span aria-hidden className="text-muted mt-0.5">○</span>
                <div className="flex-1">
                  <div className="text-sm font-medium text-ink">{p.label} <span className="ml-1 text-[11px] text-muted">{p.module}</span></div>
                  <div className="text-xs text-muted">{p.detail}</div>
                </div>
                <span className={clsx('self-start shrink-0 text-[11px] font-semibold rounded px-2 py-0.5 bg-subtle text-muted')}>Planlandı</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </>
  );
}
