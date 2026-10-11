# Recovery provider compatibility — LOCAL evidence

Başlangıç: main `8c05531526e8b8de4db21fb8ae77c0d666c22ab7`; HEAD/origin/main/remote main eşit, specialist başlangıç readback clean. Kapsam LOCAL/synthetic ve read-only source acquisition; remote create/import/deployment yok. `POPULATED_REMOTE_RECOVERY_STATUS=OPEN`, accepted local ordered restore ve diagnostic acceptance korunur. Bu belge mimari otorite değildir.

## Gerçek immutable 995313 yapısı

Accepted generation `d1-backup-slot-995313`, source220641/SHA `8eea4b138b27c8fd50926b17bec23231a8c80b2af66ba0cbb522ec05949823ea`; fresh GET bytes/hash eşleşti. COMPLETE metadata tarihsel accepted receipt üzerinden; bu slice yeni COMPLETE commissioning iddiası yok. SQL yalnız geçici özel dosyada/RAM, gövde/verifier/session materyali çıktıya taşınmadı; SQL ve receipt sonrasında silindi. Source/R2 write0.

Unchanged canonical single output220648/SHA `05ad52aa8cfcc5eaba21d0cfc9cb9e701bdbe51fa738f92e4bcd71d2eafb2768`: 387 statement; CREATE TABLE45 (44app+ledger), CREATE INDEX127explicit (44autoindex tablolarla oluşur), INSERT33, TRIGGER176, VIEW3; sqlite_sequence var. En büyük statement9615bayt. PRAGMA sırası defer_foreign_keys ON→OFF. Data yükünde trigger yok. View'ların daha sonra oluşturulan view referansı var; final validation hepsini resolve etmeli. Bu yapısal gözlem provider hata nedenini kanıtlamaz.

Kanonik FK graph:115constraint/112RESTRICT; tek cyclic SCC `[renewal_policy_links]` (self-FK `(agency_id,supersedes_link_id)`→`(agency_id,id)`), çok-tablosu SCC yok. Bütün schema tablolarının basit table-topological insert sırası mümkün değil; self table row ordering ayrıca gerekir. Snapshot non-NULL populated FK altgrafında cycle yok,12constraint: parent-before-child mümkün. Deterministic safe sıra: agencies,users,agency_memberships,audit_events,auth_identities,d1_migrations,local_credentials,local_sessions,system_audit_events. Boş business tabloları cycle gerektirmiyor. Bu graph-only tespit mevcut transport'u yeniden sıralamaz; gelecekte deferral-free replay için ayrıca local native proof gerekir.

RESTRICT parent DELETE/UPDATE semantiğidir; import yalnız INSERT ve sqlite_sequence özel reset içerdiğinden parent-before-child INSERT için ayrı blocker değildir. Schema/FK kaldırılmaz. `defer_foreign_keys=OFF` validation gate değildir: SQLite pending deferred violations'ı temizleyebilir. Accepted decoder zaten FK-valid source'u kontrol eder; her restore final foreign_key_check ve domain readback gerektirir. Single output bytes değişmedi; yalnız yanıltıcı comment düzeltildi.

## Üç strateji, aynı synthetic current-schema source

Node24.12.0/SQLite3.50.4/Wrangler4.133.0 ve native LOCAL D1/Miniflare:

- A: unchanged single canonical import PASS; exact21migration/schemahash/all45table count+fingerprints/auth principal-session relationships/FK0.
- B: üç ayrı LOCAL import transaction PASS; faz1 tables+ALLexplicit indexes (FK parent UNIQUE indexes data öncesi gereklidir), faz2 data+sqlite_sequence, faz3 triggers/views. Faz2 defer ON commit'e kadar korunur; OFF eklenmez. Her faz sonrası FK0+exact phase schema, faz2 sonrası rows exact; final schema/history/domain mandatory. Phase1/2/3 ayrı commits nedeniyle partial target mümkündür: SEALED/disposable, publication yetkisi yok.
- C: foreign_keys=OFF sadece experiment; native LOCAL D1 full auth import REJECTED, negative invalid-child INSERT de FOREIGN KEY ile reddedildi; post-query foreign_keys1. Dolayısıyla bu native import context OFF'u enforcement bypass olarak kullanmıyor. Bare SQLite transaction dışında OFF etkin ve invalid child yazımı mümkündü; final FK check1 bunu reddetti. C default/remote transport değildir.

`phased-d1-restore.ts` accepted canonical preparation'u kullanır; yeni SQL decoder/reorder yok. Verified native bytes'tan in-process branded/frozen package; caller JSON+hash ile SQL değiştiremez. Exact source/phase hash, LOCAL_ONLY+DISPOSABLE target(account/name/UUID), sequence, no retry, failed/concurrent/duplicate phase poisoning, mandatory per-phase readback ve mandatory final FK/schema/rows/domain gate. Temp-only files finally cleanup; R2 replacement/backup semantic change/default production target/network client yok. Hash'ler ayrı SOURCE ve derived phase kimlikleridir. Bunlar backup değil, DERIVED LOCAL RESTORE TRANSPORT.

