# M4 Free HTTP admission — fizibilite checkpoint'i

Durum: IN_PROGRESS. Bu belge mimari, canonical admission veya sürdürülebilir kapasite kabulü değildir. Tek mimari otorite NIHAI_MIMARI_VE_UYGULAMA_PLANI.md'dir. Yeni transport prototipi production route'larına bağlı değildir; yeni migration, job/state geçişi veya production deployment yapılmadı.

## Ölçülmüş sınır

Önceki canonical exact 20.971.520-byte PNG HTTP isteğinin native CPU'su 615 ms idi. Bu sonuç Workers Free HTTP 10 ms bütçesine sürdürülebilir uyum değildir. Yerel Node profilleri multipart/body kopyaları, full-buffer SHA ve PNG inspection maliyetlerini gösterir; provider CPU'nun exclusive dağılımı olarak sunulamaz.

Yeni izole native-stream alt-sınır probe'u auth/session/CSRF/permission/D1/parser/backup zincirini içermedi:

- Tiny ve 1 MiB: native CPU sırasıyla 3 ve 3 ms.
- Exact 20 MiB: bir POST, HTTP202, exact binary size/SHA eşitliği; native CPU4 ms, wall1924 ms, outcome=ok, truncated=false.
- Exact20 complete console marker'ı NOT_OBSERVABLE. İlk STOP korunmuştur. Aynı orijinal istek dar ve bağımsız incelenmiş read-only helper ile pozitif native terminal kaydı üzerinden tamamlandı; yeni upload yok.
- Planlı iki-request burst: iki HTTP202. Yalnız burst-b native CPU6 ms/outcome=ok/untruncated doğrulandı. Burst-a native terminal kaydı eksik; gözlenen provider interval'ları örtüşmüyor. Concurrency NOT_PROVEN; tekrar/burst retry yapılmadı.
- Owned geçici Worker/R2 bucket temizlendi; cleanup readback protected production eşitliğini doğruladı. Bu probe D1 veya yeni Queue oluşturmadı.

Bu sayılar yeni raw-stream.ts kaynak sürümünün provider kabulü değildir. Yeni modül yalnız yerel workerd/unit testlerinde çalıştırılmıştır.

## Queue CPU sınırı: extraction eksikliğinin uzlaştırılması

Kaynak: https://developers.cloudflare.com/queues/platform/limits/

Resmî HTML, sayfa başındaki Caution bölümünde açıkça şunu söylüyor:

“The following limits apply to both Workers Paid and Workers Free plans with the exception of Message Retention, which is non-configurable at 24 hours for the Workers Free plan.”

Aynı sayfa consumer Worker invocation için default maximum CPU30 saniye bildiriyor. Workers HTTP/Cron Free10 ms tablosuyla Queue invocation türü aynı varsayılmamalı. Genel clean-text extraction Caution bölümünü düşürdü; bu yüzden yalnız o extraction üzerinden oluşan Free Queue bütçesi belirsizliği kalıcı bir blocker olarak kullanılmamalıdır. HTML HTTP200 ile ayrıca okunup bu iki cümle birlikte doğrulandı. limits.cpu_ms artırılmadı; Paid açılmadı. Yeni parser workload'unun gerçek Queue CPU/wall/outcome ve bounded backlog/retry davranışı yine provider acceptance gerektirir.

HTTP kaynak: https://developers.cloudflare.com/workers/platform/limits/

## Yerel transport adayı

src/server/documents/raw-stream.ts:

- Exact-length native stream, 1..20.971.520 byte aralığı.
- R2 native expected SHA doğrulaması ve write-once conditional create; browser SHA yalnız içerik iddiasıdır.
- Private/octet-stream storage; bu sonuç yapısal validation veya AVAILABLE yetkisi değildir.
- Input await öncesinde detached snapshot; bodyUsed/locked provider işi başlamadan reddedilir.
- Total30 saniye timeout/abort ve iki nonwaiting per-isolate permit. Geç kalan uncancellable put/pipe bitmeden permit yeniden açılmaz. Bu distributed concurrency kabulü değildir.
- Yerel focused iki dosya/10 test, typecheck ve üç aday dosyası için focused lint/format PASS.

İlk farklı fresh POST HIGH checkpoint review INCOMPLETE kaldı; PASS sayılmadı. Locked-body endişesi kalıcı RED testinde doğrulandı ve GREEN düzeltildi. Aynı fresh POST reviewer'ın dar correction kapanışı 0 BLOCKER / 0 IMPORTANT / PASS döndü; reviewer iki dosya/10 testi bir kez bağımsız çalıştırdı. Orchestrator gerçek closed last-message/model/provider/HIGH ve frozen üç dosya drift0 bağlarını doğruladı. Bu yalnız FREE_NATIVE_TRANSPORT_SPIKE_ONLY kapsamıdır; canonical architecture ve sustained capacity NO kalır. Önceki pre-HIGH FAIL/STOP/INCOMPLETE ve frozen kaynak sürümleri Temp receipts'te korunuyor.

## Henüz uygulanmamış engineering acceptance

1. Canonical auth/session/CSRF/parent/sensitive authorization + metadata/magic envelope + streaming admission entegrasyonu ve son session-bound disclosure assertion.
2. Durable async-validation state/job sözleşmesi, immutable hash/idempotency ve canlı uploader yetki kontrolleri. Eski SCAN veya mevcut BACKUP eligibility predicate'i kestirme olarak gevşetilmeyecek.
3. Queue'da canonical PDF/JPEG/PNG inspection + bağımsız hash/size; parser failure asla AVAILABLE olmayacak. Başarı ancak mevcut immutable backup/copy evidence ve atomic availability zinciriyle READY olur.
4. Completed replay dahil gönderilen body'nin doğrulanması; eski object HEAD + client digest iddiası tek başına replay güvenliği değildir. Retry attempt/object custody ve bounded temizleme politikası gerekir.
5. Idle/work/admission/abuse sınırları; representative format/size, gerçek provider overlap ve modest agency workload testi. Peak heap henüz NOT_OBSERVABLE.
6. Fresh independent pre-HIGH ve farklı post-HIGH 0 BLOCKER/0 IMPORTANT/PASS; izin verilirse CLOSED deploy, provider readback ve public negative probes. Yeni CLOSED deployment henüz yok.

Public gate kapalı kalır: DOCUMENTS_ENABLED=false, FEATURE_ENABLED=NO. Signed custody/privacy/retention, live external observer/human delivery ve populated recovery operasyon kapıları değişmedi. M4_COMPLETE=false.
