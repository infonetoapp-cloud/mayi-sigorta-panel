# M4 minimum belge vertical slice — kaynak/yerel kanıt, HTTP attribution STOP

Bu checkpoint public açılış veya tamamlanmış M4 kabulü değildir. Başlangıç `ba818a2d1394a729c9aaae92d60513720c397a1f`; main/HEAD/origin/main/remote eşit, görevdeki mevcut 9 modified + 7 untracked aday korunarak devam edildi. Önceki FAIL/STOP kanıtları değiştirilmedi. Production `DOCUMENTS_ENABLED=false`, internal JOBS/CRON=true korunur. Bu görevde production deployment yapılmadı; önceki güvenlik fix'leri de hâlâ canlı deployment kabulü almamıştır.

## Ürün ve server sınırı

- `GET /api/documents`: typed CUSTOMER/POLICY/QUOTE bağlamına bağlı liste ve her satırda PROCESSING/READY/FAILED status; ayrı ID-only status route eklenmedi.
- Server mevcut parent/read, agency/membership/identity ve bütün persisted permission graph evaluator'ını kullanır. Metadata sayfası ve parent/permission snapshot son session-bound D1 batch içinde yeniden doğrulanır; boş sayfa da bu kapıdan geçer.
- Yetkisiz IDENTITY/HEALTH metadata SQL LIMIT öncesinde filtrelenir; count/placeholders/hidden-row cursor sızıntısı yok. Sağlık parent'ının hassas okuma sınırı korunur.
- READY canonical stream evidence predicate'ini tekrar kullanır; HTTP202 veya job QUEUED, READY değildir. NULL current ve gerçek PENDING_UPLOAD en son sürümle PROCESSING gösterilir.
- Müşteri ve poliçe bölümlerinde minimal belge alanı: upload, durum, liste yenileme, pagination, normal download, own-password reauth → server confirmation → açık kullanıcı onayı → tek kullanımlık sensitive grant/download. Büyük CRM redesign yapılmadı.
- Ambiguous upload retry aynı File/body/idempotency key'i kullanır. FAILED background işi için otomatik yeniden işleme yazılmadı; kullanıcı yöneticiye yönlendirilir. 401/403/404 refresh sonrası eski metadata/controls/sensitive state temizlenir, bekleyen async işlem generation'ı geçersizleştirilir.
- Çalışan mesajları ürün kavramlarıdır; provider exception/object key/hash/job/backup generation UI'da gösterilmez. Yapısal doğrulama virüs taraması olarak sunulmaz.

## Şema aktarımı

İlk disposable denemenin `/query` üzerinden trigger aktarımı HTTP400/code7500 incomplete input ile STOP verdi; salt-okunur EXPLAIN aynı hatayı doğruladı. Partial D1 ve EU bucket kabul edilmiş owned cleanup ile kapandı; object DELETE0. Bu deneme yeniden başlatılmadı veya migration yazısı tekrar edilmedi.

Yeni disposable run `bc61c40d-13b5-4fc5-9254-5cd2ea413bb0`, Worker `mayi-http-bc61c40d13`: canonical migration SQL'i değiştirmeden resmi Wrangler `d1 execute --remote --file` /import yolu kullanıldı. Yerel native file import ve remote SQLite schema readback: 350 nesne, 176 trigger, canonical SQL eşitliği ve foreign_key_check boş. Sentetik seed yalnız owned disposable DB'de, schema kabulünden sonra oluşturuldu; gerçek müşteri veya permanent auth/OWNER/session fixture kullanılmadı.

Resmî transport: https://developers.cloudflare.com/d1/best-practices/import-export-data/

## Gerçek HTTP/parser/crypto ölçümü

Her stage tek canonical HTTP multipart POST; auth cookie/CSRF/rate bindings, bounded body reader, gerçek PDF/JPEG/PNG parser, WebCrypto checksum, private quarantine put ve canonical D1 upload yolu. Temp APP_ENV=production, temp DOCUMENTS=true, JOBS/CRON=false; production gate değişmedi. Yeni Queue/Cron/Tail/Paid/custom domain/permanent binding yok.

| Stage | Bytes | HTTP / integrity | Aynı invocation native CPU / wall | Sonuç |
| --- | ---: | --- | --- | --- |
| Tiny PDF | 369 | 202 / PASS | 31 / 468 ms | PASS |
| Tiny JPEG | 723 | 202 / PASS | 32 / 421 ms | PASS |
| Tiny PNG | 81 | 202 / PASS | 28 / 654 ms | PASS |
| Exact 1 MiB PNG | 1048576 | 202 / PASS | 51 / 646 ms | PASS |
| Exact 10 MiB PNG | 10485760 | 202 / PASS | NOT_PROVEN | STOP |
| Exact 20 MiB PNG | 20971520 | NOT_EXECUTED | NOT_PROVEN | Önceki stage STOP |

PASS satırları exact deployed version, owned run/stage/size markers, Events/Invocations marker inventory eşitliği, tek native lifecycle, outcome=ok ve truncated=false içerir. CPU değerleri Free limitinin altında oldukları veya headroom olduğu şeklinde yorumlanmaz; gözlenmiş provider invocation ölçümüdür. Login KDF, COPY veya concurrency kabulü değildir. Peak memory NOT_OBSERVABLE.

10 MiB: start/complete(status202) marker'ları aynı grupta mevcut; native CPU/wall/outcome lifecycle yok. Bounded 12 polling turu ve sonraki salt-okunur diagnostic bunu kapatmadı. Complete Events inventory 5 kayıt içerir; tek native lifecycle başka invocation'a aittir (CPU22/wall72) ve upload'a ödünç alınmadı. Bu sonuç proven resource-capacity failure değil, zorunlu attribution kanıtının eksikliğidir. 10 MiB yeniden POST edilmedi, 20 MiB başlatılmadı, PASS receipt uydurulmadı.

