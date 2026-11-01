# Faz 0 + Dikey Dilim — Mimari, Kabul Kriterleri ve Test Raporu

Tarih: 2 Kasım 2026 · Durum: **Faz 0 ve dikey dilim tamamlandı ve doğrulandı.** Aşağıda belirtilen yığın sapmaları ve açıklar nedeniyle Faz 1'e geçmeden önce "Faz 0 kapanış" maddelerinin yapılması önerilir.

## A. Mimari

**İstek yaşam döngüsü (her kimlikli istek):**
1. Bearer token doğrulanır. Token opak bir değerdir ve veritabanında yalnızca SHA-256 özeti tutulur.
2. Tek bir veritabanı işlemi (transaction) açılır. İşlem, en az yetkili `texflow_app` rolüyle ve `SET LOCAL app.org_id` ayarıyla çalışır.
3. Kullanıcı yetkileri ve fabrika kapsamı yüklenir.
4. Rotanın istediği izin kontrol edilir.
5. Mutasyonlarda `Idempotency-Key` kaydı açılır.
6. Komut çalışır: durum makinesi, iyimser sürüm kontrolü ve satır kilitleri uygulanır.
7. Denetim kaydı, defter satırları ve idempotency yanıtı yazılır.
8. Hepsi birlikte commit edilir. WebSocket olayları yalnız commit'ten sonra yayımlanır.

**Kiracı izolasyonu iki katmanlıdır:**
- Uygulama sorguları organizasyona göre kapsamlanır.
- Ayrıca 43 tabloda PostgreSQL RLS (`FORCE`) etkindir. Uygulama rolü tablo sahibi değildir ve `BYPASSRLS` yetkisi yoktur.
- Kimlik doğrulamadan önce yapılan aramalar yalnızca üç `SECURITY DEFINER` fonksiyonla mümkündür.

**Stok modeli:**
- `inventory_movement` değiştirilemez defterdir. Her satır kaynak belgeye (`source_type` / `source_id`) ve işlemi yapan kullanıcıya bağlıdır.
- `fabric_roll.physical_qty` ve `reserved_qty` alanları bir projeksiyondur. Yalnızca defter tetikleyicisi bu alanları günceller.
- CHECK kısıtları şunları imkânsız kılar: negatif stok, fiziksel stoktan fazla rezervasyon, kabul edilmemiş topun rezerve edilmesi.
- Kalite durumu değişikliği iki satırla kaydedilir: eski kovadan −miktar, yeni kovadan +miktar. Böylece her durum kovasının bakiyesi defterden hesaplanabilir.

**Sayısal doğruluk:**
- Veritabanında miktarlar `NUMERIC(18,4)`, tüketim değerleri `NUMERIC(18,6)` tipindedir.
- API'de tüm miktar ve tutarlar ondalık *string* olarak taşınır.
- Uygulamadaki aritmetik BigInt tabanlı `Dec` sınıfıyla yapılır. Float kullanımı reddedilir.
- Malzeme ihtiyacı 4 haneye yukarı yuvarlanır.

**Birimler:**
- Tablodaki dönüşümler yalnızca aynı boyuttaki kesin katsayılardır (m↔yd, kg↔g).
- kg↔m dönüşümü yalnız açık onayla ve en + gramaj (GSM) bilgisiyle tahmin olarak yapılır. Kullanılan formül ve dayanak `quantity_basis` alanına yazılır.
- Farklı birimdeki miktarlar hiçbir raporda toplanmaz. Örneğin malzeme karşılama oranı, satır bazında oranların ortalamasıdır.

**Kalite:**
- 4 puan bantları uygulanır: ≤3" → 1, 3–6" → 2, 6–9" → 3, >9" veya delik → 4. Doğrusal yarda başına en fazla 4 puan sayılır. Normalizasyon puan/100 yd² olarak yapılır.
- Kabul limitleri yalnızca malzemeye bağlı **muayene planından** gelir. Plan yoksa muayene reddedilir.
- Muayene anındaki plan limitleri muayene kaydına kopyalanır.

