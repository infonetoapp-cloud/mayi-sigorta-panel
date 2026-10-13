# Bağımsız backup monitor — yerel kanıt motoru / commissioning STOP

Başlangıç `30c05f3c65d1ce9b7285cec8ef32f887c31a3793`: main/HEAD/origin/main/remote eşit, worktree temiz. Bu checkpoint canlı monitoring veya notification kabulü değildir. İzinli mevcut repo-wide lint borcu da dar düzeltmeyle kapatıldı; backup pipeline/source/config redeploy edilmedi.

## Seçilen tasarım ve gerçek erişim kapısı

Tercih: backup Workflow/CRM'den ayrı scheduled observer; exact EU recovery bucket Object Read credential ile bounded list/HEAD + küçük manifest/COMPLETE GET; ayrı monitoring store için monotonic revision/CAS state; dış failure domain'de ücretsiz Healthchecks.io iki check (observer alive ve backup evidence fresh), mevcut human recipient email integration.

Observer-alive check 5m period/10m grace; yalnız gerçek tamamlanmış observer cycle sonrasında, HEALTHY veya diagnostic outcome olsa da, alive ping. Freshness check yalnız coherent valid recent COMPLETE için success; BACKUP_STALE/QUERY_OR_PROVIDER_FAILURE için `/fail`. Observer hiç bitmez/statewriter veya ping başarısız olur/global CF Cron durursa dış check missing heartbeat ile alert. Human email integration/delivery feedback onaylanmadan accepted değildir. Sent/state-write transaction yok: durable outbox/dedupe bounded retry, duplicate ihtimali ve recovery/reminder davranışı live implementation/review'da ayrıca kanıtlanacak; exactly-once iddiası yok. Backup data'ya write/delete yetkisi verilmez; native R2 binding façade IAM-read-only kanıtı sayılmaz. Dış management API key yalnız operator'da, Worker'da sadece iki check'e ait secret ping URL; URL/header/log exposure ve yetkisiz fake heartbeat tehdidi ayrıca review kapısıdır.

Mevcut Free zone standalone Health Checks entitlement0 (resmî plan tablosu); listGET200empty entitlement var demek değildir. Native send_email ancak hazır routing domain+verified destination ile Free; live routingunconfigured/verifieddestination0. Arbitrary-recipient Sending WorkersPaid gerektirir; domain onboarding MX/SPF/DKIM/DMARC DNS değiştirir. Mevcut Notifications recipient'i verified Routing destination değildir. Notifications test API genel mesaj servisi gibi kullanılmaz. Aynı CF Cron'da ikinci Worker global scheduler outage için bağımsız watchdog değildir. Native-only mevcut imkanlar ile hedeflenen dead-man/human delivery kabulü NOT_PROVEN.

Harici credential env-name discovery sonuç0; parola/APIkey içerikleri aranmadı veya basılmadı. Ücretsiz Healthchecks erişim seçimi masked/UI formu yanıtsız timeout; browser login denemesi localChromiummissing nedeniyle açılmadı. Browser/tooling kurulumu, hesap signup, ödeme, Email Routing enable, DNS veya yeni live monitor kaynağı yapılmadı. Eksik gerçek hesap erişimi uydurulmadı. Native dışındaki bütün ücretsiz sağlayıcıların imkansız olduğu iddiası yok: seçilen dış hizmete erişim henüz sağlanmadı.

## Uygulanan yerel komponent

`src/server/backup-monitor/evidence.ts`: immutable accepted writer sözleşmesinden exact sourceaccount/database/name/version/state, canonical key/prefix, natural-slot generation formatı, SQL metadata size/ETag/source/generation/bookmark, manifest/COMPLETE metadata generation ve COMPLETE-last upload sırası. Writer-compatible manifest bookmarknull↔SQLmetadataemptystring kabul edilir. ETag SHA256/MD5 veya restore kanıtı değildir; manifest `R2_HEAD_SIZE_ETAG_METADATA_NOT_SQL_SHA256` mustmatch.

Freshness90m exportTimestamp age'dir; exact cutoff dahil; bir ms dışı stale. Eski export yeni COMPLETE ile freshness yenilemez. Bu metadata objective RPO≤1h watermark/restore kabulü değildir. `monitorStatus` bağımsız evaluation-age15m sınırı; missing/stale/future heartbeat OBSERVER_FAILURE; mevcut query/provider failure eski healthy ile gizlenmez. Bu fonksiyon durable/live heartbeat writer değildir.

`observer.ts`: sabit observation T, pencereyi kesen en fazla3 UTC hour prefix, complete cursor/pagination,12page/500objects/6generation toplam cap, max8192byte küçük JSON reader contract, SQL bodyGET/put/delete interface'i yok. Empty complete scan ikinci bounded re-list sonrası BACKUP_STALE; partial SQL/manifest marker yoksa health kabul edilmez. Cursor cycle/provider/permission/malformed/budget/20s deadline QUERY_OR_PROVIDER_FAILURE. AbortSignal transport'a iletilir; adapter'ın cancellation ve size enforcement'ı deployed IAM/runtime testinden geçmeden live read-only/capacity kabulü değildir. R2 list transactional/linearizable snapshot değildir. Concurrent state CAS/outbox, backend reader/scoped credential, Worker/Cron/config ve Healthchecks integration bu checkpoint'te IMPLEMENTED/DEPLOYED değildir; library başarılarını end-to-end sistemmiş gibi sunmayın.

