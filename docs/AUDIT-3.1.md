# TEXFLOW 3.1 — Mevcut Sistem Denetimi (Faz A)

Tarih: 2026-11-02 · Denetlenen sürüm: `3ff5bea` (main) · Yöntem: kaynak kod incelemesi, testlerin ve derlemelerin çalıştırılması, yedek/geri yükleme denemesi.

## 1. Gerçek teknoloji yığını (varsayım değil, depodan okunan)

| Katman | Kullanılan |
|---|---|
| Sunucu | Node 22 (TypeScript doğrudan çalışır), kendi HTTP çekirdeği (`apps/api/src/http/kernel.ts`), Zod v4 doğrulama, OpenAPI 3.1 üretimi, WebSocket (`ws`) |
| Veritabanı | PostgreSQL 16+, bağımlılıksız kendi istemcimiz (`packages/db/src/pg.ts`), ham SQL göçleri (sağlama toplamlı), RLS (43 tablo, FORCE), en az yetkili `texflow_app` rolü |
| Web | React 19, hash yönlendirme, Tailwind v4 (esbuild ile derleme), TR/EN sözlük |
| Android | Capacitor 7 (WebView), `@capacitor/barcode-scanner`, minSdk 26; APK GitHub Actions'ta derleniyor (`android-latest` sürümü) |
| Barındırma | Render (Docker, ücretsiz plan) + Neon PostgreSQL |
| CI | GitHub Actions: `ci` (tip kontrol + testler + Docker imajı), `android-apk` |

Kısıt: npm kayıt defteri bu çalışma ortamında kapalı; bağımlılıklar çevrimdışı paketlerden bağlanıyor. Bu yüzden Fastify/Prisma/Vitest yerine yukarıdaki eşdeğerler kullanıldı (gerekçe: `docs/PHASE0-REPORT.md`).

## 2. Özellik envanteri

| Alan | Durum | Not |
|---|---|---|
| Giriş, oturum, token yenileme/rotasyon, kilitleme | Çalışıyor | scrypt, yeniden kullanım tespiti, hız sınırı (bellek içi) |
| RBAC + fabrika kapsamı | Çalışıyor | Sunucu tarafında; **istisna: `/api/v1/dashboard` fabrika kapsamını uygulamıyor** (bkz. 4) |
| Organizasyon izolasyonu (RLS) | Çalışıyor | Testle doğrulanmış |
| Sipariş (M01) | Temel | Oluşturma, onay, revizyon anlık görüntüsü; müşteri ekranı yok |
| Model / BOM (M02–03) | Temel | Sürümlü BOM + onay; teknik föy, ölçü tablosu yok |
| İş emri (M04) | Temel | Oluşturma, serbest bırakma (BOM anlık görüntüsü), malzeme ihtiyacı; çizelgeleme yok |
| Kumaş top kabulü, QR kimliği (M06) | Çalışıyor | Karantina → 4 puan muayene → kabul/red |
| Giriş kalite 4 puan (M07) | Çalışıyor | Plan bazlı kabul; GSM/en/çekme alanları şemada var |
| Rezervasyon (FIFO, ton/lot kilidi) | Çalışıyor | Eşzamanlılık testi var |
| Değiştirilemez stok defteri, denetim kaydı | Çalışıyor | Tetikleyici + yetki ile korunuyor |
| QR tarama (Android kamera + elle giriş) | Çalışıyor | |
| Satın alma, aksesuar stoğu, transfer | Yok | Şema kısmen hazır (supplier, warehouse kind TRIM) |
| Kesim, baskı/nakış, dikim, yıkama, ütü, paket, sevkiyat (M08–M14) | Yok | Hat/istasyon/makine/vardiya tabloları var, üretim kaydı tablosu yok |
| Bakım, personel (M15–16) | Şema var, ekran yok | `machine`, `shift`, `employee` |
| Maliyet, raporlar, AI (M17–18) | Yok | Panelde kural tabanlı uyarılar (Katman 1) var |
| Çevrimdışı kuyruk | Yok | Şu an çevrimdışıyken işlem dürüstçe reddediliyor; kuyruk yok |
| Açık/koyu tema | Kısmen | Token yapısı hazır, açık tema düğmesi yok |

