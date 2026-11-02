/**
 * Menu architecture: the 11 sections of the "Fabrika Kontrol Merkezi" design, plus a small
 * "Sistem" group. Every one of the 18 spec modules (M01–M18) is mapped to a section.
 * `path` items are working screens; `planned` items have no screen yet and open the section's
 * roadmap page (#/plan/<key>), which shows no data — only what the section will contain.
 */
export interface NavLink { label: string; path: string; perm: string; icon?: string }
export interface PlannedItem { label: string; module: string; phase: number; detail: string }
export interface NavSection {
  key: string; label: string; labelEn: string; icon: string;
  /** direct link for single-screen sections (Ana Panel) */
  path?: string; perm?: string;
  links: NavLink[]; planned: PlannedItem[];
  /** short description shown on the roadmap page */
  summary: string;
}

export const SECTIONS: NavSection[] = [
  { key: 'dashboard', label: 'Ana Panel', labelEn: 'Control centre', icon: '▦', path: '', perm: 'org.read', links: [], planned: [],
    summary: 'Fabrikanın anlık durumu, uyarılar ve sipariş yolculuğu.' },
  { key: 'orders', label: 'Sipariş Yönetimi', labelEn: 'Order management', icon: '☰', summary: 'Müşteri siparişleri, revizyonlar ve sipariş durumu.',
    links: [{ label: 'Siparişler', path: 'orders', perm: 'order.read' }],
    planned: [
      { label: 'Müşteriler', module: 'M01', phase: 1, detail: 'Müşteri kartı, iletişim, ödeme ve teslim koşulları' },
      { label: 'Sipariş revizyonları', module: 'M01', phase: 1, detail: 'Revizyon geçmişi, değişiklik onayı, iş emrine etki analizi' },
    ] },
  { key: 'plm', label: 'Model & PLM', labelEn: 'Model & PLM', icon: '✂', summary: 'Model, varyant, reçete (BOM), teknik föy ve onaylar.',
    links: [{ label: 'Modeller & Reçete', path: 'models', perm: 'model.read' }],
    planned: [
      { label: 'Teknik föy', module: 'M02', phase: 1, detail: 'Sürümlü teknik şartname ve revizyonlar' },
      { label: 'Ölçü tablosu & beden çizelgesi', module: 'M02', phase: 1, detail: 'Ölçü noktaları, toleranslar, beden bazlı değerler' },
      { label: 'Numune & onaylar', module: 'M02', phase: 1, detail: 'Numune turları, müşteri/teknik onay kayıtları' },
      { label: 'Operasyon rotası', module: 'M03', phase: 2, detail: 'Modele özel operasyon sırası (kesim → baskı/nakış → dikim → yıkama …)' },
      { label: 'Hedef maliyet', module: 'M03', phase: 4, detail: 'Reçete ve rota üzerinden ön maliyet' },
    ] },
  { key: 'aps', label: 'Planlama (APS)', labelEn: 'Planning (APS)', icon: '◷', summary: 'Kapasite, çizelgeleme ve malzeme ihtiyaç planı.',
    links: [],
    planned: [
      { label: 'Malzeme ihtiyaç planı', module: 'M04', phase: 1, detail: 'Sipariş + reçeteden net ihtiyaç; stok ve rezervasyonla karşılaştırma' },
      { label: 'Kapasite planı', module: 'M04', phase: 2, detail: 'Hat/istasyon kapasitesi, vardiya bazlı yük' },
      { label: 'Üretim çizelgesi', module: 'M04', phase: 2, detail: 'İş emirlerinin hatlara zaman bazlı yerleşimi' },
      { label: 'Termin riski', module: 'M04', phase: 4, detail: 'Plan uyumu ve gecikme uyarıları' },
    ] },
  { key: 'mes', label: 'Üretim Takibi (MES)', labelEn: 'Production (MES)', icon: '⚙', summary: 'İş emirlerinden kesim, dikim, yıkama ve paketlemeye kadar üretim akışı.',
    links: [{ label: 'İş Emirleri', path: 'work-orders', perm: 'workorder.read' }],
    planned: [
      { label: 'Pastal & kesim', module: 'M08', phase: 2, detail: 'Pastal planı, serim, kat sayısı, kesim fire mutabakatı, demet (bundle) üretimi' },
      { label: 'Üretim okutma', module: 'M04', phase: 2, detail: 'İstasyonda QR ile giriş/çıkış, sağlam/hatalı adet' },
      { label: 'Baskı & nakış', module: 'M09', phase: 3, detail: 'DTF, serigrafi, puff, kauçuk, nakış, emboss, TPU operasyonları' },
      { label: 'Dikim', module: 'M10', phase: 3, detail: 'Bant dengeleme, standart dakika, WIP, operatör ve makine takibi' },
      { label: 'Yıkama & apre', module: 'M11', phase: 3, detail: 'Proses partileri ve sonuçları' },
      { label: 'Ütü & son işlem', module: 'M12', phase: 3, detail: 'Son işlem adımları' },
      { label: 'Paketleme & sevkiyat', module: 'M14', phase: 3, detail: 'Koli, etiket, çeki listesi, kısmi sevkiyat ve iade' },
      { label: 'Bakım & makineler', module: 'M15', phase: 3, detail: 'Makine kartı, duruşlar, yedek parça' },
    ] },
  { key: 'wms', label: 'Kumaş & Stok (WMS)', labelEn: 'Fabric & stock (WMS)', icon: '◫', summary: 'Top bazlı kumaş stoğu, lot/ton, raf, rezervasyon ve stok hareketleri.',
    links: [
      { label: 'Kumaş Stoğu', path: 'inventory', perm: 'inventory.read' },
      { label: 'Stok Defteri', path: 'ledger', perm: 'inventory.read' },
      { label: 'QR Tara', path: 'scan', perm: 'inventory.read' },
    ],
    planned: [
      { label: 'Aksesuar stoğu', module: 'M06', phase: 1, detail: 'Etiket, düğme, fermuar vb. adet/metre bazlı stok' },
      { label: 'Depolar arası transfer', module: 'M06', phase: 1, detail: 'Fabrikalar ve raflar arası iki adımlı transfer' },
      { label: 'Sayım & düzeltme onayı', module: 'M06', phase: 1, detail: 'Onaylı stok düzeltmesi ve sayım farkları' },
    ] },
  { key: 'purchasing', label: 'Satın Alma', labelEn: 'Purchasing', icon: '⇄', summary: 'Tedarikçiler, satın alma siparişleri ve teslimatlar.',
    links: [],
    planned: [
      { label: 'Tedarikçiler', module: 'M05', phase: 1, detail: 'Tedarikçi kartı ve performansı' },
      { label: 'Satın alma siparişi', module: 'M05', phase: 1, detail: 'İhtiyaçtan sipariş, onay akışı, fiyat ve döviz' },
      { label: 'Mal kabul eşleştirme', module: 'M05', phase: 1, detail: 'Gelen topların satın alma siparişiyle eşlenmesi' },
    ] },
  { key: 'qms', label: 'Kalite Kontrol (QMS)', labelEn: 'Quality (QMS)', icon: '✓', summary: 'Giriş kalite, hat içi ve final kontrol, hata kodları ve AQL.',
    links: [{ label: 'Giriş kalite (4 puan)', path: 'inventory', perm: 'inventory.read' }],
    planned: [
      { label: 'GSM, en, çekme, renk-lot testleri', module: 'M07', phase: 1, detail: 'Top bazlı ek ölçümler' },
      { label: 'Hat içi kalite', module: 'M13', phase: 3, detail: 'İstasyonda hata kaydı, fotoğraf, tamir akışı' },
      { label: 'Final kontrol & AQL', module: 'M13', phase: 3, detail: 'Yapılandırılabilir örnekleme planı; onaysız adet sevk edilemez' },
      { label: 'Hata kodları & ikinci kalite', module: 'M13', phase: 3, detail: 'Hata sınıflandırması, ikinci kalite ve hurda kararı' },
    ] },
  { key: 'cost', label: 'Maliyet & Finans', labelEn: 'Cost & finance', icon: '₺', summary: 'Planlanan ve gerçekleşen maliyet, birim maliyet ve sipariş katkı marjı.',
    links: [],
    planned: [
      { label: 'Gerçekleşen maliyet', module: 'M17', phase: 4, detail: 'Malzeme, işçilik, baskı, yıkama, genel gider, fire, ambalaj, lojistik' },
      { label: 'Sipariş karlılığı', module: 'M17', phase: 4, detail: 'Birim maliyet ve katkı marjı; formüller incelenebilir' },
      { label: 'Döviz kurları', module: 'M17', phase: 4, detail: 'Tarihsel kur geçmişi ile çoklu para birimi' },
    ] },
  { key: 'reports', label: 'Raporlar & Analiz', labelEn: 'Reports & analytics', icon: '▤', summary: 'Tanımlı KPI formülleriyle üretim, kalite ve stok raporları.',
    links: [],
    planned: [
      { label: 'Sipariş ilerleme & termin riski', module: 'M17', phase: 4, detail: 'Plan uyumu, gecikme riski' },
      { label: 'Fire & tüketim', module: 'M17', phase: 4, detail: 'Kesim firesi, malzeme tüketimi' },
      { label: 'Hata Pareto', module: 'M17', phase: 4, detail: 'Hata kodlarına göre dağılım' },
      { label: 'Verimlilik & OEE', module: 'M17', phase: 4, detail: 'Hat verimliliği, duruşlar; OEE yalnızca gerekli ölçümler varsa' },
      { label: 'Stok yaşlandırma', module: 'M17', phase: 4, detail: 'Lot ve top bazlı yaş analizi' },
    ] },
  { key: 'ai', label: 'AI Kontrol Merkezi', labelEn: 'AI control centre', icon: '✦', summary: 'Veriye dayalı tahmin, anomali tespiti ve doğal dille fabrika asistanı.',
    links: [],
    planned: [
      { label: 'Tahmin & anomali tespiti', module: 'M18', phase: 5, detail: 'İstatistiksel tahmin, kural tabanlı anomali; yeterli geçmiş veri olunca eğitilmiş modeller' },
      { label: 'Fabrika asistanı', module: 'M18', phase: 5, detail: 'Yetkiye göre veri erişen, kaynak ve güven düzeyini açıklayan sohbet asistanı' },
      { label: 'Doğal dille raporlama', module: 'M18', phase: 5, detail: 'Soru sorarak rapor alma; yıkıcı işlem yapmaz' },
    ] },
  { key: 'system', label: 'Sistem', labelEn: 'System', icon: '⌂', summary: 'Kullanıcılar, roller, personel ve denetim kayıtları.',
    links: [{ label: 'Denetim kayıtları', path: 'audit', perm: 'audit.read' }],
    planned: [
      { label: 'Kullanıcı & rol yönetimi', module: 'M16', phase: 1, detail: 'Kullanıcı ekleme, rol ve fabrika yetkileri' },
      { label: 'Personel & vardiyalar', module: 'M16', phase: 2, detail: 'Çalışan kartı, vardiya ve görevlendirme' },
      { label: 'Kişisel veri dışa aktarma/silme', module: 'Güvenlik', phase: 1, detail: 'KVKK talepleri ve saklama süreleri' },
    ] },
];

/** First (lowest) phase still planned in a section; null if nothing planned. */
export const nextPhase = (s: NavSection) => (s.planned.length ? Math.min(...s.planned.map((p) => p.phase)) : null);

/** Which section owns the current route (for highlighting / auto-expanding). */
export function sectionOf(route: string[]): string {
  const [a, b] = route;
  if (!a) return 'dashboard';
  if (a === 'plan') return b ?? 'dashboard';
  if (a === 'rolls') return 'wms';
  for (const s of SECTIONS) if (s.links.some((l) => l.path === a)) return s.key;
  return 'dashboard';
}