995313 için hazırlanmış faz hash metadata (SQL tutulmadı, remote yürütülmedi):

| Faz | Bayt | SHA256 |
|---|---:|---|
| 1 | 95844 | 55c8a4bc595b4e9bc9eb9545db314238bd985a5ec80d5c865445b01976194631 |
| 2 | 8118 | 00fef9eeb3f8b2ea9f6796f102ddcdd94f58f18338a7e27b8d708db9aaefef57 |
| 3 | 116995 | 826289e6986b474d70c43863c2ac5d64653d0538f796b7075873f4b55cc7e0e9 |

## Public provider context ve sonraki seçenek

[Cloudflare developer-platform issue46](https://github.com/cloudflare/developer-platform/issues/46), public original report local success/remote failure ve D1_RESET_DO içeriyor; comment foreign_keys=OFF workaround'u bildiriyor. Bu community report güvenilir supported SQL change yetkisi değildir; local deneyimiz bunu native D1 import için doğrulamadı.

[Official foreign-key docs](https://developers.cloudflare.com/d1/sql-api/foreign-keys/): D1 implicit transaction nedeniyle user query foreign_keys ayarını değiştiremez; documented deferral `defer_foreign_keys`. [Official import/export docs](https://developers.cloudflare.com/d1/best-practices/import-export-data/): parent tablo mevcut olmadan referans mümkün değil, right-order şart. Public kaynaklar runtime flag'in underlying SQL cause'unu açıklamıyor. `{"D1_RESET_DO":true}` provider/import-runtime diagnostic olarak kalır; specific SQL/FK/syntax/root-cause iddiası YOK.

Puanlar ordinal engineering judgment (5 en iyi; ölçülmüş provider başarı oranı değil). Kolonlar evidence/integrity/docs/mutation-economy/partial-detection/recoverability/reproducibility:

| Sıra/seçenek | Puanlar | Karar |
|---|---|---|
| 1 D provider escalation/wait | 5/5/5/5/5/4/4 | En az spekülatif. Safe flag+local evidence ile insan manual submission; remote0. |
| 2 B phased transport | 3/4/3/2/5/4/5 | Local PASS; remote multi-import support/atomicity/bookmark lifecycle unresolved. Ayrı authority+provider guidance olmadan remote deneme yok. |
| 3 E official Time Travel | 3/4/5/3/4/3/3 | Source DB bookmark rollback; immutable R2 generation'ı yeni target'a restore eşdeğeri değil. Production destructive recovery ayrı kapı; bu drill'in alternatifi sayılmaz. |
| 4 A aynı single retry | 1/4/4/3/3/3/2 | Aynı deterministic SQL iki remote failure geçmişi; yeni cause/evidence olmadan kör retry önerilmez. |
| 5 C FK-OFF | 1/1/1/3/2/2/2 | SQLite-only bypass, native D1 negative; production integrity ile uyumsuz. Önerilmiyor. |

## Sanitized private support package

Repo dışında `C:/Users/sinan/AppData/Local/Temp/mayi-cloudflare-private-support-compatibility/`: manual-submission README, safe structure/graph summary, local receipts, public source references ve generic SQL fixture. Account/DB kimlikleri `MANUAL_PRIVATE_SUPPORT_FIELDS` olarak boş; public reproducer'a eklenmedi. Real email/name/verifier/cookies/tokens/credentials/signed URL/private rows yok. Automatic ticket/public issue posting0.

Generic `scripts/recovery/fixtures/provider-import-synthetic.sql` minimal FK-linked/CHECK/index/trigger/view/populated/Unicode example. Raw SQLite missing-parent failure ve canonical phased success kanıtlandı. Bu farklı local ordering failure'dır, D1_RESET_DO reproduction DEĞİLDİR. Native full-schema emulator da reset üretmedi. Provider-compatible remote reset reproduction NOTESTABLISHED.

## Verification

Focused43/43PASS (15phase+13ordered+15diagnostic); forged rehashed phase regression RED→brand fix GREEN. Initial native test SQL extra-parenthesis harness FAIL korunur; corrected full native A/B/C1/1PASS. Source opt-in safe structure1/1PASS, private temp SQL removed. Exact native schema335c292d19625658f789a09b9657730bb95a7db26bc5ac8b11f076d356a90a6f/21migration/44table171index176trigger3view/FK0. Final coherent acceptance: 45/45 PASS across five executed files, one opt-in private source inspector SKIP (its separate explicit run1/1PASS above is retained, not relabelled new execution); native A/B/C and unchanged native ordering included,132.49s. Typecheck/changed-filelint/fullformat/boundaries/diff PASS. ONE fresh independent GPT-6.1Sol/openai-codex/HIGH session `20261011_105459_714c4a`: BLOCKER0/IMPORTANT0/OPTIONAL0/PASS for LOCAL recovery candidate; independent43tests+27RAMprobes/schema graph and executable comment-only diff verified. Native/source inspection receipts reviewed, not rerun by reviewer. No RTO/remote recovery acceptance. Commit scope recovery tooling/tests/evidence only; default Worker source/config/migrations/backup writer unchanged.
