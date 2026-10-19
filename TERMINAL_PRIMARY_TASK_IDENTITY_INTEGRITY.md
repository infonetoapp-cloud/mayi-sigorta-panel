# Terminal primary Task identity — dar backend bütünlük düzeltmesi

Başlangıç: main/HEAD/origin/main/uzak main `43ef50225929e1cdc242941e274578166c125885`. Yetki yalnız terminal hedef-kimliği, gerekli legacy adapter ve odaklı regresyonlar içindir. Phase4F frontend kabulü ve WON modernizasyonu değildir; **Phase4F LOCAL NO-GO kalır**.

## RED ve kök neden

Mevcut Phase4F gerçek local-auth/D1 negatifleri değişmeden yeniden çalıştırıldı: LOST ve VOIDED2RED, beklenen409/no-effects yerine200. A Task CAS1/renewal CAS1 normal completion ile A COMPLETED/CAS2 ve B OPEN/CAS1 olur; renewal CAS1 kalır. Eski id-less terminal request o andaki OPEN B'yi seçerek B'yi de tamamlayabiliyordu.

Ayrı gerçek D1 WON üretimi geçerli `LINK_POLICY` sonucu kullandı: HTTP200, `wrongTask=true`, state=WON, snapshot unchanged=false. Bu nedenle WON da aynı dar backend invariant'ına alındı; policy-create/link, quote acceptance, allocation ve finansal kuralları değiştirilmedi. Kanıt: ignored `terminal-identity-original-red.json` (2RED) ve `terminal-identity-won-red.json` (1RED). Bunlar geçmiş RED olarak korunur, GREEN diye yeniden etiketlenmez.

## Exact identity sözleşmesi

- Yeni LOST, VOIDED ve tekil WON yazımları strict required `expectedPrimaryTaskId` ister. ID trim ile başka tokene dönüştürülmez; nonempty/max128/exact-trim doğrulanır. Diğer payload alanları ve endpoint'ler aynı kalır.
- Kanonik payload fingerprint'i zaten tüm parsed input'u içerir; yeni ID dolayısıyla hash'e dahildir. Aynı key altında ID veya payload değişikliği conflict'tir.
- Yeni yazım yalnız supplied ID ile agency+renewal+customer+RENEWAL_FOLLOWUP bağlı exact Task'ı yükler. Task OPEN ve exact task CAS; renewal open ve exact renewal CAS gerekir. A completed olduğunda409; B'ye fallback yoktur. Wrong/missing/unrelated/nonprimary hedef yeni business effect oluşturamaz.
- `completePrimaryTaskStatement` zaten row.task_id+agency+renewal+kind+OPEN+task CAS ve açık renewal CAS/assignee predicate'ine bağlıdır. Renewal terminal UPDATE aynı exact Task'ın COMPLETED/+1CAS/timestamp/actor kanıtını ister. Bu mevcut SQL bağı artık request'in exact Task'ından gelir. Authority assertion, receipt, Task completion+CAS assertion, renewal closure+CAS assertion, history ve SUCCESS audit aynı gerçek D1 batch/rollback sınırında korunur. LOST aktif loss-reason assertion'ı ve WON link/quote/policy assertion'ları değişmez. Yeni migration veya ek JS-only atomicity iddiası yoktur.
- Legacy `RenewalWorkspacePanel` yalnız üç terminal payload'a mevcut props.taskId'yi ekler; ekran, reason, confirmation, financial ve retry davranışı yeniden yazılmadı. TodayWorkPanel ve modern Phase4F bileşeni değiştirilmedi.

## Tarihsel id-less replay

Required yeni-write şemalarından ayrı strict transport-compatible Request şemaları ID yokluğunu yalnız tarihsel receipt lookup'a kadar kabul eder. Ortak `terminalTaskId` receipt yoksa `PRIMARY_TASK_ID_REQUIRED`400 verir, hiçbir OPEN Task resolve etmez. Receipt varsa actor-bound action+renewal target ve receipt'in orijinal primaryTaskId'si kullanılır; eksik ID fail-closed. Canlı authority, fingerprint/status/response parser, Task/history/audit ve WON policy/link/quote kanıtları mevcut yolda tekrar doğrulanır. Receipt bir erişim grant'i değildir. Receipt yarışında da eksik original Task ID için açık fail-closed guard vardır.

