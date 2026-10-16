# F-46 — CSRF native referansı: preflight FAIL / provider yürütülmedi

## Karar ve gerçekleşen kapsam

CPU-headroom hedefine ulaşılamadı: altı-slot provider referansı yürütülmedi. Fresh bağımsız GPT-6.1 Sol HIGH preflight 1 BLOCKER / 5 IMPORTANT / 0 OPTIONAL FAIL verdi. Kullanıcının explicit preflight-fail STOP talimatı uygulandı; executor düzeltilmedi, ikinci preflight veya yeni deney açılmadı. Bu bir native CPU FAIL veya mevcut HTTP mimarisinin Free'de imkânsızlığının kanıtı değildir. CSRF_FREE_HEADROOM_ACCEPTED=NO mevcut kanıt eksikliğini ifade eder.

F45 korunur: canonical CSRF HTTP Worker'da kalır; shared upload DO delegation reddi ve handwritten validator non-promotion değişmez. Authentication, freshness/revocation/membership/permission/credential version/expiry/idle/origin/method/path/CSRF ve rate-limit kaynakları değişmedi. F36/F41 recovery/F42 negative-security/F43 representative PNG functional kabulleri ve historical FAIL/STOP korunur. F43 positive upload EDGE NOT_OBSERVABLE ve historical JPEG503 UNKNOWN soruları yeniden açılmadı.

## Git ve protected production uzlaştırması

Başlangıç clean main HEAD c8ca21f3e3c9f7ac966ee3401f9aae496a17790f, origin/main ve canlı uzak main a9cff9c17685459fa363aba65fd378f92e338bf1. F45'in10 dosyası ve closed HIGH exact JSON/model/provider/reasoning/parentNULL custody doğrulandı. Closure metadata dışındaki7 dosyanın HEAD blob'ları reviewed freeze hash'leriyle birebir aynıydı; src/db/Wrangler/dependencies diff0. Sonra yalnız normal git push yapıldı; fetch ve canlı remote readback c8ca21f eşitliğini/clean main'i doğruladı. Commit rewrite/amend/force yoktur. F46 kapanış kaydı post-review sonrası ayrı yerel docs commit'iyle saklanacaktır; F45 uzak commit'i korunur, F46 push yetkisi genişletilmez.

Protected başlangıç 13:12:25Z ve kapanış 13:39:36Z (16Ekim2026) readback'leri11'er salt-okunur GET'tir: production version7e97419b-241a-4cf1-92de-d4ee62d70002 / deployment182b1c6d-0542-4568-8e20-6453a73d297b / traffic100 aynı. DOCUMENTS=false, mevcut JOBS=true/CRON=true, üç Queue paused/consumer/settings kimlikleri, Cron ve permanent KDF-only namespace/subscriptionsFree korunur. Yeni upload binding deploy edilmedi. Bu parent readback'i executor'ın aşağıdaki eksik protected zincirini geriye dönük onaylamaz.

F46 hedefi ayrıca exact Worker404 ve complete account D1 inventory2GET ile yok doğrulandı. Create/deploy/experiment/request intent, journal ve resources dosyası yoktur. Post-review sonrası16:55:27Z ek11GET production readback'i de başlangıç/pre-post-review ile observation time dışında birebir aynı çıktı. Toplam bu görevde35 account metadata GET; provider mutation0, app invocation0, telemetry query0, yeni Worker/D1/R2/DO/Queue/Cron0, cleanup DELETE0. Kaynak oluşmadığından cleanup gerekmedi. F44 tarihsel temporary kaynak yokluğu ile F46 hedef yokluğu receipts'te ayrı kanıtlardır. Post-review'in24GET kapsamı o inceleme anındaki doğru toplamdır; sonraki11GET ayrıca hashed kapanış metadatasıdır.

## Yürütülmeyen deneyin önceden sabit sözleşmesi

