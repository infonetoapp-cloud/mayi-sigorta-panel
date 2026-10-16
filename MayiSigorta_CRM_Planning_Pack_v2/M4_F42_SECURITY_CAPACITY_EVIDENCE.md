# F-42/F-43 — security-negative kabulü; PNG functional PASS / kapasite observation STOP

Başlangıç: main, HEAD, origin/main ve uzak main 4165a8a83a35ba976dd0dd42756d3a463c22727c; worktree temiz. F36 canonical HTTP → private SQLite DO → D1/private EU R2 mimarisi ve product source/test/config değişmedi. F37 JPEG503 root cause UNKNOWN, F38 JPEG202 functional/native-gap, F39 local recovery, F40 minimal native capture ve F41 core provider recovery kabulleri aynen korunur. F41 başarılı recovery/replay bu görevde tekrar edilmedi.

## F42: gerçek negatif güvenlik

Yeni owned run e4e7d740-48b6-42d1-88fb-4d0f4a848a97, Worker/EU D1/private EU R2 mayi-http-0e2b712b92 ve private SQLite DO. Yerel canonical21migration/350schema/FK0/new-live-session preparation ve exact bundle dry-run PASS. Test ortamında DOCUMENTS=true, JOBS/CRON=false, Queue/route/zone/production bağı yok. Production DOCUMENTS=false.

Üç ve yalnız üç POST:

| Yeni fixture aşaması | Payload | HTTP / enum | EDGE CPU / wall | DO CPU / wall |
| --- | --- | --- | --- | --- |
| Pending-state setup: owned D1 finalbatch trigger abort | JPEG64×64,723byte |503 / UPLOAD_RETRYABLE|2ms /1078ms|53ms /592ms|
| Aynı key, değişmiş geçerli payload | PNG81byte |409 / IDEMPOTENCY_CONFLICT|3ms /309ms|14ms /287ms|
| Exact session gerçekten revoked; aynı key/orijinal JPEG | JPEG723byte |401 / UNAUTHORIZED|4ms /55ms|4ms /34ms|

Her native çift exact Worker/version16a1ab6f-cd26-459e-8563-64c2bc6e913c/POST/origin-path-stage/defaultEDGE/namedDO kimliklidir; altı native ID ayrı, finite nonnegative CPU/wall, outcome=ok, truncated=false. Controlled setup FINALIZE_BATCH FAIL / UPLOAD_VERSION_RACE kaydı mevcut. Revoked istekte console phase kaydı yoktur; bu optional progress yokluğu gerçek native yokluğu değildir.

F41 core recovery'yi yeniden kanıtlamak yerine yeni gerçek IN_PROGRESS reservation gerekliydi: yalnız disposable D1'e aynı reviewed finalbatch abort trigger'ı eklendi, trigger kaldırılmadı ve başarılı resume yapılmadı. Product failpoint/env-bypass/validation/security gevşetmesi yok. Yeni fixture'da önce gerçek CSRF endpoint'inden alınan geçerli token RAM'de korundu; session cookie token_hash aynı owned D1'de active-before → revoked-after olarak doğrulandı.401 kontrolünde sahte/eksik CSRF değil, aynı önceden geçerli token ve orijinal key/payload kullanıldı. Yanıt enum/no-store/no-Set-Cookie frozen assertionları ve stage-PASS ile doğrulandı.

Her aşamada aynı bir document/version/receipt/object key/SHA/size; PENDING_UPLOAD, validation=NULL, receipt IN_PROGRESS; job0/audit0/AVAILABLE0. Exact tek R2 ledger key, tam723byte binary SHA ve seed agency/customer/actor/member bağları değişmedi. Tam binary yeniden okunarak doğrulandı. Hiçbir unvalidated nesne AVAILABLE veya public olmadı. Ek app retry veya başarılı upload yok.

Preflight bağımsız Sol HIGH20261016_090131_e4ac80: ilk FAIL mevcut malformed optional DO ID kontrolü; ikinci FAIL tarihsel projection'ın missing alanı null'a çevirmesi; düzeltmeler yalnız yeni Temp wrapper'da, geçmiş F41 source değişmeden yapıldı. v3 PASS0/0/0,16/16 dar RAM presence/projection vakası,410pin drift0. Önceden açıkça HIGH-onaylı security-only missing-native istisnası tasarlanmıştı; gerçek üç native çift elde edildiğinden istisna KULLANILMADI. Historical F41 missing record geriye dönük doldurulmadı.