Tiny PDF'nin ilk observer STOP'u current_version_id=NULL PROCESSING sürümünü yanlış join etmesiydi; aynı isteğin read-only parser/crypto/binary/native proof'larıyla kapandı, POST tekrarlanmadı. Helper'ın latest-version/agency/job-type gözlemi düzeltildi; çalışan READY predicate'i gevşetilmedi. Secret PUT201 ve owned temp bucket inventory delta STOP'ları da yazı tekrarı olmadan exact readback ile uzlaştırıldı. Tüm eski STOP/FAIL artifact'ları korunur.

## Cleanup ve protected provider state

Yeni run cleanup PASS: önce owned Worker, sonra exact canonical D1 ledger key + binary size/SHA readback ile yalnız bilinen sentetik objeler; unknown object purge/drain yok. Bucket DELETE sağlayıcının atomic empty-only koşuluna dayanır; eksik listing metadata'sı complete inventory diye sunulmadı. Bucket, DB ve Worker exact GET404; fresh permanent workers/Queue/buckets/domains/routes/backup alert/subscriptions karşılaştırması PASS. Yeni recurring kaynak kalmadı. Eski Queue veya recovery lock değişmedi, restore yapılmadı.

Atomic empty-only sözleşme: https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/delete/

## Queue custody / privacy / retention kapısı

Mevcut internal v2 custody-before-ACK mühendisliği korunur. Eski Queue paused/consumerless; purged/drained/retired değildir ve doğal provider retention expiry riski tarihsel olarak saklıdır. Custody sonsuz/ücretsiz/silinemeyen preservation veya native provider outage karşısında kayıpsızlık garantisi değildir. Document backup/recovery storage ve control-envelope custody ayrıdır.

Gerçek veri/public pilot öncesi hâlâ gerçek sorumlu + signed retention/privacy profile, finite hacim/işlem bütçesi, DLQ/unknown-message inceleme ve müdahale runbook'u, alert/dead-man/human receipt ve populated recovery kanıtı gerekir. Bu girdiler kullanıcı adına onaylanmadı; otomatik expiry/delete veya sınırsız storage eklenmedi. Bir document UUID, access authority değildir.

## Doğrulama ve acceptance sınırı

- Final focused: public-session + employee UI + sensitive UI + route inventory: 4 dosya / 17 PASS / 70.77 s.
- Değişmeyen full stream/liste native dosyası: 46 PASS / 193.35 s; tekrar koşturulmadı.
- Final typecheck, root lint, client build, CLOSED Worker dry-run ve boundaries PASS.
- Full repository suite çalıştırılmış/PASS sayılmaz; CLOSED deployment kapısı 10/20 MiB HTTP attribution eksikliğinde açılmadı.
- Fresh pre-HIGH session `20261014_124451_acbbcf`; ilk I-1 FAIL ardından aynı reviewer'da dar correction PASS'lar, gerçek model/provider/HIGH/parentNULL/closed final JSON bağlarıyla yürütüldü. Aynı session'ın re-review'ları ayrı fresh review sayılmaz. Önceki source/cleanup HIGH'ları tekrarlanmadı. Ayrı final checkpoint review raporu kendi scope'uyla değerlendirilmelidir.

## Exact blocker ve en güvenli sonraki adım

Final farklı fresh HIGH `20261014_133219_f1e58d`: 0 BLOCKER / 0 IMPORTANT / PASS yalnız `SAFE_LOCAL_CANDIDATE_AND_HONEST_NO_GO_CHECKPOINT_ONLY`. Gerçek gpt-6.1-sol/openai-codex/HIGH/parentNULL/cli_close, son JSON ve 366-file manifest eşitliği primary writer tarafından doğrulandı. Yeni bağımsız React7 PASS/2.03s; native seçilmiş3 PASS/6 SKIP/37.34s; typecheck/lint/boundaries/format/diff PASS. 52 provider GET ile üç owned target GET404, yedi protected kategori exact eşit ve production false/true/true ayrıca doğrulandı; provider writes0. Natural backup995541 export10:30:36.577Z/COMPLETE10:30:42.369Z/227547byte metadata healthy; live dead-man/human delivery proof değildir. Full repository suite/HTTP20MiB/CLOSED deployment kabulü verilmedi. Review sonrasında yalnız bu metadata belgelere eklendi; kaynak/test/config değişmedi.

M4_HTTP_UPLOAD_RUNTIME_ACCEPTED=NO. Supported 20 MiB HTTP sınırı kabul edilmediği için kullanıcı koşulu gereği CLOSED production deployment yapılmadı. Milestone tamamlanmış değildir; public NO-GO sürer.

Önce mevcut 10 MiB invocation'ın retained provider telemetry'sinde aynı run/stage/size/version native lifecycle kanıtını salt-okunur araştır. Provider bu kanıtı sunamıyorsa kanıt eksikliğini korunmuş STOP olarak bırak; bir sonraki ayrıca kabul edilmiş isolated attribution strategy ile yalnız eksik boyutları test et. Başarılı source/cleanup/P4 COPY testlerini yeniden başlatma, CPU'yu başka invocation'dan ödünç alma, Paid açma veya ürün limitini sessizce düşürme. Eksik HTTP kabulü kapanmadan production deployment/public activation yapılmamalı.

Machine-readable evidence: [M4_DOCUMENT_VERTICAL_SLICE_RECEIPTS.json](M4_DOCUMENT_VERTICAL_SLICE_RECEIPTS.json).
