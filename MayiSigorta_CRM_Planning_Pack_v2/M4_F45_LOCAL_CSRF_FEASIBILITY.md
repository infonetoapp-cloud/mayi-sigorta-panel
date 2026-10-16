# F-45 — local-only CSRF feasibility / contract-first karar

Başlangıç main/HEAD/origin/main/remote a9cff9c17685459fa363aba65fd378f92e338bf1 eşit ve temiz. Çalışma yalnız yereldir: Cloudflare account API, provider app invocation, yeni canary, deploy, ücretli kaynak veya capacity campaign yok. Production canlı sorgulanmadı; F44 protected readback tarihsel olarak korunur, yeni gözlem diye sunulmaz. `src/`, `db/`, Wrangler ve dependencies HEAD ile aynıdır; DOCUMENTSfalse ve önceki F36/F41/F42/F43/F44 kabulleri değişmedi.

## Sözleşme ve alternatif kararı

Seçilen mimari: canonical CSRF mevcut HTTP Worker'da kalır. Ek Worker/DO/auth cache/ikinci authority yok. Aynı upload DO'ya dar delegation bu sözleşme altında reddedildi; saf handwritten config-validation PoC'si production'a promote edilmedi.

Canonical external yol outer worker configuration/path/origin/Host → security boundary → tek fresh local-session/D1 join/version/status/revocation/expiry/idle kontrolü → session-bound CSRF subject/nonce/HMAC/response akışıdır. Provider13ms ve F44 tracing-enabled18/11/19ms değerlerinin component nedeni burada bulunmuş sayılmadı. HTTP'de kalmak Free headroom PASS değildir; yalnız kanıtlanmamış auth/upload availability coupling eklemeyen en düşük riskli mevcut seçimdir.

Fresh D1/session/membership, permission/credential version, expiry/idle, revocation, CSRF subject bağları, TTL/nonce/signature, source/login/upload rate policy, origin/method/path ve aynı fail-closed status/body/header semantiği değiştirilmez. Mevcut CSRF GET'in kendisinde özel yeni source-rate quota yoktur; login kaynak/account throttling ve upload dispatch source limiter'ı ayrı mevcut yüzeylerdir. PoC bunlara yeni politika veya keyspace eklemez.

## Neden mevcut upload DO değil?

- Gerçek mevcut createUploadRuntime auth CSRF GET'i DOCUMENTSfalse iken404 verir; canonical HTTP aynı durumda geçerli session ile200 çalışır ve upload binding gerektirmez. Doğrudan forwarding response/availability eşdeğerliğini bozar. Bu kontrol tüm olası yeni DO tasarımlarının imkânsızlığını değil, mevcut runtime'ı aynen kullanmanın uyumsuzluğunu gösterir.
- Yerel same-event-loop karakterizasyonu gerçek1024×768 JPEG inspector'ını çalıştırdı: önce kuyruğa alınan bağımsız auth permit işi, abort ve0ms deadline callback'i parser dönüşünden önce çalışamadı. Parse valid tamamlandı; abort sonradan görüldü. Ayrı permit kapasite sınırı olabilir, CPU preemption değildir. Bu bir deployment/native latency ölçümü veya production DO throughput kanıtı değildir.
- Platform aynı DO instance routing ve aynı Worker kodundaki nesneler arasında global memory paylaşımını belgelemektedir. Sadece başka object adı seçmek isolate bağımsızlığı garantisi değildir. blockConcurrencyWhile auth'ı da bloke eder; timer/caller cancellation synchronous parser'ı kesmez.
- Ham geç D1 operation logical release/cancellation sonrasında admission'ı settlement'a kadar kapalı tuttu; kapalı permit yeni D1 çağrısını reddetti. Bu mevcut custody primitive'inin karakterizasyonudur, yazılmamış bir auth-DO executor'unun deadline/cancellation doğruluğu iddiası değildir.
- Aynı-isolate head-of-line, auth refresh'in upload parser'ına bağımlılığı, auth flood'un upload'a etkisi, DOCUMENTS=false availability ve response/deadline drift giderilmeden delegation benimsenmez. Daha geniş isolated architecture için necessity kanıtı ve ayrı yetki gerekir; burada ek kaynak oluşturulmadı.

