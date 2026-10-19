# Frontend Phase 4G-B — LOCAL GO / WON CREATE_POLICY

Taban main: `42ee58e9119a267288188b0dc7628a1b12e2a621`. **Phase4G-B LOCAL GO**, yalnız aşağıdaki tamamlanmış yerel kapılar için. Phase4G-A LOCAL GO korunur. Tarihsel RED/FAIL/checkpoint'ler aşağıda ayrı tutulur. Protected `UYGULAMA_DURUMU.md` başlangıç SHA256 `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`; edit/reset/stage/commit yoktur.

## Kapsam ve gerçek sözleşme

Mevcut WonPolicyOperation state machine'ine yalnız `mode=CREATE_POLICY` eklenmiştir; LINK_POLICY default branch korunur. Yeni ayrı WonCreatePolicyForm mevcut client policy-form-model blank draft/validatePolicy/premiumMinor fonksiyonlarını kullanır. Standalone PolicyForm veya server parsePolicyCreateInput yeniden yazılmaz; client server modülü ithal etmez.

İki açık eylem: “Kazanıldı — mevcut poliçeyi bağla” ve “Kazanıldı — yeni poliçe oluştur”. Aynı endpoint `/api/renewals/:id/close-won`. CREATE yalnız tek POST içinde original expectedPrimaryTaskId + renewal/task CAS + `result:{kind:'CREATE_POLICY',policy:...}` gönderir; öncesinde POST/api/policies yoktur.

Policy payload yalnız customerId, explicit insurerId/productId/branchId/paymentMethodId/assigneeMembershipId, policyNumber/startDate/endDate/grossPremium/currency/installmentCount/status içerir. `grossPremium` noktalı decimal **string**; safe integer conversion BigInt ile, `grossPremiumMinor` field gönderilmez. status=ACTIVE; customer seçili renewal customer'ına sabittir. Sigortacı/sorumlu blank başlayıp kullanıcı tarafından açıkça seçilir; backend default insurer veya implicit actor assignee UI adına varsayılmaz.

Catalog GET `/api/catalogs/selectable`: aktif insurer/branch/product/payment, matching product-insurer-branch ve same-agency snapshot, payment destek/max taksit. Desteklenmeyen eski taksit değeri sessiz silinmez; açık temizleme gerekir. Currency/date/number/premium iş doğrulaması mevcut policy modelidir; server son otoritedir. Gönderimden hemen önce catalog tekrar okunur; selected-row version/lifecycle/signature değişiminde review+confirmation sıfırlanır, draft korunur. Read failure submission kapatır. Number server normalization/uniqueness kurallarına tabidir; client aynı policy number'ı değiştirip tekrar üretmez.

Sorumlu açıkça seçili Task assignee'sinden veya yetkili `/api/policies/:oldId/assignment-options` kaynağından seçilir; assignment-options okunamazsa başka sorumlu listesi icat edilmez. Başka assignee için bağımsız policy.assign, CREATE için bağımsız policy.create/HEALTH yetkileri server'da kalır. OWNER rolü client'ta grant gibi kullanılmaz.

Ayrı review yeni policy numarası, sigortacı/ürün/branş/ödeme, tarih, exact decimal+minor/currency/taksit/ACTIVE/sorumlu, sabit müşteri/Task/iki CAS ve tüm prim tahsisi sonucunu gösterir. Son checkbox ayrı zorunludur. Bu CRM kayıt işlemidir; gerçek sigortacı issuance veya müşteri mesajı değildir.

## Quote association sınırı

**CREATE_POLICY dalında optional quote association bu fazda yoktur.** UI bunu açıkça bildirir; hiçbir teklif seçilmez/kabul edilmiş sayılmaz ve acceptedQuoteVersionId/quoteDifferenceReasonCode gönderilmez. LINK_POLICY'nin explicit SENT association ve difference/replay/readback davranışı aynen kalır. Backend'in CREATE dahil shared atomic quote-expiry invariant'ı önceki `WON_QUOTE_EXPIRY_ATOMIC_INTEGRITY.md` kanıtıyla kapalıdır; backend değişmediğinden uzun real-wait deneyleri gereksiz tekrar edilmedi. Bu sınırlama kullanıcı yetkisindeki izin verilen dar kapsam seçeneğidir.

## Immutable attempt ve bağımsız proof