Combined foreground setup tool420s timeout sonrası completed deploy/bundle ledger, live-process absence, zero experiment/POST intent ve read-only reconcile doğrulandı; provision/import/deploy kör tekrarlanmadı. security() yalnız bir kez çalıştı. Owned trigger/fixture DB ile temizlendi. Bağımsız F42 post Sol HIGH20261016_094135_9cb80d securityAccepted=true: actual üç native çift live dry-query yeniden sorgulandı, immutable state/binary custody ve11GET actual protected production/Worker-bucket-DB404/KDF-only namespace cleanup doğrulandı. Silinmiş DB/object yeniden oluşturulmadı.

## F43: kapasite executor ve gerçek ilk workload

F42 güvenlik kabulünden sonra yeni owned run4203a9c7-b807-42f0-8fe8-9ba5de8909f9 / mayi-http-f6af3b7ce0 hazırlandı. Max17POST planı: representative PNG → exact20971520 PNG → bir active20MiB ve iki concurrent busy tiny PNG → cooldown61s +12 bounded mixed PDF/JPEG/PNG. Her yeni upload'dan önce önceki full integrity/native/aggregate stage-PASS zorunludur; gerçek cursor/count/identity/outcome/truncation ve EDGE<=10ms/DO<=30000ms kapıları, positive native gap için hiçbir istisna yok. Console progress/başlangıç marker'ları zorunlu değildir. Sustained süre/rate varsayılmayacak, gerçek aralıklar raporlanacaktı. Planlanan yük ölçülmüş sonuç değildir.

Exact executor HIGH ilk FAIL iki IMPORTANT: owned_keys validator argümanı/fetch ayrımı ve sustained/sonraki faz aggregate kapanış sırası. Yalnız Temp executor'da gerçek bounded EU object inventory GET + metadata/key/size/ledger kontrolü ve hash-bound stage closure/predecessor kapıları düzeltildi. Aynı reviewer dar correction v2 PASS0/0/0,72/72 RAM kontrol,411pin drift0. Security post kabulü tekrar koşulmadı. Provision/import/deploy bu yeni scope'ta birer kez PASS; F42 silinmiş fixture diriltilmedi.

Gerçekte yalnız BİR capacity POST:

- PNG1024×768,4981byte;786432pixel, canonical decompressedBytes3146496.
- HTTP202/replayed=false; tek logical document/version/receipt/job/SUCCESS audit/private R2 key.
- Version BACKUP_PENDING; m4-content-inspection-v1 ve expected full PNG inspection eşleşti; receipt COMPLETED202; job QUEUED/attempt0; AVAILABLE0.
- R2 tam4981byte ve SHA2566ec227dca4c2663c781fed4748f9f10fedf7290bf7a8fffe2d4e05f81790e4cd eşit.
- Gerçek DO native:104msCPU /614mswall /outcome=ok /truncated=false; exact stage/deployment/class/record kimliği.
- Altı bounded poll:0,0,14,14,14,14 kayıt. DO native ve complete202, PREPARE/RESERVE/R2_CHECKSUM/R2_PUT/FINALIZE OK kayıtları mevcut. Bu POST için EDGE native CPU/wall/outcome/truncation NOT_OBSERVABLE; EDGE wrapper console kayıtları da yok. EDGE bilinmeyen değerleri DO/client-time/komşu kayıttan çıkarılmadı.
- Ayrı /api/auth/csrf-token GET200:13msCPU /83mswall /outcome=ok /truncated=false. Upload EDGE ölçümü DEĞİLDİR; nominal Workers Free10ms HTTP sınırı üzerinde gözlenen ayrı headroom riski. Resource exhaustion veya historical JPEG503 nedeni kanıtı değildir.

Orijinal six-poll NOT_OBSERVABLE ve STOP dosyaları korunur. Başarılı PNG ölçüm için tekrarlanmadı. exact20MiB / overlap / controlled burst / sustained = NOT_TESTED. Yeni representative PDF/JPEG bu görevde yüklenmedi;723byte JPEG yalnız F42 failure/security fixture'ıdır. DO serialization/rejection/queueing/sustained throughput/shared isolate/peak memory bu çalıştırmadan kabul edilmez. Sıfır gözlenen exception, görünmeyen EDGE outcome'un ok olduğunu kanıtlamaz. Native measurement gate başarısızlığı functional PNG202'yi geçersiz kılmaz; sustained/architecture kabulü de üretmez.