Yeni key ile id-less mutation yasaktır. Eski exact-body/key completed receipt replay'i eski fingerprint biçimiyle korunur; yeni-field fingerprint'i eski gövdeye sessizce çevrilmez. Yeni receipt'in ID alanını düşürerek replay409 verir. Yeni istek ID'si receipt'in orijinal ID'sinden farklıysa fingerprint conflict'tir; unrelated replacement authorize edilmez.

Kalıcı tarihsel fixture açıkça sentetiktir: production batch'te yalnız receipt fingerprint binding'i eski id-less kanonik hash ile oluşturulur; Task/history/audit/link ve constraint SQL'leri gerçek D1'de aynen yürür. Sonraki replay gerçek güncel HTTP route/session/CSRF ile yapılır. Eski binary çalıştırıldığı iddia edilmez; fixture receipt UPDATE/trigger disable içermez. OWNER suspension ve session iptali sonrası replay/new write deny ayrıca sınanır.

## Regresyon ve kalite kanıtı

Yeni kalıcı `tests/renewal-terminal-task-identity.api.test.ts`: WON RED→GREEN; üç sonucun stale A/fresh B; missing/malformed/wrong/unrelated/nonprimary; identity fingerprint/replay; tarihsel id-less receipt; barrier'lı same-key races; final batch öncesi normal A→B replacement ve receipt/history/audit/policy-link rollback; completion-vs-LOST/VOID; LOST-vs-VOID; OWNER/MEMBER private Task, foreign/HEALTH/session/member deny.

Mevcut `tests/renewal-terminal-modern.api.test.ts` adayına yalnız iki helper'da `expectedPrimaryTaskId: t.taskId` eklendi. Böylece özgün iki negatif eski A ID'sini gerçekten gönderir; eksik alan400'ü GREEN sayılmaz. Dosyanın tamamı stage/commit edilmez.

Legacy UI testinde WON/LOST exact payload beklentilerine aynı seçili taskId eklendi; VOIDED için ayrı kısa payload case eklendi. Protected dirty legacy API fixture'ı yeniden yazılmadı: yalnız20 sabit/yerel mevcut Task ID alanı eklenen disposable test kopyasında mevcut19 test çalıştırıldı. Orijinal assertion ve domain akışları korunur; kaynakta bulunan önceden dirty iki expiry fixture düzeltmesi bu koşuda aynen kalır. API identity fixture güncellemesi index'e yalnız ilgili field hunks olarak alınır; önceki iki expiry değişikliği bu backend commit'ine katılmaz. Dolayısıyla clean HEAD'in bütün tarihsel suite'inin geçtiği iddia edilmez; ölçülen ilgili19 testin bağlamı budur.

İlk geniş koşu40PASS/9FAIL verdi: yeni testin VOID audit action adı, GENERAL Task için actor_kind ve SUSPENDED membership için suspended_at fixture alanları eksikti. Assertion/fixture'lar gerçek schema ile uyumlu düzeltildi; runtime invariant zayıflatılmadı. TS key default UUID daraltması test helper'ında string tipiyle düzeltildi. Bu ilk koşu final PASS değildir.

İkinci kalıcı dosya koşusu10PASS/15FAIL verdi: suspension trigger'ı login_enabled'i de kapattığı için fixture cleanup yalnız üyeliği ACTIVE yaparak yeni session açamıyordu; sonraki14 case bu bozuk setup'ın cascade hatalarıydı. Cleanup yeni credential epoch'u provision edip yeni session oluşturur; revoked session satırları geri açılmaz veya değiştirilmez. Ürün auth/session kodu değiştirilmedi. Bu koşu da tarihsel FAIL olarak korunur.

### Son tamamlanmış gate