- Bir disposable Worker ve yeni EU D1; direct canonical src/server/worker.ts, tracing explicitlyfalse, invocation logs100%. R2/DO/Queue/Cron yok; documents/jobs/cronfalse. Mevcut auth kotaları10/60 ve1000/60, isolated test namespaces; quota gevşetme/cache/yeni authority yok.
- Altı ayrı geçerli NORMAL session, tek import zamanı: created now-1h, absolute12h, lastSeen no-touch now-1min veya idle-touch now-20min. Sıra no-touch1/idle-touch1/...3. Session timestamp reset, prime/health veya otomatik retry yok; redirectsfalse. Cookie/token/subject/key çıktıya taşınmaz.
- Hedeflenen kontroller: fresh canonical authoritative session join; RAM HMAC/subject binding/nonce16byte unique/TTL900/iat; before-after row ve yalnız beklenen idle-touch; business rows0; native exact worker/version/method/query-stage/component/id/finiteCPU/wall/outcomeok/truncfalse.
- Native observer slot başına en çok6 poll,8s aralık,4page/1000; missing record veya gerçek functional/security/state/resource failure sonraki slotu durdurur. CPU>10/outcomeok yalnız önceden sabit kalan slotları sürdürür, iyi metrik toplamak için tekrar yoktur.
- Credible dar reference headroom ancak altı tam kayıt ve bütün CPU<=8ms; nominal Free10ms'ye gözlenen en az2ms marj. >8 marj göstermez; >10/outcomeok sustained limit failure sayılmaz. Bütün örnekler, ilk gözlenen dahil, karara girer.
- CLI startup request CPU değildir; ilk gözlem cold, sonraki warm/same-isolate sayılmaz. Isolate identity/reuse ve startup etkileri kanıt olmadan UNKNOWN kalır. D1 beklemesi CPU'ya dahil değildir; wall-CPU farkı D1 süresi değildir. Tracing-disabled referans geçmiş tracing-enabled örneklerle nedensel A/B sayılmaz.

## Gerçek yerel kanıt ve preflight bulguları

Local full canonical HTTP+native workerd SQLite D1 fixture6/6 PASS:21 migration,350 schema object, üç no-touch/üç idle-touch, doğru HMAC/subject/nonceTTL ve sadece beklenen lastSeen davranışı. Local-only Host normalization loopback içindir; planlanan provider main'de yoktur. Direct-entry Wrangler --dry-run PASS. İlk local node:crypto external ve Miniflare namespace_id hazırlık FAIL logları saklıdır; source kusuru değillerdir. Saf field evaluator1 valid/16 malformed fixture kontrolü PASS; bunlar mock unit testleridir, provider/native ölçüm değildir. Değişmeyen pahalı eski suites/profiler tekrarlanmadı.

Fresh HIGH20261016_163116_efe4dc actual closed modelgpt-6.1-sol/provideropenai-codex/high/parentNULL/cli_close ve son assistant exact JSON eşitliği doğrulandı.512 pin drift0;137 src/21 migration ve183 tracked source/config raw bytes HEAD aynı. Reviewer source/contract/fixture/schema ve AST-isolated gerçek executor fonksiyonlarıyla şu açıkları buldu:

1. BLOCKER: D1 UUID yalnız eski permanent baseline'dan dışlanıyor, bu run'ın immediate-before databaseIds envanterinden değil. Partial Worker deployed.json olmadan exact version ve deploy custody doğrulanmadan owned kabul edilebiliyor. Destructive cleanup sözleşmesi eksik; gerçek kaynak/DELETE yok.
2. IMPORTANT: Native attribution eksik entrypoint'i default sayabiliyor, eventType doğrulanmıyor. Eksik alan için desteklenmiş default semantiği veya açık fetch/component kanıtı gereklidir; uydurulamaz.
3. IMPORTANT: Farklı URL'ye ait görünür exceededCpu kaydı hedefin ok kaydıyla birlikte dışarıda kalabiliyor; global resource-failure stop kapsamı tam değil. Başka isteğin CPU'su hedefe atfedilmez.
4. IMPORTANT: no-touch assertion yalnız after>before false ister; eşitlik istemez. Azalan lastSeen de assertion'dan geçer. Canonical SQL trigger normal yazımlarda azalmayı engeller; bu executor assertion eksikliğidir, production regression kanıtı değildir.
5. IMPORTANT: inherited protected snapshot yalnız legacy Queue'yu ve namespace dışındaki bir alt kümeyi kıyaslar; tüm üç Queue/KDF contract'ını karşılamaz. Parent'ın11GET tam readback'i bu gelecekteki executor boşluğunu kapatmaz.
6. IMPORTANT:900s yalnız slot başında denetlenir; kalan provider timeout/polling/final kabul kontrolüne taşınmaz.901s final acceptance yerel fake bağımlılıkla üretilebildi; gerçek native CPU sonucu değildir.

Parent ayrıca immediate-before UUID kabulü ve azalan no-touch assertion'ını saf yerel AST testinde yeniden üretti; API/app0. Hiçbir preflight bulgusu düzeltilmiş/waive edilmiş sayılmaz; orijinal operator/freeze/report bytes korunur. F46 provider CPU/wall/outcome/truncation dizisi boş, executionStatus=NOT_EXECUTED_PREFLIGHT_FAIL. Bunu logging ingestion NOT_OBSERVABLE olayı diye yanlış adlandırmayız; gönderilmiş invocation yoktur.