Stop sonrası salt-okunur actual aggregate + second full binary GET: birer document/version/receipt/job/audit/object, exact validation/SHA, AVAILABLE0; upload intent count1. Full stage-PASS yazılmadı. Sonraki fazlar başlatılmadı. Cleanup sonrası yalnız hash-bound retained D1/R2 custody okunabilir; yeni canlı DB/binary kanıtı gibi sunulmaz.

## Kapanış ve kalan somut iş

F42 ve F43 cleanup ve final11GET production readback PASS; farklı fresh final Sol HIGH20261016_100559_7efae9:0BLOCKER/0IMPORTANT/0OPTIONAL, yalnız F42 güvenlik ve F43 PNG functional PASS / zorunlu-native STOP kapanışını kabul etti. Gerçek kapalı model/provider/high/parentNULL/cli_close ve son assistant JSON eşitliği parent tarafından doğrulandı.61 bağımsız assertion,436pin ve133artifact reference drift0;11 yeni GET ile actual owned Worker/EU DB/EU bucket404/KDF-only namespace/production settings-deployment-traffic/üçQueue-Cron-Free doğrulandı. Aynı sınırlı PNG penceresinde metadata.service ve workers.scriptName filtreleriyle dört dry query (14kayıt+boş terminal sayfa) DO104/614 ve ayrı CSRF13/83'ü yeniden doğruladı; uploadEDGE hâlâ NOT_OBSERVABLE. Late-only native kabulü de yok; capacityExecution/architecture/sustained/release izinleri false. Önceki F42 actual native/cleanup kabulü değişmez custody ile korundu, gereksiz yeniden sorgulanmadı. Provider mutation/app request/deleted DB-object fresh read0. Kapanış raporu/verification hash'leri receipts dosyasındadır. Production version7e97419b-241a-4cf1-92de-d4ee62d70002/deployment182b1c6d-0542-4568-8e20-6453a73d297b/traffic100 korunur; DOCUMENTSfalse/JOBStrue/CRONtrue, üç Queue/Cron/bindings/KDF/Free aynı. Production business-data mutation/deploy/feature activation/Paid/DNS/billing/Excel/frontend/unrelated auth/backup infrastructure değişikliği yok.

Yeni source/test/config değişmedi; kabul edilmiş expensive suites tekrar koşulmadı. İki local native seed/schema preparation, exact dry-run bundle, HIGH RAM countercases ve gerçek provider/readback kontrolleri yapıldı. Git diff/format/source-no-drift/secret scan/commit-push-clean-remote kontrolleri closure'da doğrulanır. Bütün eski FAIL/STOP, yeni F42/F43 preflight FAIL ve F43 native STOP kanıtları korunur.

Sıradaki somut milestone: bağımsız final bounded retained-query turu da EDGE kaydını bulamadı; aynı geçmiş sorguyu veya başarılı upload'ı tekrar etme. Yeni yük/deploy olmadan positive native capture güvenilirliği/lifecycle/query-attribution için ayrı bounded HIGH-reviewed engineering kararı gerekir; root cause henüz kanıtlanmadı. Ayrı CSRF GET13ms Free headroom riski ölçülmüş bir sonraki teknik girdidir. Güvenlik kapıları artık açık engel değildir. Tam native gate kabulü sonrası exact20971520 → gerçek overlap/burst → gerçek agency sustained yük ilk çalıştırıldığı yerden sürer; historical başarılı JPEG/PDF/PNG salt metric için tekrarlanmaz. Production release ayrıca yetkilendirilir; public activation öncesinde STOP.

F42_PROVIDER_SECURITY_NEGATIVE_ACCEPTED=YES
F43_REPRESENTATIVE_PNG_FUNCTIONAL_ACCEPTED=YES
F43_INITIAL_PNG_FULL_NATIVE_ACCEPTED=NO
M4_HTTP_ADMISSION_ARCHITECTURE_ACCEPTED=NO
M4_HTTP_SUSTAINED_FREE_CAPACITY_ACCEPTED=NO
DOCUMENTS_ENABLED=false
FEATURE_ENABLED=NO
M4_COMPLETE=false