- Son kaynakla iki gerçek local D1/API dosyası **49/49 PASS**,0fail/0skip, exit0: kalıcı identity25 + korunmuş Phase4F API24. Komut `node.exe node_modules/vitest/vitest.mjs run tests/renewal-terminal-task-identity.api.test.ts tests/renewal-terminal-modern.api.test.ts --maxWorkers=1 --reporter=json --outputFile=node_modules/.cache/terminal-identity-accepted-api.json`. Özgün LOST/VOIDED negatifleri aynı dosyada yeni alanla eski A'yı hedefleyerek409/no-effects doğrular; WON negatif/fresh B ve normal A→B batch race de GREEN'dir.
- Legacy gerçek D1/API doğrulama kopyası **19/19 PASS**,0fail/0skip, exit0: create/link/EXISTING_LINKS, quote-bound Individual/Company WON, OWNER, sensitive HEALTH, exact replay, cancelled-parent replay, reopen/correction, competing WON/LOST ve group/allocation kardeş regresyonları. JSON `terminal-identity-legacy-api.json`. Geçici test dosyası kaldırıldı; exact doğrulanmış kaynak ignored `terminal-identity-legacy-verification.source.txt` içinde tutulur. Yukarıdaki dirty fixture bağlamı geçerlidir, clean-checkout tam suite PASS iddiası yoktur.
- Legacy UI **40/40 PASS**,0fail/0skip, exit0: completion13 (yeni VOIDED payload case dahil), workspace6, quotes14, WhatsApp7. JSON `terminal-identity-legacy-ui-final.json`. Aynı-key/body retry ve mevcut policy/quote-financial beklentileri korunur.
- Ayrı kapsam toplamı **68 gerçek D1/API +40 UI =108 PASS**. İlk RED/ara FAIL ve tekrar koşuları toplama katılmaz. Modern Phase4F UI/Edge final kabulü bu backend görevinde çalıştırılmadı.
- Son `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` (client + Worker **yalnız dry-run** + security boundaries), `git diff --check`: PASS/exit0. Wrangler'ın mevcut çoklu-environment uyarısı vardır, deployment yapılmadı. Önceki generated patch preflight'ındaki eksik son newline hatası yalnız ignored patch artefaktında düzeltildi; kaynak veya index'e kısmi hatalı uygulama olmadı.
- Koruma denetimi: başlangıç15 dosyanın14'ü SHA256 eşit; yalnız modern API helper'ına eklenen iki identity satırı farklı. Bu iki satır çıkartıldığında dosyanın baseline hash'i de birebir eşleşir. Protected durum belgesi aynı hash'te, frontend/harness/evidence/demo korunur. Stage sadece backend/legacy compatibility/regression/evidence allowlist'idir; modern aday API dosyası stage edilmez.

## Koruma, güvenlik incelemesi ve yayın sınırı

- Başlangıç15 dirty/untracked dosyanın SHA256 baseline'ı `node_modules/.cache/terminal-identity-preservation-baseline.json` içinde. Modern components, parent guards, CSS, browser harness, frontend evidence, demo, mevcut UI adayları ve protected durum belgesi byte-for-byte korunur. Tek worktree istisnası izin verilen modern API helper'ındaki iki identity alanıdır. Legacy API uyumluluk field hunks'u index-only uygulanır; mevcut dirty worktree bytes korunur.
- `MayiSigorta_CRM_Planning_Pack_v2/UYGULAMA_DURUMU.md` SHA256 `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`; edit/stage/commit yoktur.
- Uygulayıcı source incelemesi: exact row loader ve tüm üç command/replay/receipt-race yolları, actor+target bağları, batch/CAS sırası, strict schemas ve legacy caller incelendi. NORMAL OWNER/SENSITIVE HEALTH ayrımı ve MEMBER private-Task üst sınırı korunur. Yeni permission, fallback OPEN resolver, server import/client storage veya secret/log eklenmedi. Ayrı reviewer/ajan çalıştırılmadı.
- Şema, migration, auth evaluator/session, task completion/assignment, quote send, allocation/financial runtime ve Cloudflare/dependency/config değişikliği yoktur. Deployment, gerçek veri, Paid, dış mesaj, documents/R2 aktivasyonu yapılmadı. Phase4F frontend resume/acceptance veya Phase4G otomatik başlatılmadı.