## HTTP optimizasyon PoC'si ve negatif güvenlik

`engineering-drafts/m4-csrf-local/config-candidate.ts` yalnız saf config validator adayını içerir. Test spy ve RAM-only local esbuild substitution dışında production import'u yoktur. Session/membership/credential/CSRF-token/key cache yok; authoritative SQL/signing/request boundary aynıdır.

TDD: valid-snapshot testi RED(stub)→GREEN. Diferansiyel matrix ilk handwritten UTF16 length adayının16emoji'yi normatif Zod4.6.5'e aykırı kabul ettiğini yakaladı. Installed source code-point sayar. PoC32..63-unit aralığında exact code-point sayımıyla düzeltildi;64+unit zaten en az32 code pointtir. Primitive/root/array/inherited-field/getter/rotation ve surrogate sınırları test edildi. İlk semantik FAIL production'a hiç bağlanmadı; test/log korunur. Bu bulgu handwritten validator bakım maliyetinin somut örneğidir.

Gerçek yerel D1 ve actual exported HTTP worker altında baseline/candidate karşılaştırması:

- OWNER ve MEMBER için her request'te yeni authority; session revoke, permission-version, credential-version, membership suspension, absolute expiry ve idle expiry401/UNAUTHORIZED.
- İki session arasında token binding mismatch reddi; fresh nonce, secret rotation ve invalid-config aynı fail-closed davranışı.
- Foreign Origin/Host403, noncanonical encoded path404, POST404; canonical HEAD200/empty body mevcut haliyle korunur. no-store/no-Set-Cookie; outer403 bazen body boş olduğundan JSON varsayımı yapılmaz.
- DOCUMENTS=false ve DOCUMENT_UPLOAD_RUNTIME binding yokken HTTP CSRF200.
- Login source/account quota aynı şekilde password işinden önce çalıştı:401→429, iki source-limit çağrısı, bir test-password işleme çağrısı. Test hasher yalnız trusted local fixture'dır; yeni auth authority değildir.

İlk focused koşu16PASS/4FAIL: bir gerçek PoC Unicode mismatch; iki fixture last-owner/lifecycle SQL hatası; bir fixture boş outer403 JSON varsayımı. Fixture owner suspension için ikinci effective owner ve suspended_at ile düzeltildi; production guard/SQL değiştirilmedi. Son stabil dört dosya22/22PASS; ardından sadece Unicode boundary matrix genişletmesi için ilgili dosya yeniden doğrulanır. Historical FAIL/STOP saklanır; temiz eski aggregate diye yeniden yazılmaz.

## Bounded yerel profil

Opt-in profiler sadece local Miniflare/workerd + local inspector/CDP kullanır; gerçek exported Worker yolunu ve synthetic local D1'i çalıştırır. Her varyant80 GET, TLS Host rewrite yalnız local loopback için; candidate substitution yalnız RAM bundle'da. Context ve worker'lar finally dispose edilir, profile dosyaları OS Temp'e yazılır. Standart suite'te profiler opt-in olmadan skip; security/semantic testler aktiftir.

İlk geçerli paired run: baseline405.4701ms /candidate405.7602ms toplam yerel wall,130/129 V8 sample. parseCsrfConfig ancestor altında yalnız1 baseline sample, candidate0; sparse sample kesin cost attribution değildir. Final portability/type/timeout harness doğrulaması: baseline333.3184ms /candidate326.0651ms,104/111 sample. Her iki run saklandı; cherry-pick yapılmadı. Cold/init/isolate/profiler/ordering etkileri kontrol edilmiş native A/B diye sunulmaz. Provider CPU/headroom/sustained sonucu çıkarılmaz.

