# M4 — F-26 çalışan-only belge güvenliği supersession kaydı

Karar: ürün sahibinin 5 Ekim 2026 tarihli açık talimatı. Etkin accepted taban: `5d71586a0a18189b726b55f7899fd5d5dd55d3fd`. Bu kayıt ikinci bir mimari otorite değildir; `NIHAI_MIMARI_VE_UYGULAMA_PLANI.md` bölüm 18/F-26 kararının gerekçesi ve ileri yönlü etkisidir. Uygulama/review kabulü ayrıca durum dosyasında kaydedilir; karar tek başına test PASS veya production readiness iddiası değildir.

## Ürün sınırı ve gerekçe

Uygulama yalnız önceden yetkilendirilmiş acente çalışanları içindir. Müşteri, sigortalı, public kullanıcı, dış ortak veya anonim kullanıcı CRM'ye giriş/yükleme yapmaz. Mevcut küçük ekip, personel sayısı üst sınırı değildir; büyüyen çalışan sayısı mevcut Agency/Membership/OWNER/MEMBER ve kişi izinleriyle desteklenir. Çok-kullanıcı concurrency, expected-version/CAS, receipt, audit ve atomik D1 mutasyonları değişmez.

Zorunlu ayrı antivirüs Container'ı, public/untrusted belge alımındaki risk/işletim maliyetine göre tasarlanmıştı. Çalışan-only boundary altında ürün sahibi bu zorunluluğu orantısız bulmuş ve aşağıdaki katmanlı modeli seçmiştir. Kötü amaçlı dosya/ele geçirilmiş personel cihazı riski sıfır değildir. Parser veya private storage, antivirüs taraması ya da güvenli dosya garantisi değildir.

## Korunan ve zorunlu kontroller