**Belge sürümleri:**
- Siparişte her durum değişikliği değiştirilemez bir revizyon görüntüsü (snapshot) olarak saklanır.
- Reçete (BOM) sürümlüdür ve her model için aynı anda tek onaylı sürüm olabilir.
- İş emri serbest bırakılırken onaylı BOM'un anlık görüntüsü kilitlenir. Sonraki BOM revizyonları serbest bırakılmış iş emrini etkilemez (testle doğrulandı).

**Durum makineleri:** sipariş, model, BOM, iş emri ve top kalite durumu için tanımlıdır. Her geçiş izin koduyla eşleşir. Sistem geçişlerini kullanıcı doğrudan çağıramaz.

**Görevler ayrılığı:**
- BOM'u oluşturan kişi onu onaylayamaz. Bu kural organizasyon ayarıyla açılıp kapatılabilir; DEMO organizasyonunda tek kişiyle deneme yapılabilsin diye kapalıdır.
- Stok düzeltme talebini açan kişi onu onaylayamaz. Bu kural veritabanındaki CHECK kısıtıyla da güvence altındadır.

## Kabul kriterleri ve kanıtları

Her kriterin yanında onu doğrulayan test numarası verilmiştir.

| Kriter | Kanıt (test) |
|---|---|
| Sipariş → model/BOM → top kabul/muayene → iş emri → rezervasyon → defter + sipariş durumu çalışır | API #1, E2E #27 |
| Defter ile bakiye her topta birebir uzlaşır | #1, #22 |
| Geçersiz durum geçişleri 409 `INVALID_TRANSITION` döner | #12, #14, #15, #16 |
| Eski sürümle güncelleme 409 `VERSION_CONFLICT` döner; sessiz üzerine yazma olmaz | #12, #16 |
| İzin reddi, fabrika kapsamı ve görevler ayrılığı uygulanır | #6, #7, #10 |
| Kiracı B, A'nın verisini API'den ve doğrudan SQL'den göremez veya yazamaz | #8 |
| Defter ve denetim kaydı değiştirilemez (yetki + tetikleyici) | #9 |
| Aynı anahtarla 8 paralel istek tek sipariş üretir; farklı gövde 422 döner; başarısız komut anahtarı tüketmez | #18–#20 |
| Eşzamanlı rezervasyonlar fazla rezervasyon yapamaz; DB kısıtı son savunmadır | #21–#23 |
| Karantinadaki veya reddedilmiş top rezerve edilemez; ton kilidi karışık tonu engeller | #1, #16 |
| kg↔m dönüşümü gizlice yapılmaz | #2, #30 |
| Token rotasyonu, yeniden kullanım tespiti, hesap kilitleme | #4, #5 |
| Mobil: alt menü, ≥44 px dokunma alanı, QR ile top bulma; çevrimdışıyken sahte başarı mesajı yok | #28 |

## D. Test sonuçları (bu ortamda çalıştırıldı)

```
pnpm typecheck                          → 0 hata (TypeScript 6, strict; API + paketler + testler)
node --test (birim + API + E2E)         → 36 test · 36 başarılı · 0 başarısız · ~29 sn
  packages/shared/test                    8 birim testi
  apps/api/test (gerçek PG16, RLS, ws)   20 entegrasyon testi
  e2e (Playwright Chromium)               2 tarayıcı akışı (1366×900 ve 412×915)
scripts/backup.sh                        şifreli yedek → boş DB'ye geri yükleme → satır sayıları eşleşti; yanlış anahtar reddedildi
```

## F. Yığın sapmaları (bu oturumun kısıtı)

Oturumda npm kayıt sunucusu kapalıydı. Yalnızca makinede önceden bulunan paketler kullanılabildi: zod, react, esbuild, tailwindcss, ws, playwright, typescript. Bu yüzden:

| İstenen | Yapılan | Sonuç / plan |
|---|---|---|
| Prisma | Elle yazılmış SQL migration'lar + kontrol toplamlı migrator | Şema SQL'dir. `prisma db pull` ile Prisma şeması üretilebilir. Ancak RLS, tetikleyiciler ve kısmi indeksler zaten ham SQL gerektirir. |
| `pg` sürücüsü | Bağımlılıksız PG wire istemcisi (SCRAM, TLS, parametreli sorgu, havuz) | Sunucu taraflı parametre bağlama yapar (SQL injection yok). `pg`'ye geçiş tek bir arayüzün değişmesi demektir. |
| Fastify | `node:http` üzerinde ince bir çekirdek (yönlendirme, Zod, hata kodları, CORS, başlıklar) | Rota tanımları çerçeveden bağımsızdır. Fastify adaptörü Faz 0 kapanışında yazılmalı. |
| Vite / Vitest | esbuild + Tailwind compile API; `node:test` | Testler Vitest'e mekanik olarak taşınabilir. |
| shadcn/ui | Kendi küçük bileşen seti (Tailwind) | npm açılınca shadcn bileşenlerine geçilebilir. |
| @types/react | Yok | **Web kodu tip denetiminden geçmiyor** (yalnızca esbuild ile derleniyor). |

Bu ortamda yapılamayanlar:
- Docker daemon çalışmıyordu; Dockerfile ve compose dosyaları **derlenmedi ve denenmedi**.
- GitHub Actions dosyası çalıştırılmadı.
- Capacitor Android derlemesi yapılmadı. Yalnızca yapılandırma dosyası var; native QR eklentisi kurulmadı. Tarayıcıda `BarcodeDetector` ile kamera okuma ve elle giriş çalışıyor.
- `pnpm-lock.yaml` üretilemedi.

## Açıklar ve riskler

**Faz 0 kapanışı (Faz 1'den önce):**
1. npm açıkken `pnpm install` çalıştırılıp kilit dosyası üretilmeli.
2. Fastify adaptörü ve Vitest geçişi yapılmalı; `@types/react` eklenip web kodu tip denetimine alınmalı.
3. Docker imajı derlenip compose ile duman testi yapılmalı; CI ilk kez çalıştırılmalı.
4. Hız sınırlama şu an süreç içi çalışıyor. Birden fazla API örneği için Redis'e taşınmalı.
5. Token'lar `localStorage`'da tutuluyor. Katı CSP bu riski azaltıyor, ancak Android için güvenli depolama (Keystore) eklentisi gerekli.
6. Kullanıcı ve rol yönetimi ekranı yok; şimdilik seed ile oluşturuluyor. Kişisel veri dışa aktarma/silme ve saklama süresi iş akışları henüz yok.
7. Satın alma siparişi, aksesuar (trim) stoğu ve stok transferi henüz yok. Arayüz trim için "FIFO rezerve et" butonunu gösteriyor, ancak sunucu dürüstçe "stok yok" yanıtı veriyor. Bu davranış Faz 1'de düzeltilecek.

**Mimari riskler:**
- Belge numaraları organizasyon başına tek satır kilidiyle üretiliyor. Bu yöntem boşluksuz numara verir ama çok yüksek yazma hızında darboğaz olabilir.
- Denetim kaydı değiştirilemez, ancak hash zinciri (kurcalama kanıtı) henüz yok.
- Çevrimdışı kuyruk (IndexedDB), senkronizasyon ve çakışma ekranı Faz 4'te. Şu an çevrimdışıyken komutlar engelleniyor; bu dürüst davranış ama işlevsel bir kısıt.
- Kontrol merkezindeki OEE, kârlılık, kapasite ve fire metrikleri bilerek "Faz 4" olarak gösteriliyor. Bu metrikler için ölçüm verisi henüz yok.

## E. Yerel çalıştırma

README.md dosyasındaki "Hızlı başlangıç" bölümüne bakın.

## Faz 1 önerilen kapsam

- Satın alma siparişleri ve mal kabulün siparişe bağlanması (sipariş miktarı toleransı)
- Aksesuar ve iplik stoğu (top dışı lot bazlı stok)
- Stok transferi ve raf/göz yönetimi
- Teknik föy, ölçü tablosu ve numune onayı
- Müşteri bazlı muayene planları
- Rezervasyon politikaları: lot kilidi, FEFO
- Kullanıcı ve rol yönetimi arayüzü