Her branch ayrı component instance/risk snapshot tutar; shared engine URL/method/serialized body/key/target/proposed policy fields'i frozen attempt'te tutar. Network/408/429/5xx yalnız exact retry. Confirmed HTTP201 veya proven historical200 replay sonrası GET-only. HTTP409 draft korur, aynı Task bounded authorized queue'dan ve aynı policy-number customer-filtered aramasından karşılaştırılır; explicit same-Task adoption ve yeni review/onay gerekir. Task A→B numeric CAS eşitliği identity kanıtı değildir; B otomatik benimsenmez. CREATE→LINK branch conversion veya automatic new policy number yoktur.

Response original Task/renewal/state/previousState/CAS increments/canonical closedAt/nonempty distinct createdPolicyId/single newPolicyIds/linkIds/link amount/currency/null quote evidence doğrular. New create HTTP201; historical replay HTTP200 yalnız `replayed:true` ise kabul edilir. Eksik success proof accepted HTTP olduğu için ikinci POST değil unverified GET-only kalır.

Authorized bounded customer renewals GET state/version + created policy ID'nin full PolicyDetailDto'su okunur: customer/agency/insurer/product/branch/payment/assignee/number/date/fullminor/currency/installments/ACTIVE/nonarchived/version1 proposed snapshot'la eşleşir. Daha sonra policy değişirse veya erişim kaybolursa başarı uydurulmaz. Bu GET tamamlanmış Task/internal link/audit satırlarını bağımsız kanıtlamaz; bunlar gerçek D1 testlerinde doğrulanır.

Parent risk CREATE, LINK, LOST, VOIDED ve önceki interaction/task/quote/SENT draft'larını mutual exclusion ve mevcut navigation guard'a bağlar. Unresolved creation selection/queue refresh/paging/sidebar/native-history geçişini engeller; dirty draft leave/stay prompt'unda korunur. Signal/epoch scope-unmount sonrası delayed401/catalog yanıtını bastırır. Payload/key/browser draft storage veya URL'ye yazılmaz. Legacy WON ve standalone policy creation kodu değişmez.

## RED/checkpoint kayıtları

- `phase4gb-ui-red.json`: new CREATE action yokken gerçek missing-action RED; sonra initial end-to-end UI case GREEN, typecheck geçti.
- `phase4gb-create-api-first.json`: **21/21 PASS**,0FAIL/0skip. Runtime assertions Green; sonraki typecheck yeni testte unused copied helper, too-narrow null fixture type ve delete-optional hatalarını buldu. Yalnız test helper/type düzenlendi; domain expectation gevşetilmedi.
- `phase4gb-create-boundaries.json`:4PASS/1FAIL/21filter skip. Archived fixture original open-renewal customer'ını zorla archive etmeye çalışınca mevcut `OPEN_DEPENDENCIES` guard'ı haklı olarak ABORT etti. Guard kaldırılmadı: test önce bu reddi/snapshot korunumu doğrular, sonra bağımsız dependency-free archived customer'ı sahte policyholder olarak gönderip wrong-target409/no-orphan'ı doğrular. Bu yeni backend kusuru değildir.
- `phase4gb-ui-expanded.json` ve `phase4gb-ui-checkpoint.json` focused runtime PASS; ilki sonrası yukarıdaki test-only typecheck hataları vardı. İkinci komuttaki singular `policy-form.ui.test.tsx` glob'u gerçek dosyayı hedeflemiyordu; standalone form/page regresyonu nihai kapıda gerçek `policy-forms.ui.test.tsx`/`policy-pages.ui.test.tsx` ile çalıştırıldı.
- İlk format-check, mevcut LINK browser selector label değişikliğinin formatını işaretledi; yalnız bu test formatter'ı uygulandı, tekrar PASS. Test veya production domain davranışı değişmedi.
- `phase4gb-edge-first.log`: ilk CREATE9-cell tam PASS checkpoint; final runtime sonrası daha güçlü native navigation ve LINK regression ile yeniden kapanış koşusu yapılıyor. İlk PASS son kapı yerine sayılmaz.
- App root StrictMode kullandığından yeni formun mount→cleanup→remount katalog yaşam döngüsü ayrıca test edildi. `phase4gb-strict-red.json`1FAIL: cleanup sonrası eski reader lock'u ikinci effect'i engelliyordu. Cleanup lock'u serbest bırakıp eski finally'nin yeni epoch lock'una dokunmasını engelleyen dar client düzeltmesi sonrası `phase4gb-strict-green.json`1PASS/25filter skip; bu backend kusuru değildir.
- `phase4gb-ui-accepted.json`368PASS/1FAIL: yeni stale-Task karşılaştırma testi,409 mesajı göründüğü anda henüz disabled olan düğmeye basıyordu. Test mevcut disabled guard'ın bitmesini bekleyecek şekilde düzeltildi; ret/draft/no-retarget assertion'ları korunur. Son bütün UI gate'i ayrıca esas alınır.
- `phase4gb-edge-accepted.log` setup'ta FAIL (hiç cell çalışmadı); o sırada aynı localhost harness'inin LINK regression süreci çalışıyordu. Raw diagnostic loglanmadığı için kesin provider/OS hata kodu iddia edilmez. Harness'ler izole çalıştırılmak üzere önceki sürecin exit0 kapanışı beklendi; ayrı `phase4gb-edge-closure.log` final tekrar kaydıdır. Setup failure hiçbir9/9 sonucuna katılmaz.