## Mühendislik sonucu, kalan seçenekler ve sınır

Özgül source optimizasyonu gerekçelendirilmedi: yeni native ölçüm ve gösterilmiş bottleneck yok. Önceki F44 CSRF18/11/19ms (tracing enabled) ve F43 bağımsız13ms tarihsel gözlemlerdir; kontrollü tracing-disabled/idle-touch/cold/isolate sonucu yerine geçmez. Authentication'ı zayıflatmak, cache/sharedDO/handwritten rollout veya başka mimari denemek yetkili değildir.

HTTP mimarisinin dar functional/security/recovery kabulleri geçerlidir; strict Free CPU headroom ve sustained kaynak uygunluğu henüz kabul edilmez. Paid zorunluluğu gösterilmedi. Mevcut kodu ve CLOSED durumu korumak bu görevdeki somut karardır; sahte CPU PASS veya mimari imkânsızlık iddiası yoktur.

Minimum ilerleme seçeneği, yalnız kullanıcı ayrıca yetkilendirirse bu altı executor sınıfını kapatan bounded yerel hardening ve fresh bağımsız kanıttır. Bu görevde otomatik corrective/preflight/provider döngüsü yoktur; sağlayıcıya geçiş yeniden açık yetki+PASS gerektirir. Kabul edilmemiş CPU riskini operasyonel olarak kabul etmek ayrı kullanıcı/risk kararıdır, headroom PASS'e dönüştürülemez. Workers Paid, resmi güncel tarifede en az USD5/account/month +included usage üzerindeki kullanım ücretleri seçeneğidir; ayrıca açık ücret yetkisi olmadan etkinleştirilmez ve ownership/deadline/protected eksiklerini çözmez. Şu anda ücret değişikliği önerilmez/gerekçelendirilmiş değildir.

Capacity testing yeniden başlayamaz. Önce güvenli executor kapısı ve gerçek dar native CSRF referans değerlendirmesi; ancak olumluysa ayrıca fresh HIGH kapasite executor'ü ve açık workload yetkisi gerekir. F43 historical positive EDGE yokluğu ayrı kalır; yeni yetkili positive canonical workload için bağımsız EDGE/DO CPU/wall/outcome/truncation+authoritative D1/R2 integrity zorunludur. Başarılı eski PNG yalnız metrik için tekrarlanmaz. Exact20MiB/overlap/burst/sustained, production deployment ve public activation bu görevde açılmadı.

Ayrı fresh SolHIGH20261016_194420_fc6dcd STOP-kapanışı0BLOCKER/0IMPORTANT/0OPTIONAL PASS kabul etti. Actual closed modelgpt-6.1-sol/provideropenai-codex/high/parentNULL/cli_close ve son assistant exactJSON custody doğrulandı.4file exact closeout freeze drift0,25artifact ref drift0;512originalpin içinde yalnız2closure-doc değişti, rejected operator/helpers ve production source aynı. Reviewer ownership/partialWorker/no-touch açıklarını RAM AST ile bağımsız yeniden üretti; canonical SQL trigger ve diğer preflight sınıflarını kaynakta doğruladı. Provider/app/credential loader/init/telemetry0, kaynak/Git değişikliği0. Bu PASS yalnız STOP-kapanışıdır: preflight FAIL1/5 korunur; provider execution/headroom/capacity yetkisi veya kabulü yoktur. Sonrasında yalnız3kapanış belgesinin bu sonuç metadatası işlendi; ana plan ve reddedilen candidate değiştirilmedi. F46 kapanış commit'i yalnız yereldir; F45 normal remote commit'i korunur.

F46_PREFLIGHT=FAIL_1_BLOCKER_5_IMPORTANT
F46_PROVIDER_REFERENCE_EXECUTED=NO
CSRF_FREE_HEADROOM_ACCEPTED=NO
SOURCE_OPTIMIZATION_JUSTIFIED=NO
CAPACITY_EXECUTOR_AUTHORIZED=NO
DOCUMENTS_ENABLED=false
FEATURE_ENABLED=NO
M4_COMPLETE=false

Kaynaklar: https://developers.cloudflare.com/workers/platform/limits/#cpu-time ; https://developers.cloudflare.com/workers/observability/logs/workers-logs/ ; https://developers.cloudflare.com/workers/platform/pricing/ (16Ekim2026 retrieval). Limits CPU/network-wait/isolate flexibility ve1102 ayrımını, pricing USD5 minimumu doğrular; ürün davranışı ve hesap kabulü yerine geçmez.