Handwritten validator için material, güvenilir uçtan uca fayda gösterilmedi. Saf check daha ucuz olabilir; riskli semantik duplication'ı production'a taşımayı haklı çıkaran kanıt yok. Aday PoC olarak kalır, schema kaynak otoritesi değiştirilmez. Native13ms kaynağı veya mitigation yüzdesi uydurulmadı.

Profiler ilk WebSocket inspector URL'ini HTTP fetch'e vermekten failed; local scheme düzeltildi ve gerçek capture yapıldı. Tip-only/import/fixture Env hataları quality gate'te düzeltildi; bu kayıtlar korunur. Lint/typecheck/format ve local source-no-drift kapanışta doğrulanır; değişmeyen full expensive suites tekrarlanmaz.

## Sonuç ve minimum kalan doğrulama

Bu çalışma iki yönü somut kapatır: mevcut shared upload DO delegation'ı zorlanmaz; ölçülmüş yararı gösterilmeyen handwritten validator production'a alınmaz. Seçilen güvenli mevcut yol HTTP'dir, source-level risk artışı yoktur. Root trace retrieval F44 retained4summary düzeyinde ayrı/ikincil kalır; yeni sorgu yapılmadı, karar onun mükemmelliğine bağlanmadı.

Free headroom'un ayrıca kapatılması gerekiyorsa minimum eksik bilgi: tracing disabled ve idle-touch/cold/isolate etkileri ayrılmış, ayrıca yetkilendirilmiş bounded native CSRF referansı. Bu görev bu çalışmayı tasarlama/yürütme veya yeni resource gerekliliğini kabul etme izni vermez. Böyle bir referans mevcut HTTP'nin gerçek CPU dağılımını göstermeden yeni isolation mimarisi veya başka speculative cache/rewrites seçilmez. Aynı eski upload/query/generic probe zinciri tekrarlanmayacak; DO delegation bu sözleşme altında reddedilmiş adaydır, sıradaki otomatik uygulama değildir.

Bağımsız fresh Sol HIGH20261016_153717_3beec6 contract/architecture/rejection/final-decision için0BLOCKER/0IMPORTANT/0OPTIONAL dar PASS verdi: HTTP korunur, shared uploadDO önerisi reddedilir, handwritten validator promote edilmez. Actual kapalı modelgpt6.1sol/provideropenai-codex/high/parentNULL/cli_close ve son assistant JSON eşitliği parent tarafından doğrulandı.416pin/26artifact drift0; production184dosya HEAD ile raw-byte eşit. Bağımsız semantic/shared6/6 ve gerçek localD1 HTTP15/15PASS,9991 differential kontrol0mismatch. Reviewer profiler'ı veya eski pahalı suites'i tekrar çalıştırmadı; provider/account/app/telemetry ve mutation0, credential loader yok. Eski kapasite BLOCKER/CSRF headroom IMPORTANT/root-trace OPTIONAL riskleri ayrı remainingRisks olarak korunur; bu yerel karar PASS'i native CPU veya release kabulü değildir. Review custody/hash ve scope receipts dosyasındadır. Yalnız yerel süreçler ve sentetik DB kullanıldı; provider cleanup gerektiren kaynak oluşturulmadı. Git source/config/schema no-drift ve secret scan kapanışta doğrulanır.

F45_SELECTED_CSRF_PLACEMENT=HTTP_WORKER
F45_SHARED_UPLOAD_DO_DELEGATION=REJECTED_UNDER_CURRENT_CONTRACT
F45_HANDWRITTEN_VALIDATOR_PRODUCTION_PROMOTION=NO
F45_PROVIDER_CALLS=0
CSRF_FREE_HEADROOM_ACCEPTED=NO
CAPACITY_EXECUTOR_AUTHORIZED=NO
DOCUMENTS_ENABLED=false
FEATURE_ENABLED=NO
M4_COMPLETE=false