## 3. Şema ve göçler

`0001_foundation.sql` (tüm tablolar, tetikleyiciler, RLS), `0002_reference_data_and_grants.sql`, `0003_owner_auth_lookup.sql`.
Tablolar: permission, currency, unit, unit_conversion, organization, factory, department, shift, production_line, workstation, machine, warehouse, bin, app_user, role, role_permission, user_role, user_session, employee, exchange_rate, tax_rate, number_sequence, customer, supplier, size, color, product_model, product_variant, fabric_inspection_plan, material, bom, bom_item, sales_order, sales_order_line, sales_order_revision, work_order, work_order_material, fabric_lot, goods_receipt, fabric_roll, material_inspection, inspection_defect, stock_reservation, inventory_adjustment_request, inventory_movement, audit_event, idempotency_key, schema_migrations.

## 4. Bulgular

1. **Panel fabrika kapsamı (güvenlik, orta):** `/api/v1/dashboard` sayıları tüm organizasyon için döndürüyor; yalnızca bir fabrikaya yetkili kullanıcı (ör. Bursa depo) diğer fabrikanın sipariş/top sayılarını görebiliyor. → 3.1 ana ekran uç noktası kapsamı uyguluyor; eski uç nokta da düzeltildi.
2. **Operatör, Fabrika Müdürü, Üretim Sorumlusu rolleri yok.** → DEMO verisine yalnızca ekleme yapan, yıkıcı olmayan bir yükseltme adımı eklendi.
3. **Kişi adı:** Arayüzde ve DEMO verisinde kişi adı yok; kullanıcı görünen adları rol unvanı. Müşteri/tedarikçi adları firma adı ve `DEMO` etiketli. Kontrol testi eklendi.
4. **Üretim gerçekleşen verisi yok:** sağlam/hatalı adet, duruş, WIP kaydedecek tablo yok. Paneller bu metrikleri uydurmuyor; "henüz ölçülmüyor (Faz D)" olarak gösteriyor.
5. **Git etiketi gönderilemedi:** çalışma ortamının vekil sunucusu etiket gönderimini reddediyor (HTTP 403). Geri dönüş noktası commit kimliğiyle tutuluyor (aşağıda).
6. **Hız sınırı bellek içi:** tek örnekte doğru, çoklu örnekte paylaşılmaz (Redis, daha sonra).

## 5. Testler ve derlemeler (denetim anında)

- Birim + entegrasyon: **34/34 geçti** (`npm test`, yerel PostgreSQL 16).
- Uçtan uca (Playwright, masaüstü + 412×915 mobil): **2/2 geçti**.
- Tip kontrol: temiz. Web derlemesi: başarılı. GitHub CI + APK derlemesi: başarılı (son commit).

## 6. Yedekleme ve geri dönüş planı

- **Kod:** 3.1 öncesi sürüm `3ff5bea`. Geri dönmek için: `git revert <3.1 commitleri>` ve push etmek yeterli. Render otomatik olarak yeniden dağıtır; APK de yeniden derlenir. Eski APK'lar GitHub Actions çıktılarında durur.
- **Veritabanı:** 3.1 ilk dilimi **şema göçü içermiyor**. Tek değişiklik, DEMO organizasyonuna 3 rol ve 3 kullanıcının *eklenmesi*. Mevcut kayıtlar silinmiyor ve değiştirilmiyor.
- **Yedek:** `scripts/backup.sh` ile şifreli (AES-256) pg_dump alınıyor. Bu denetimde yedek alındı, boş bir veritabanına geri yüklendi ve kayıt sayıları karşılaştırıldı: eşit.
- **Canlı Neon veritabanı:** bu ortamdan erişim yok. Neon'un dal (branch) / zaman noktasına geri yükleme özelliği kullanılmalı; yıkıcı bir göçten önce Neon'da bir dal oluşturulması şarttır.

## 7. Uygulanan ilk dilim (Faz A + B): rol bazlı ana ekranlar