- Cloudflare Access + kabul edilmiş normal/secure audience ve MFA/session sözleşmesi; gerçek policy/login/alternatif URL kanıtı release kapısıdır.
- Canlı canonical authentication, membership, `document.upload` ve ayrı `document.read`/download action, typed parent scope; OWNER dahil explicit sensitive grant; hassas download secure confirmation + single-use grant.
- Default-deny yalnız PDF/JPEG/PNG; uzantı, declared MIME, gerçek signature ve bounded full structural parser. PDF aktif/şifreli/bozuk/desteklenmeyen alt küme reddi; JPEG strict bounded decode; PNG CRC/order/palette ve decompressor öncesi DEFLATE expansion sınırı. Dosya 20 MiB; mevcut parser sayfa/token/nesne/nesting/piksel/geometri/bellek sınırları korunur.
- Aktif XLSX upload gereksinimi yoktur; valid XLSX dahil Office, arbitrary ZIP, VBA/macro OOXML, XLSM/XLSB reddedilir. Dolayısıyla bu değişiklik XLSX kabulü veya naive ZIP-sniff üretmez. XLSX eklenirse gerçek OOXML content types/workbook/relationships ve bounded expansion+macro-deny ayrı reviewed requirement olur.
- Tüm executable/script/HTML/SVG default-deny. Server dosyayı çalıştırmaz, Office transform veya arbitrary HTML preview yapmaz.
- Private generated `quarantine/UUID` primary key (isim yalnız gösterim metadata'sıdır), immutable version/checksum. R2/r2.dev/public custom domain OFF; presigned/public paylaşım yok.
- Safe authorized attachment, server-owned sabit filename ve canonical MIME, `nosniff`, private/no-store; tam bounded primary EOF/length/hash ve disclosure öncesi canlı authority recheck.
- PII-free audit; body/filename/serbest hassas metin/credential loglanmaz.
- Güncel çalışan endpoint protection (Windows Defender/managed AV), yamalar, cihaz kilidi ve güvenli dosya açma işletim sorumluluğudur; ajan endpoint protection'ı kapatmaz.

## Semantik ve recovery

İleri yönlü migration `0019` yalnız nullable `validation_version/validation_result` ekler, structural guard/view ve active state transition'ı ileri yönlü değiştirir; eski migration SQL/snapshot'ları değiştirilmez. Aktif akış `PENDING_UPLOAD → BACKUP_PENDING → AVAILABLE`; kabul metadata'sı immutable version/sha256 bayt kimliğine bağlıdır. Validation SUCCESS bir malware verdict değildir. Yeni belgede scan evidence yazılmaz ve CLEAN üretilmez. Tarihsel gerçek scan evidence değişmez; compatibility view yalnız gerçekten mevcut legacy scan+inspection kanıtını ayrı `LEGACY_SCANNED` policy etiketiyle okuyabilir. Tarihsel rows yapısal kabul gibi yeniden etiketlenmez.

Backup availability gate kaldırılmaz: ayrı capability ile actual-byte copy+readback; immutable backup/run/job; latest version/generation; D1 CAS + audit + current pointer atomik finalization. R2 + D1 ortak ACID değildir; kalıcı reservation, retry ve reconciliation kalır. Restore historical scan kanıtlarını hâlâ doğrular, yeni yapısal kabulü ayrı doğrular; current offboarding/permission ve deletion-tombstone reconciliation olmadan sealed restore yayınlanmaz.

## Aktif runtime ve Queue reassessment

Yeni upload scan job oluşturmaz; doğrudan durable DOCUMENT_BACKUP oluşturur. Worker scanner adapter import etmez; legacy scan delivery ACK edilir ve tekrar scanner attempt başlatılmaz. `scan.ts`, scan enum/table/guard ve scanner regression'ları tarihsel/doğrulama uyumluluğu için kalır, production Worker graph'ına girmez. Aktif cron yalnız BACKUP/RECONCILE dispatch/reclaim yapar.

Generic D1 BackgroundJob/Run korunur. Queue yalnız delivery accelerator; D1 due state, lease/attempt/generation/CAS ve beş dakikalık redispatch otoritedir. Queue Free retention veya teslim retry limitinin dolması business job kaybı değildir. Gerçek D1 attempt bütçesi bitince kalıcı DEAD/investigation ve operasyon alarmı gerekir. Scanner-specific beş-kuyruk DLQ/overflow/terminal/hold zinciri ve ücretli 14-gün hold gereksinimi superseded; bunlar provision edilmez. Gerçek Queue kayıp/expiry/duplicate/publish failure+redispatch ve alarm teslimi dış gate'de kanıtlanmalıdır.

## Superseded current M4 gates

Zorunlu production ClamAV/Containers/Workers Paid-for-AV, scanner binding/image digest/egress/temp-cleanup/scan CPU-memory/concurrency/signature freshness/EICAR ve scan-specific queue/hold gates kaldırılmıştır. Tarihsel `M4_EXTERNAL_CLAMAV_EVIDENCE.md`, `M4_LOCAL_CLOSEOUT_EVIDENCE.md`, `M4_CLOUDFLARE_READONLY_INVENTORY.md` ve eski accepted checkpoints kendi tarihleri için geçerlidir, güncel scanner production gate'i değildir. Bu evidence dosyaları değiştirilmez.

## Güncel dış M4 kapıları — hâlâ açık

1. Gerçek hedef hesabında D1 ve private primary R2 EU jurisdiction; public domain/r2.dev OFF readback; binding doğruluğu.
2. Normal/secure Access uygulamaları, ayrı audience, OTP+bağımsız TOTP MFA, session/duration, bypass/service-token yasağı, drift ve gerçek staging login; alternatif URL koruması.
3. Yapısal validation ve safe authorized attachment akışının kontrollü gerçek runtime kanıtı; public/customer upload yok; no false CLEAN.
4. Kalıcı D1/R2 reservation/retry/reconciliation ve Queue acceleration/retention kaybı sonrası recovery; gerçek alarm hedefi ve teslim testi.
5. Ayrı backup hesabı/credential sınırı, runtime no-delete/restore/admin, primary+backup aynı credential ile yok edilememe, EU/35 gün lock/export retention.
6. Saatlik consistent export, trustworthy manifest provenance/recovery-key saklayıcısı, D1+R2 restore/RPO 1 saat/RTO 4 saat; güncel offboarding/permissions/deletion tombstone ve kontrollü publication onayı.
7. Gerçek veri öncesi sınıf-specific retention/legal/data-processing commissioning ve açık production release yetkisi.

`M4 COMPLETE=false`, `DOCUMENTS_ENABLED=false`; M5 başlamaz. Free-tier foundation yalnız Phase 1 full acceptance ve fresh read-only GPT-6.1 Sol High PASS sonrası provision edilebilir. Workers Paid, Zone Pro, ücretli Zero Trust ve Containers satın alma/aktivasyon yok. R2 ödeme yöntemi/usage-billing taahhüdü varsa önce resmi allowance/overage/cap açıklanır ve insan aksiyonu beklenir. Global API Key yalnız local administrative provisioning için kullanılabilir; runtime/repo/docs/reviewer prompt'a konmaz; scoped-token migration bu oturumun engeli değildir.