## Nihai kabul — LOCAL GO

### Gerçek D1/API:110/110 PASS

`node_modules/.cache/phase4gb-api-final.json`, süreç exit0; **110PASS/0FAIL/0skip**,7 dosya bütün halinde:

| Dosya                                      | PASS |
| ------------------------------------------ | ---: |
| renewal-won-create.api.test.ts             |   26 |
| renewal-won-modern.api.test.ts             |   19 |
| renewal-terminal-task-identity.api.test.ts |   25 |
| renewal-won-cycle-http.api.test.ts         |    8 |
| renewals.m3-t03-terminal.test.ts           |   19 |
| policy-forms.api.test.ts                   |    7 |
| policies.m2-t04-validation.test.ts         |    6 |

CREATE26: HTTP201 tek policy/link, fullminor/selected customer+insurer/product/ACTIVE/Task CAS/WON/history/receipt/two SUCCESS audits; exact historical replay/changed-key-body ret; invalid premium/date/currency/installment/catalog/product/duplicate/no-default; explicit insurer when default null success; old A→B ret/no orphan; final audit injection500/full snapshot rollback; MEMBER create allow vs no-create and unauthorized different-assignee denial; HEALTH no-sensitive deny; create permission revoked between preflight and final batch403; real final-batch barriers same-key/different-key/VOIDED/normal Task completion races one business outcome; foreign agency, assigned-customer scope and new HEALTH policy while original is GENERAL deny; actual assignee suspension after successful preflight deny/full rollback. Existing legacy19 ayrıca CREATE-vs-LOST yarışını ve mevcut WON branches'i korur.

Archive case mevcut original open-customer archive işleminin OPEN_DEPENDENCIES ile reddini ve değişmemesini gösterir; guard'ı atlayarak impossible archived-open-renewal fixture kurulmaz. Ayrı archived customer'a policyholder değiştirme409 ve no-orphan doğrulanır. Policies, renewal/task/history/link/quote/version/event/receipt/audit/assertion11-table snapshot rollback kanıtıdır. Başarısız terminal completion newly inserted policy bırakamaz. Backend/migration/trigger değişikliği yoktur.

### UI:369/369 PASS

`node_modules/.cache/phase4gb-ui-closure.json`: **369PASS/0FAIL/0skip**, exit0,19 dosya bütün halinde. Yeni CREATE26; LINK30; terminal workspace13; LOST/VOIDED36; standalone policy forms23/pages17; SENT59; quotes-modern35; interactions23; task operations19; modern queue18; statistics6; navigation2; auth8; legacy completion13/workspace6/quotes14/today14; WhatsApp7.

CREATE26: exact decimal-string payload/no standalone endpoint, confirmation, valid catalog/form, catalog lifecycle/failure draft retention, installment support/max, invalid premiums/period/currency, wrong readback customer/insurer/assignee/minor/version/status, malformed201 evidence, network/408/429/500/503 exact retry,201 GET-only recovery, definitive duplicate409/no auto-number/no hidden LINK conversion, stale Task no retarget, old catalog401 suppression, actual app StrictMode full flow. Parent extra CREATE case draft/no-overwrite/refresh prompt/mutual LINK+LOST guard. LINK tests yalnız istenen label “mevcut poliçeyi bağla” ile uyarlandı; business assertions değiştirilmedi.

API110 + UI369 = **479 ayrı otomatik test PASS**. Önceki21/25/368 checkpoint'leri bu toplama eklenmez; filtre skip'ler PASS sayılmaz. Tüm repo suite'i çalıştırılmadı.

### Gerçek Microsoft Edge

Final CREATE komutu `node.exe tests/browser/today-work.smoke.mjs --create-only`, `phase4gb-edge-closure.log`, süreç exit0. Browser **155.0.4283.45**, Windows Microsoft Edge channel, disposable local D1 ve canonical synthetic logins. Kanıt dizini:

`C:\Users\sinan\Desktop\panel\node_modules\.cache\phase4gb-edge-acceptance-EkWgxF`

`result.json` scope `PHASE4GB_CREATE_POLICY_ONLY`; üç actor ×1440/768/360 unique9cell ve9PNG ayrıca Python ile sayılarak doğrulandı.

| Aktör | 1440 | 768  | 360  | Gerçek izin bulgusu                                                                                             |
| ----- | ---- | ---- | ---- | --------------------------------------------------------------------------------------------------------------- |
| OWNER | PASS | PASS | PASS | Yetkili CREATE201, own snapshot explicit assignee; session revoke cleanup                                       |
| Ahmet | PASS | PASS | PASS | Own Task CREATE201; renewal WON grant kalırken policy.create silinince403/no new policy; session revoke cleanup |
| Ayşe  | PASS | PASS | PASS | Own Task CREATE201; renewal WON grant kalırken policy.create silinince403/no new policy; session revoke cleanup |

OWNER missing-create denial case'i uygulanmadı: implicit NORMAL owner yetkisi nedeniyle false flag ret beklenmesi değildir. MEMBER actual grants kullanıldı; OWNER eşdeğeri yapılmadı.

Her aktörde her width: explicit full form+assignee+decimal premium, review/confirmation, HTTP201 ve D1 tam policy/link/fullallocation/task/WON/receipt/two SUCCESS audits.1440 ordinary success;768 server gerçek commit sonrası kayıp yanıt ve sameURL/body/key200 historical replay;360 policy GET503 sonrası yalnız GET recovery ve ikinci POST0. No POST/api/policies request observer ile doğrulandı; browser storage0;9 screenshot ve horizontal overflow0; LINK/LOST aynı draft sırasında disabled.768 unresolved queue/sidebar/native back guard'ları; sidebar collapsed olduğundan ek nav probe desktop'ta, retry kendi768 viewport'unda. Session revoke sonra korunan forms0. Runtime/CSP error0.

LINK regression ayrıca gerçek `--won-only` koşusunda **9/9 PASS**, süreç exit0 (`phase4gb-link-edge-regression.log`), kanıt:

`C:\Users\sinan\Desktop\panel\node_modules\.cache\phase4ga-edge-acceptance-4e9KhS`

result.json ve9PNG ayrıca sayıldı. Mevcut full allocation, explicit SENT association/ACCEPTED readback, exact retry/GET-only, A1→B1 stale ret, cycle409, private-task/grant/session denial ve navigation korunur. Bu iki declared scope ayrı ayrı9cell'dir; eski failed setup/önceki checkpoint'ler başarıya çevrilmez. Son StrictMode reader cleanup değişikliği yalnız yeni CREATE formunu etkiler; son CREATE matrisi onun ardından tekrar bütün halinde geçti, LINK motoru o noktada değişmedi.

### Kalite, yayın ve koruma

Final typecheck/lint/format-check/client build/Worker **yalnız dry-run**/security boundaries/diff-check PASS. Mevcut Wrangler multi-environment uyarısı vardır; deploy yoktur. Yeni backend integrity/security kusuru bulunmadı; backend, standalone policy form/model/validation ve migration kaynakları değiştirilmedi. Bağımsız reviewer veya ayrı ajan kullanılmadı.

Commit scope yalnız Phase4G-B yeni form, mevcut WON engine/parent risk ve açıklama entegrasyonu, CREATE API/UI/Edge testleri, LINK accessible-label test uyarlamaları, ortak browser harness ve bu kanıttır. Protected belge byte-for-byte aynı ve commit dışıdır; tarihsel4G-A kanıtı değiştirilmedi. Stage/push sonrası exact allowlist, local/origin/remote equality ayrıca okunur.

Sınır: CREATE_POLICY quote association yoktur; katalogda açıkça seçilmiş full-premium ACTIVE policy ile tek atomic command. Gelişmiş group/EXISTING_LINKS/partial allocation/correction/secure grant yoktur. Yetkili GET yeterli değilse unverified kalır; yeni policy veya ikinci mutation ile readback onarılmaz.

Production/Cloudflare/migration/Paid/gerçek müşteri/gerçek policy issuance/dış mesaj/document/R2 yoktur. EXISTING_LINKS/group/partial/shared/cross-policyholder/secure grant/premium correction yoktur. Phase4G-C başlatılmadı.