**Kabul kriterleri**: her biri test edilmiştir.
- Her rol girişte kendi panelini görür: Fabrika Yönetimi, Üretim Müdürü, Depo, Operatör. Yetkisi olduğu diğer panellere sekmeyle geçebilir.
- Paneller yalnızca canlı veritabanı verisi gösterir: sipariş, iş emri, kumaş top/lot/lokasyon, mal kabul, hareket, giriş kalite.
- Kaydı olmayan metrikler uydurulmaz; "ölçülmüyor" olarak gösterilir. Bunlar: gerçekleşen üretim, hata, duruş, WIP, maliyet/kâr.
- Her veri bloğu sunucuda yetkiyle korunur. Sorgular kullanıcının fabrika kapsamıyla sınırlıdır. Eski panel uç noktası da kapsama alındı (bulgu 1).
- Farklı birimler (m, kg, adet) hiçbir zaman toplanmaz. Sipariş tutarı para birimi bazında ayrı gösterilir ve yalnızca müşteri görme yetkisi olanlara açıktır.
- Operatör ekranındaki öncelik sırası: QR okut, sağlam adet, hata, duruş, iş emri. Adet, hata ve duruş düğmeleri kayıt altyapısı olmadığı için pasiftir; başarı mesajı taklit edilmez.
- Fabrika süreç haritasındaki 10 istasyonun hepsi tıklanabilir. Canlı olanlar gerçek ekrana, diğerleri yol haritasına gider.
- Tasarım sistemi 3.1 uygulandı: grafit/petrol palet, açık ve koyu tema düğmesi, gradyan ve parlama efektleri kaldırıldı.
- Mevcut menü, QR tarama, top kabulü, rezervasyon ve stok defteri değişmeden çalışıyor (önceki uçtan uca testler geçiyor).

**Değişen dosyalar**
- Yeni: `apps/api/src/modules/home.ts` (`GET /api/v1/home`), `apps/web/src/pages/home.tsx`, `apps/api/test/06-home.test.ts`, `docs/AUDIT-3.1.md`
- Değişen: `apps/api/src/app.ts` (rota kaydı), `apps/api/src/modules/audit.ts` (panel fabrika kapsamı), `packages/db/src/seed.ts` + `index.ts` (Fabrika Müdürü, Üretim Sorumlusu, Operatör rolleri; `ensureRoleSet` yalnızca ekleme yapar), `apps/web/src/app.tsx` (tema düğmesi, ana ekran yönlendirme), `apps/web/src/navigation.ts`, `apps/web/src/pages/dashboard.tsx` (bileşen dışa aktarımı), `apps/web/src/styles.css` (3.1 tokenları), `e2e/vertical-slice.test.ts`, `README.md`
- Şema göçü: **yok**.

**Test sonuçları**
- Birim + entegrasyon: 38/38 geçti. 4 yeni test: rol bazlı panel ve görünürlük, canlı veri ve birim ayrımı, fabrika/organizasyon izolasyonu, kişi adı yokluğu ve rol yükseltmesinin yıkıcı olmaması.
- Uçtan uca: 3/3 geçti. Yeni test: Android boyutunda Operatör ekranı. Mevcut masaüstü testine panel sekmeleri, süreç haritası ve açık tema eklendi.
- DEMO yükseltmesi mevcut verili bir veritabanında denendi. 3 rol ve 3 kullanıcı eklendi. Mevcut 9 kullanıcının özeti değişmedi. İkinci çalıştırmada hiçbir şey eklenmedi.

**Bitmeyenler (sonraki fazlar)**
- Üretim kaydı: sağlam/hatalı/tamir adet, duruş, WIP, hat performansı, darboğaz (Faz D). Hat, vardiya ve tarih filtreleri buna bağlı.
- İş emrinin operatöre atanması (Faz D). Şimdilik operatör, fabrikasındaki açık iş emirlerini görür.
- Maliyet ve kâr (Faz E). Çevrimdışı kuyruk ve senkron durumları (Faz F). AI asistan (Faz G).
- Transfer ve aksesuar stoğu (Faz C).
- İş emri malzeme satırındaki "kullanılabilir stok" sütunu fabrika kapsamına göre süzülmüyor (küçük bulgu, Faz C'de ele alınacak).
