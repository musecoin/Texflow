# TEXFLOW AI 1.0 — Tekstil Fabrika OS

Entegre hazır giyim fabrikaları için ERP + MES. Bu depo **Faz 0** (temel altyapı) ve ilk **dikey dilimi** içerir:

> müşteri siparişi → model ve reçete (BOM) → kumaş topu kabulü ve 4 puan muayenesi → iş emri → malzeme rezervasyonu → stok defteri ve sipariş durumu

Tüm akış gerçek PostgreSQL üzerinde, işlemsel (transactional) komutlarla çalışır ve **36 otomatik testle** doğrulanmıştır: birim, API entegrasyon ve tarayıcı uçtan uca testleri. Ayrıntılar için [docs/PHASE0-REPORT.md](docs/PHASE0-REPORT.md) dosyasına bakın.

## Hızlı başlangıç (yerel)

Gereksinimler: Node.js ≥ 22.18, pnpm 10, PostgreSQL 16 (yerel kurulum veya Docker).

```bash
cp .env.example .env              # parolaları değiştirin
pnpm install                      # npm erişimi yoksa: pnpm bootstrap:offline
pnpm db:up                        # yerel PG16 kümesi (Docker varsa: docker compose up -d postgres)
pnpm db:migrate                   # şema + texflow_app rolü + RLS
pnpm db:seed                      # DEMO organizasyonu (yalnız geliştirme)
pnpm dev                          # web derlenir, API + arayüz http://localhost:8080
```

Giriş bilgileri: organizasyon **DEMO**, kullanıcı `admin@demo.texflow.local`, şifre `.env` içindeki `DEMO_PASSWORD` (varsayılan `Demo!2026`). Rol bazlı diğer kullanıcılar: `planlama@`, `teknik@`, `teknikmudur@`, `depo@`, `kalite@`, `stokkontrol@`, `izleyici@`, `bursadepo@`, `fabrikamuduru@`, `uretim@`, `operator@` (alan adı aynı). Her rol girişte kendi ana ekranını görür (Fabrika Yönetimi, Üretim, Depo, Operatör).

### Testler

```bash
pnpm typecheck     # TypeScript strict
pnpm test          # birim + API entegrasyon (texflow_test veritabanını sıfırlar)
pnpm test:e2e      # Playwright: masaüstü + Android boyutlu tarayıcı akışı; ekran görüntüleri e2e/screenshots
```

### Docker

```bash
docker compose up -d postgres
docker compose --profile tools run --rm migrate
docker compose --profile tools run --rm seed     # DEMO, yalnız geliştirme
docker compose up -d api                          # http://localhost:8080, /health/ready
```

### Yedekleme

`BACKUP_PASSPHRASE=<32+ karakter> pnpm backup` komutu `pg_dump` çıktısını AES-256 (PBKDF2) ile şifreler, SHA-256 özeti yazar ve saklama süresini uygular. Geri yükleme: `scripts/backup.sh restore <dosya> <boş hedef DB URL>`.

## Yapı

```
apps/api         REST API (/api/v1), kimlik doğrulama, RBAC, idempotency, WebSocket olayları, OpenAPI
apps/web         React 19 + Tailwind v4 arayüzü (masaüstü kenar menü / mobil alt menü), Capacitor yapılandırması
packages/shared  Alan mantığı: ondalık aritmetik, birimler, 4 puan, durum makineleri, FIFO tahsis, Zod sözleşmeleri
packages/db      SQL migration'lar, PostgreSQL istemcisi, migrator, DEMO seed
e2e              Playwright uçtan uca testleri
scripts          yerel DB, yedekleme, çevrimdışı bağımlılık bağlama
docs             mimari, kabul kriterleri, test raporu, açıklar ve riskler
```

API belgesi: çalışan sunucuda `GET /api/v1/openapi.json` (OpenAPI 3.1; 46 iş uç noktası + sağlık/OpenAPI).

## Fotoğraftan sipariş (yapay zeka)

Siparişler → **📷 Fotoğraftan sipariş**. Sipariş veya kesim föyünün fotoğrafı Claude API ile okunur.
- **Okuma:** Yapay zeka yalnızca kağıtta yazanı aktarır.
- **Kontroller:** Toplam, tekrar eden satır, kesilen–istenen farkı ve beden oranı kontrollerini sistemin kendi kodu yapar.
- **Eşleştirme:** Renk, beden, model ve müşteri mevcut kayıtlarla eşleştirilir. Eksik renk, beden ve model ekrandan eklenebilir (`model.write` yetkisi gerekir).
- **Kayıt:** Kullanıcı düzenleyip onaylayınca sipariş **TASLAK** olarak açılır. Onaydan önce hiçbir kayıt oluşturulmaz.
- **Saklama:** Fotoğraf saklanmaz; yalnızca okuma özeti denetim kaydına yazılır.

Açmak için sunucuya `ANTHROPIC_API_KEY` tanımlayın (Render → Environment). İsteğe bağlı ayarlar:
- `AI_MODEL`: varsayılan `claude-sonnet-5-5`
- `AI_RATE_PER_HOUR`: organizasyon başına saatlik okuma sınırı, varsayılan 30