## Gerçek koşular

RED missingevidence module →1PASS; yeni discovery14tests içinde1FAIL→14PASS; timeout pendingread testi process timeout124→20s fail-closed implementation→PASS. İlk discovery fixture yanlış3prefix varsaydı, actual15:40UTC90mwindow2prefix doğruolarak düzeltildi. Typecheck ilk tuple-index/literalfixture errors → dar type-only corrections; history korunur.

Ara focused5files52testsPASS892ms; final6files58testsPASS1.04s (`backup.monitor-evidence`, `backup.monitor-timeout`, unchanged backupautomation/telemetry/oldwindow). Repo-wide lint/typecheck/boundariesPASS. Backup tooling hygiene `node:process`/`node:console` explicit imports + log→info; aynı JSONstdout semantiği. İki backup drybuild aynı bundleSHA836a2cbdf5fba885068432e210439908b7adc5b037d2aab53d51e332483e48cf; deploy yok. Script kendi sourcehash listesinde olduğundan tool-source identity doğal değişir, backup redeploy gerekçesi değildir.

Authenticated gerçek R2 read-only replay:15 metadataObject/10 küçük JSONGET/SQLbodyGET0/providerwrite0. Yeni evaluator generation995504/export16:00:08.221Z/COMPLETE16:00:15.266Z için HEALTHY/age639941ms verdi; authorityR2LISTmetadata+smallJSONGET, fresh exactHEAD backend veya deployedWorker/IAM/delivery proof değildir. Başlangıç backup995503 COMPLETE15:30:16.339Z227547byte metadatahealthy. Final protected before/after workers/Queue/buckets/domains/routes/alert/subscriptions exact eşit; final backup995505/export2026-10-13T16:30:07.206Z/COMPLETE16:30:18.299Z227547byte metadatahealthy. Source-only fresh independent GPT-6.1 Sol HIGH `20261013_192402_98c50d`, actual model/provider/high/parentNULL/cli_close verified:0BLOCKER0IMPORTANT/PASS yalnız LOCAL_METADATA_OBSERVER_COMPONENT_AND_HONEST_COMMISSIONING_NO_GO_ONLY; LIVE_OBSERVER_GO=NO. Reviewer kendi6files58PASS447ms,8981 independent assertion(4320UTCminute window cases dahil)/rootlint/typecheck/boundariesPASS ve current-source actualmetadata replay exact equality doğruladı. 8981 ayrı Vitest testi değildir. Live pre/postactivation reviews yapılmadı: monitoring production mutation0. [Güvenli receipt](BACKUP_MONITOR_PREFLIGHT_RECEIPTS.json).

## Mevcut flaky policy / rollback / next gate

Mayi D1 Backup Freshness UNTUNED/ENABLED korunur; replacement kabul edilmeden disable/delete yapılmaz. Fractional0.2/0.4 geçmişi ve no-data/error/resampling ambiguity eski evidence'da korunur. Bildirim testi veya synthetic failure email gönderilmedi; fake production COMPLETE event veya backup corruption yok.

İleride rollback: observer Cron disable, dış check'leri maintenance/pause, yalnız monitor state/credential revoke; backup schedule/artifacts/locks/CRM/documentQueues/auth/business etkilenmez. Bu tasarım incelenmiş intent'tir; live rollback proof değildir.

Exact sonraki gate: Healthchecks.io free project/account erişimi ve mevcut insan alıcısına verified email channel (secure login/APIkey provisioning; chat'e secret gönderilmez), veya kullanıcıca belirtilen erişilebilir başka ücretsiz external dead-man. Ardından exact read-only credential/statewriter/Worker/outbox implementation + fresh pre-HIGH0/0, limited synthetic monitor notification testi/actual receiver feedback, natural observer/deadman/API-error commissioning, farklı post-HIGH0/0. Ancak tüm replacement kapıları kapandıktan sonra eski flaky policy disable yetkisi kullanılır. Public feature activation/restore/paid plan için yetki yok.

BACKUP_FRESHNESS_OBSERVER_ACCEPTED=NO
BACKUP_OBSERVER_HEARTBEAT_ACCEPTED=NO
BACKUP_NOTIFICATION_DELIVERY_ACCEPTED=NO
BACKUP_FRESHNESS_ALERT_HEALTHY=NOT_PROVEN

M4 background/Queue/Cron acceptanceYES scope unchanged; DOCUMENTSfalse/FEATURENO/M4false/recoveryOPEN. STOP before public activation.

Official: https://developers.cloudflare.com/health-checks/#availability ; https://developers.cloudflare.com/email-service/platform/pricing/ ; https://developers.cloudflare.com/email-service/configuration/domains/ ; https://developers.cloudflare.com/notifications/notification-available/#custom-alerts-beta ; https://developers.cloudflare.com/r2/api/tokens/ ; https://healthchecks.io/pricing/ ; https://healthchecks.io/docs/http_api/ ; https://healthchecks.io/docs/api/
