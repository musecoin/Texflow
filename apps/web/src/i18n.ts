/** Turkish is the default locale; English is a complete, extensible second dictionary. */
const tr = {
  'app.name': 'TEXFLOW AI', 'app.tagline': 'Tekstil Fabrika OS',
  'nav.dashboard': 'Ana Panel', 'nav.orders': 'Siparişler', 'nav.models': 'Modeller & Reçete', 'nav.inventory': 'Kumaş Stoğu', 'nav.workOrders': 'İş Emirleri',
  'nav.ledger': 'Stok Defteri', 'nav.audit': 'Denetim', 'nav.scan': 'QR Tara', 'nav.more': 'Menü',
  'common.save': 'Kaydet', 'common.cancel': 'Vazgeç', 'common.create': 'Oluştur', 'common.search': 'Ara…', 'common.loading': 'Yükleniyor…', 'common.empty': 'Kayıt yok',
  'common.actions': 'İşlemler', 'common.status': 'Durum', 'common.qty': 'Miktar', 'common.unit': 'Birim', 'common.add': 'Satır ekle', 'common.remove': 'Kaldır',
  'common.retry': 'Tekrar dene', 'common.close': 'Kapat', 'common.all': 'Tümü', 'common.logout': 'Çıkış', 'common.details': 'Detay',
  'login.title': 'Oturum aç', 'login.org': 'Organizasyon kodu', 'login.email': 'E-posta', 'login.password': 'Şifre', 'login.submit': 'Giriş yap',
  'login.demoHint': 'DEMO ortamı: organizasyon kodu DEMO, kullanıcı admin@demo.texflow.local. Şifre kurulumda DEMO_PASSWORD ile belirlenir.',
  'conn.online': 'Çevrimiçi', 'conn.live': 'Canlı', 'conn.offline': 'Çevrimdışı — işlemler gönderilmez',
  'status.DRAFT': 'Taslak', 'status.CONFIRMED': 'Onaylandı', 'status.IN_PRODUCTION': 'Üretimde', 'status.COMPLETED': 'Tamamlandı', 'status.SHIPPED': 'Sevk edildi',
  'status.CANCELLED': 'İptal', 'status.IN_REVIEW': 'İncelemede', 'status.TECH_APPROVED': 'Teknik onaylı', 'status.ARCHIVED': 'Arşiv', 'status.APPROVED': 'Onaylı',
  'status.OBSOLETE': 'Geçersiz', 'status.PLANNED': 'Planlandı', 'status.RELEASED': 'Serbest', 'status.IN_PROGRESS': 'Devam ediyor', 'status.QUARANTINE': 'Karantina',
  'status.ACCEPTED': 'Kabul', 'status.REJECTED': 'Red', 'status.ACTIVE': 'Aktif', 'status.PENDING': 'Bekliyor', 'status.PASS': 'Geçti', 'status.FAIL': 'Kaldı',
  'stage.AWAITING_CONFIRMATION': 'Onay bekliyor', 'stage.AWAITING_WORK_ORDER': 'İş emri bekliyor', 'stage.AWAITING_RELEASE': 'Serbest bırakma bekliyor',
  'stage.AWAITING_MATERIAL': 'Malzeme bekliyor', 'stage.MATERIAL_RESERVED': 'Malzeme hazır', 'stage.CANCELLED': 'İptal edildi',
  'mv.RECEIPT': 'Mal kabul', 'mv.QC_RELEASE': 'KK kabul', 'mv.QC_REJECT': 'KK red', 'mv.RESERVE': 'Rezervasyon', 'mv.UNRESERVE': 'Rezervasyon iptali',
  'mv.ISSUE': 'Çıkış', 'mv.ADJUSTMENT': 'Düzeltme', 'mv.TRANSFER_OUT': 'Transfer çıkış', 'mv.TRANSFER_IN': 'Transfer giriş',
};
type Key = keyof typeof tr;
const en: Partial<Record<Key, string>> = {
  'app.tagline': 'Textile Factory OS', 'nav.dashboard': 'Control centre', 'nav.orders': 'Orders', 'nav.models': 'Models & BOM', 'nav.inventory': 'Fabric stock',
  'nav.workOrders': 'Work orders', 'nav.ledger': 'Stock ledger', 'nav.audit': 'Audit', 'nav.scan': 'Scan QR', 'nav.more': 'More',
  'common.save': 'Save', 'common.cancel': 'Cancel', 'common.create': 'Create', 'common.search': 'Search…', 'common.loading': 'Loading…', 'common.empty': 'No records',
  'login.title': 'Sign in', 'login.org': 'Organization code', 'login.email': 'Email', 'login.password': 'Password', 'login.submit': 'Sign in',
  'conn.online': 'Online', 'conn.live': 'Live', 'conn.offline': 'Offline — actions are not sent',
};
const dicts: Record<string, Partial<Record<Key, string>>> = { tr, en };

export let locale: 'tr' | 'en' = (() => { try { return (localStorage.getItem('texflow.locale') as 'tr' | 'en') ?? 'tr'; } catch { return 'tr'; } })();
export function setLocale(l: 'tr' | 'en') { locale = l; try { localStorage.setItem('texflow.locale', l); } catch { /* ignore */ } location.reload(); }
export function t(k: string): string { return (dicts[locale] as Record<string, string>)[k] ?? (tr as Record<string, string>)[k] ?? k; }

const intlLocale = () => (locale === 'tr' ? 'tr-TR' : 'en-GB');
/** Formats decimal strings without converting through floats (Intl accepts numeric strings). */
export function fmtQty(v: string | number | null | undefined, maxDp = 4): string {
  if (v === null || v === undefined || v === '') return '—';
  return new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: maxDp }).format(v as unknown as number);
}
export function fmtMoney(v: string | null | undefined, currency: string): string {
  if (v == null) return '—';
  return new Intl.NumberFormat(intlLocale(), { style: 'currency', currency }).format(v as unknown as number);
}
export function fmtDate(v: string | null | undefined): string { return v ? new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium' }).format(new Date(v)) : '—'; }
export function fmtDateTime(v: string | null | undefined): string { return v ? new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(v)) : '—'; }

/** Today's date in the user's local time zone as YYYY-MM-DD (toISOString would use UTC). */
export function localToday(): string { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
