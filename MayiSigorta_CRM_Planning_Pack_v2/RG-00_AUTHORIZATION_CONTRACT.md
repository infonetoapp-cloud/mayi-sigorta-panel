# RG-00 Authorization Contract

**Proje:** Mayı Sigorta CRM
**Kapı:** RG-00 Authorization Contract Resolution
**Durum:** PASS
**F-27 authentication/assurance supersession:** Tarihsel RG-00 authorization kabulü korunur; yeni local-auth implementasyon/review PASS iddiası değildir. Aktif kimlik yalnız OWNER-provisioned email/parola ve hash-only opaque D1 session; günlük çalışan Access/JWT/OTP/TOTP/MFA/secure audience SUPERSEDED. Cloudflare administrative MFA ayrı kalır. OWNER/MEMBER/NORMAL/SENSITIVE/scope/dependency/tenant/last-owner/CAS/idempotency/audit invariant'ları değişmez. Ayrıntılı aktif auth/credential/session/reauth/CLI sözleşmesi nihai plan bölüm5/F-27'dedir.
**Amaç:** Agency, membership, permission, authorization evaluator, sensitive-data authorization, owner administration ve personnel management implementasyonları için deterministik source-of-truth sözleşmesi.

Bu sözleşme `NIHAI_MIMARI_VE_UYGULAMA_PLANI.md` içindeki authorization kararlarını ayrıntılandırır ve CF-01 OWNER effective-permission belirsizliğini kapatır. Authorization implementasyonunda bu dosyadaki daha özel kurallar uygulanır. Belirsiz yorum, role hierarchy, policy DSL veya örtük istisna eklenemez.

## A. Executive decision

Aktif ürün sahibi kararı (`aa278e864722d016623ecbc1c2b64cd962f3a440` sonrası): standart personel regular müşteri/poliçe/yenileme/teklif/görüşme kayıtlarında AGENCY read ve olağan edit snapshot'ıyla çalışır. ASSIGNED yalnız bilinçli custom kısıt olarak korunur; kayıt sorumluluğu standart görünürlüğü kısıtlamaz. Yeni şablon mevcut grant kayıtlarını değiştirmez; geçiş kişi bazında OWNER'ın taslak incelemesi, gerekçe ve mevcut secure grant/CAS/audit onayıyla yapılır. Hassasiyet ve tenant invariant'ları değişmez.

Task mahremiyeti zorunlu üst sınırdır: MEMBER eski AGENCY grant'i olsa bile yalnız kendi Task kayıtlarını ve kişisel görev istatistiğini görür/değiştirir. Merkezi evaluator bu kuralı task permission içeren composite action'larda da uygular; collection listeleri sorguda `task.assignee_membership_id = authenticated membership` filtresini LIMIT/cursor/sayım öncesi zorunlu uygular. Genel kayıt erişimi private task kimlik/vade/sürüm/iş yükü ayrıntılarını açıklamaz. `task.assign`, `renewal.assign`, `report.management` OWNER_ONLY'dir; OWNER atanmamış/yeniden-atama kuyruğunu yönetir. İzin checkbox'ı bu sınırı kaldıramaz. Özel Task değiştiren terminal komut/replay canlı task yetkisini ayrıca korur; ortak görüşme/teklif çalışması bunun dışındadır. Henüz olmayan rapor/export route'ları fail-closed kalır; ileride aynı kendi-Task filtresini uygulamadan açılamaz.

Yenileme etkileşimi yazar kimliği yalnız authenticated sunucu identity'sinden yazılır. Aynı agency içindeki kalıcı membership/user bağı okunabilir adı sağlar; pasifleştirme/askıya alma tarihsel yazarı gizlemez. DTO email, grant veya ham aktör ID'si döndürmez. Kaynakta ad yoksa dürüst fallback gösterilir. Yenileme NOTE genel müşteri notu değildir; müşteri profilinde ilgili yenilemenin altında gösterilir. `ed722723e2f335682179ccdde7b0f6458313f3b0` sonrası yetkili bağımsız müşteri notu özelliği ayrı `customer_notes` kullanır: read customer.read; create customer.read+customer.update; tenant/record scope ve live identity/User/Agency/membership/permission-version/grants atomik yazımda ve replay/read sorgularında tekrar doğrulanır. Server-owned author/name snapshot, append-only DB koruması ve tek batch note+receipt+audit esastır. Arşiv sonrası yeni create DENY; izinli geçmiş ve exact completed retry eski kalıcı sonucu verir. DTO yalnız note ID, content, authorName ve createdAt; customer notes günlük Task veya yenileme interaction'ı oluşturmaz.

RG-00 authorization modeli şu şekilde kesinleştirilmiştir:

17 Ekim2026 sabit görev istatistiği kapsamı: `/api/tasks/statistics` self için report.operations+task.read, team için güncel OWNER+report.management+task.read ve her ikisinde bağlı kayıt/health scope ister. MEMBER'ın açık iş sayımı assignee=self, tamamlanan faaliyeti gerçek completed_by=self ile sınırlıdır; tamamlanan görevin bugünkü assignee'si tarihsel tamamlayanı değiştirmez. Başka kişi filtreleri ve team, legacy AGENCY report/task/management grant'leri dahil MEMBER için DENY. Bu yalnız toplu kendi faaliyet açıklamasıdır; başka kişiye atanmış görevin ID/içerik/vade veya ayrıntı okumasını açmaz. Genel report resolver fail-closed kalır; dar sabit servis yerel report resolver composition ve son session-bound D1 batch'te canlı permission/lifecycle/type assertion kullanır. OWNER personel sayfası50, toplam sayfalama öncesi tüm yetkili veri; pasif/askı çalışan geçmişi ve iş yükü korunur, NULL atanmamış ayrıdır. DTO özel task/müşteri/poliçe veya hassas alan taşımaz. İş günü/tarih tanımı nihai plan bölüm8'dedir.

- ROLE ile PERMISSION aynı kavram değildir.
- `Personel` ve `Yetkili Personel` yalnız onboarding şablonlarıdır. Runtime rolü veya yetki kaynağı değildir.
- OWNER, normal bir rol veya permission set değildir. `AgencyMembership` üzerindeki korunan özel üyelik türüdür.
- OWNER:
  - Acente sınırı içindeki tüm NORMAL operational permission'ları implicit olarak alır.
  - SENSITIVE permission'ları implicit olarak almaz.
  - Owner-only yönetim capability'lerine sahiptir.
  - Agency, üyelik durumu, hassas veri, own-password reauth/secure action grant, audit, karantina, yeniden doğrulama ve sistem invariant'larını aşamaz.
- Normal MEMBER yalnız açık `MembershipPermission` grant'leriyle yetki kazanır.
- `MembershipPermission` yalnız pozitif GRANT taşır. Explicit DENY yoktur.
- Kayıt bulunmaması her zaman DENY'dır.
- Sensitive izinler herkes için, OWNER dahil, explicit grant gerektirir.
- High-risk işlemlerde permission veya OWNER olmak tek başına yeterli değildir; geçerli `SensitiveActionGrant` gerekir.
- ACTIVE dışındaki tüm üyelik durumları authorization açısından DENY'dır.
- ACTIVE Agency hiçbir zaman sıfır etkin OWNER'a düşürülemez.
- Yetkilendirme lookup veya altyapı hatalarının tamamı fail-closed DENY üretir.
- Unknown, malformed veya katalog dışı action DENY'dır.

Model bileşenlerinin sınırları:

- **Agency:** Tenant ve veri sınırıdır. Yetki vermez. Bir kaydın agency sınırı doğrulanmadan permission hesabı yapılmaz.
- **User:** Global insan hesabıdır. Tek başına hiçbir acente erişimi sağlamaz.
- **AuthIdentity:** Sabit local issuer+rastgele stable subject ile User'a bağlanır; credential/session canlı doğrulanır. Email tek başına authorization kaynağı değildir. Legacy verified_email adı OWNER_PROVISIONED provenance ile email sahipliği doğrulanmış iddiası taşımaz.
- **AgencyMembership:** User'ın Agency ile ilişkisini, üyelik durumunu, `OWNER | MEMBER` türünü ve authorization sürümlerini taşır.
- **Membership status:** Üyeliğin evaluator'a girip giremeyeceğini belirler. Yalnız `ACTIVE` girebilir.
- **OWNER:** Korunan membership type'tır. Grant edilebilir checkbox veya katalog permission'ı değildir.
- **Permission catalog:** Bilinen permission kodlarını, NORMAL/SENSITIVE sınıfını, scope tipini, bağımlılıklarını ve assurance gereksinimini kodda sabitler.
- **MembershipPermission:** Bir membership'e verilmiş açık, pozitif permission grant'idir. Rol, deny, policy script veya template bağlantısı değildir.
- **Record scope:** Permission'ın hangi Agency kayıtları üzerinde kullanılabileceğini belirleyen server-side resolver'dır.
- **Sensitive permission:** Kimlik, sağlık ve gelecekteki benzer hassas veri sınıfları için ek ve zorunlu bir kapıdır. Normal kayıt izninin yerine geçmez.
- **SensitiveActionGrant:** Son5dakika kendi kalıcı parolasıyla reauth edilen normal session'dan üretilmiş, ≤3dakika tek kullanımlık payload-bound işlem kanıtıdır. Permission değildir.
- **Audit:** Kararın veya mutasyonun kanıtıdır. Yetki kaynağı değildir ve geçmiş audit kaydı yeni işlem için authorization sağlamaz.

## B. Owner contract

Kesin cevaplar:

1. OWNER tüm normal operational permissions'ı implicit olarak alır mı? **YES.**
2. OWNER'ın normal permission'ları MembershipPermission tablosunda tek tek saklanmalı mı? **NO.**
3. OWNER'ın implicit normal permission'ı explicit deny ile geri alınabilir mi? **NO.** Explicit DENY modeli kullanılmayacaktır.
4. OWNER permission catalog'a gelecekte eklenen yeni normal permission'ı otomatik alır mı? **YES.** Permission açıkça `NORMAL` olarak sınıflandırılmışsa OWNER otomatik kazanır.
5. OWNER permission evaluator tarafından sıradan MEMBER gibi mi değerlendirilir? **NO.** Evaluator OWNER için ayrı ve açık bir branch kullanır.

OWNER'ın kesin davranışı:

- OWNER tüm NORMAL permission'lar için implicit `AGENCY` scope alır.
- OWNER başka Agency'ye erişemez.
- OWNER yalnız `ACTIVE` membership ve aktif User ile yetkilendirilebilir.
- OWNER tüm SENSITIVE permission'lar için explicit `MembershipPermission` grant'ine ihtiyaç duyar.
- OWNER high-risk işlemlerde recent own-password assurance ve `SensitiveActionGrant` gereksinimini aşamaz.
- OWNER last-owner invariant'ını aşamaz.
- OWNER bozuk veya bilinmeyen action'ı çalıştıramaz.
- OWNER karantina, retention, legal hold, optimistic version veya domain invariant'larını aşamaz.
- OWNER'ın CRM yetkisi Cloudflare, D1, R2 veya production altyapı yönetim yetkisi oluşturmaz.

Owner-only capability'ler:

- OWNER ekleme veya promotion
- OWNER demotion
- OWNER transfer
- Membership oluşturma/davet etme
- Membership suspend/inactivate/reactivate
- MembershipPermission grant/revoke
- Sensitive permission grant/revoke
- Authorization davranışını etkileyen yönetim değişiklikleri
- Nihai planda owner-only olarak sınıflandırılan production import, fiziksel silme ve güvenlik işlemleri

Bunlar permission catalog checkbox'ları değildir. Normal MEMBER'a grant edilemez.

OWNER'a geçiş ve OWNER'dan çıkış:

- MEMBER → OWNER promotion payload'ı nihai sensitive grant setini açıkça taşımalıdır; boş set de açıkça belirtilmelidir.
- Promotion sırasında eski normal member grant'leri owner yetkisi olarak korunmaz; OWNER'ın normal hakları implicit kaynaktan gelir.
- OWNER → MEMBER demotion payload'ı yeni MEMBER'ın bütün pozitif normal ve sensitive grant setini açıkça taşımalıdır.
- Demotion eski owner davranışından tahmin edilen veya gizlice devralınan permission üretmez.
- Promotion/demotion, permission replacement, version artışı ve audit tek atomik işlemde yapılır.

Bu model owner yönetimini basit tutarken hassas veri erişimini least-privilege altında bırakır. Owner'ın normal izinlerini satır satır saklamak drift, eksik grant, katalog migration'ı ve "owner gerçekten owner mı?" belirsizliği üretirdi. Explicit deny eklemek ise grant + deny + owner override zinciri kurarak V1'i gereksiz bir RBAC sistemine dönüştürürdü.

## C. MembershipPermission contract

`MembershipPermission` yalnız pozitif, kullanıcıya özel GRANT'tir.

Değildir:

- DENY kaydı değildir.
- Owner override değildir.
- Runtime role sonucu değildir.
- Template ile kalıcı bağlantı değildir.
- Policy expression değildir.
- Grup mirası değildir.

Kesin veri semantiği:

- Unscoped permission:
  - Satır varsa `GRANTED`.
  - Satır yoksa DENY.
- Scoped permission:
  - Satır varsa scope yalnız `ASSIGNED` veya `AGENCY`.
  - Satır yoksa DENY.
  - `NONE`, UI/input gösterimidir; kalıcı grant satırı değildir.
- Revoke, ilgili grant satırının atomik olarak kaldırılmasıdır.
- Default DENY'dır.
- Explicit DENY yoktur.
- Template, onboarding sırasında pozitif grant satırlarını bir defa kopyalar. Sonraki template değişiklikleri mevcut membership'i değiştirmez.

Normal MEMBER için:

- İstenen permission'a ait pozitif satır yoksa DENY.
- Permission satırı olsa bile scope, sensitive gate, membership durumu ve agency sınırı ayrıca geçmelidir.

OWNER için:

- NORMAL MembershipPermission satırı oluşturulması reddedilir.
- Veri bozukluğu nedeniyle böyle bir satır bulunursa evaluator bunu yok sayar.
- Yalnız SENSITIVE MembershipPermission satırları owner üzerinde anlamlıdır.

## D. Sensitive permission contract

Seçilen yaklaşım **MODEL B**'dir.

OWNER normal operational permission'ları implicit alır; sensitive permission'lar explicit grant gerektirir.

Kesin kurallar:

- `sensitive.identity.*`, `sensitive.health.*` ve gelecekteki tüm hassas veri sınıfları `SENSITIVE` olarak sınıflandırılır.
- OWNER bunları otomatik kazanmaz.
- Normal MEMBER bunları template veya normal kayıt permission'ından otomatik kazanmaz.
- Sensitive permission pozitif MembershipPermission satırıyla açıkça verilir.
- Sensitive permission normal resource permission'ın yerine geçmez; ona eklenir.
- Sensitive grant kendi başına kayıt kapsamı oluşturmaz.
- Kayıt için temel normal permission ve scope da geçmelidir.
- `sensitive.*.write`, karşılık gelen `sensitive.*.read` grant'ini ve ilgili normal write/read permission'larını gerektirir.
- Bu bağımlılıklar hem permission mutation sırasında hem runtime evaluator'da denetlenir.
- Genel `document.read`, `report.management`, `export.portfolio` veya OWNER olmak sensitive kapıyı açmaz.
- Sensitive alanlar exportta ancak temel kayıt okuma izni, uygun scope, ilgili sensitive read izni, explicit sütun seçimi ve gerekliyse SensitiveActionGrant birlikte varsa çıkarılabilir.
- Sensitive permission lookup hatası DENY'dır.
- Yeni bir SENSITIVE permission hiçbir mevcut kullanıcıya, OWNER dahil, otomatik verilmez.

Bu seçim owner hesabının ele geçirilmesinin etkisini azaltır, sağlık ve kimlik verisi erişimini ayrı audit edilebilir hale getirir, küçük acentede owner'ın normal operasyonu yönetmesine engel olmaz ve hassas veriye gerçekten ihtiyaç duyan kişilerin açıkça seçilmesini sağlar.

## E. SensitiveActionGrant contract

Minimal `SensitiveActionGrant` çekirdeği Phase 1'de zorunludur.

Kesin zamanlama:

- En geç M1-T09'da tamamlanmalıdır.
- M1-T09 tamamlanmadan aşağıdaki mutasyon endpoint'leri kullanıma açılamaz.
- M1-T03–T07 sırasında bu endpoint'ler hazırlanırsa disabled/fail-closed kalmalıdır.
- Secure grant çekirdeği Phase 5'e bırakılamaz.

Phase 1'de grant gerektiren minimum işlemler:

- Membership create/invite
- Membership suspend
- Membership inactivate/deactivate
- Membership reactivate
- OWNER promotion/addition
- OWNER demotion/removal
- Ownership transfer
- Normal permission grant/revoke
- Permission scope değişikliği
- Sensitive permission grant/revoke
- Authorization davranışını etkileyen agency/security ayarı değişikliği

Permission kataloğu runtime'da kullanıcı tarafından değiştirilemez. Catalog code değişikliği deployment ve code-review konusudur; CRM içi authorization işlemi değildir.

Grant özellikleri:

- Canlı NORMAL opaque session + son5dakika own-password reauth ile üretilir; Access token/audience değildir.
- Session/assurance süresi grant TTL'i değildir.
- Grant TTL en fazla 3 dakikadır.
- Tek kullanımlıdır.
- Actor user ID, actor membership ID, agency ID, action code, canonical payload hash, hedef entity ID veya ID'leri, hedef expected version, actor permission_version, issued_at ve expires_at alanlarına bağlıdır.
- Başka kullanıcı, Agency, action, payload veya hedef version için kullanılamaz.
- Grant permission sağlamaz; yalnız step-up/re-authentication kanıtıdır.
- İşlem anında membership, owner capability, permission, scope, hedef version ve invariant'lar tekrar değerlendirilir.
- Kullanılmış, expired, revoked veya eşleşmeyen grant DENY'dır.
- Grant'in tüketilmesi, domain mutasyonu ve başarı audit'i aynı atomik işlemde gerçekleşir.
- İki eşzamanlı kullanımda en fazla biri başarılı olabilir.
- V1'de ikinci onaylayan/four-eyes mekanizması yoktur.

Sonraki fazlarda aynı çekirdeğe eklenecek işlemler:

- Phase 2: identity variant gibi gerekçeli hassas düzeltmeler
- Phase 3: split/merge, WON correction ve benzer atomik kritik komutlar
- Phase 4: hassas belge indirme ve sınıflandırma düzeltmeleri
- Phase 5: export oluşturma/indirme, toplu değişiklik ve genişletilmiş permission UX
- Phase 6: production import commit/reversal
- Sonraki kapsam: retention, physical erasure ve güvenlik politikası değişiklikleri

## F. Last-owner ve owner-transfer invariants

Etkin aktif OWNER tanımı:

- `AgencyMembership.type = OWNER`
- `AgencyMembership.status = ACTIVE`
- Bağlı User aktif
- AuthIdentity bağlı ve geçerli
- F-27: acentede yerel credential provision edildikten sonra yalnız matching ACTIVE local issuer/OWNER_PROVISIONED identity + ACTIVE User + enabled LocalCredential + ACTIVE OWNER membership etkin owner sayılır; legacy-only identity/owner sayılmaz. Temporary forced-change teknik recovery durumudur, normal CRM session yetkisi değildir.
- Aynı Agency'ye ait

Şunlar aktif OWNER sayılmaz:

- INVITED
- SUSPENDED
- INACTIVE
- Süresi geçmiş davet
- Inactive User'a bağlı membership
- Kimliği henüz bağlanmamış davet
- Başka Agency'nin OWNER'ı

Temel invariant:

- `Agency.status = ACTIVE` olan bir Agency commit edilmiş hiçbir durumda sıfır etkin aktif OWNER'a sahip olamaz.
- Tek istisna `PROVISIONING` Agency'dir. İlk owner aktive edilmeden Agency ACTIVE olamaz.

Senaryolar:

- Son OWNER kendini deactivate ediyor: DENY.
- Son OWNER membership'ini siliyor: V1'de membership hard-delete zaten yasaktır. DENY.
- Son OWNER rolünü MEMBER'a düşürüyor: DENY.
- Başka owner son OWNER'ı düşürüyor: DENY.
- Batch operation bütün OWNER'ları düşürüyor: Bütün batch rollback edilir. DENY.
- Disabled veya suspended OWNER aktif owner sayılmaz.
- Pending/INVITED OWNER aktif owner sayılmaz.
- User seviyesinde son owner hesabını inactivate etmek: DENY.
- Owner'ın AuthIdentity bağını kaldırarak son owner'ı etkisiz bırakmak normal uygulama işlemi değildir; recovery prosedürü dışında DENY ve aynı invariant'a tabidir.

Atomic koruma:

- Owner sayısını azaltabilecek bütün yollar tek domain command ailesinden geçer.
- Application-level "önce count et, sonra update et" yeterli değildir.
- Membership type/status, User status ve identity bağlantısını etkileyen işlemler aynı DB invariant'ını tetikler.
- Mutation `expected_version`/CAS kullanır.
- D1 transaction/batch içinde mutasyon, son durum assertion'ı ve audit birlikte commit edilir.
- Sonuçtaki etkin owner sayısı en az bir değilse DB işlemi hata vererek tamamını rollback eder.
- DB seviyesinde owner azaltan update/delete işlemlerini durduran aborting guard/trigger zorunludur.
- Additive0020 bu yerel owner invariant'ını credential disable/delete, identity revoke/binding değişikliği, User inactive, membership type/status ve Agency activation kardeş yollarında korur. Credential'a bağlı identity id/user/issuer/subject/email/provenance değişmez; historical membership reparent/hard-delete yasağı korunur. Transferde önce geçerli local hedef OWNER yapılır. Reset/forced-change owner sayısını düşürmez.
- Eşzamanlı işlemlerden hiçbiri stale count'a güvenemez.
- Direct membership hard-delete normal repository yüzeyinde sunulmaz.

Owner transfer:

- `old owner remove` ve `new owner add` iki bağımsız işlem değildir.
- Özel `transferOwnership` atomik komutu kullanılır.
- Hedef önceden ACTIVE MEMBER ve aktif User olmalıdır.
- INVITED veya SUSPENDED hedefe ownership transfer yapılamaz.
- Komut aynı transaction içinde şu sırayı izler:
  1. Actor ve grant tekrar doğrulanır.
  2. Hedef membership/version doğrulanır.
  3. Hedef OWNER yapılır.
  4. Yeni owner'ın explicit sensitive grant seti uygulanır.
  5. Eski owner payload'a göre MEMBER veya INACTIVE yapılır.
  6. Eski owner MEMBER olacaksa nihai permission seti açıkça uygulanır.
  7. Final active-owner invariant'ı doğrulanır.
  8. Tek transfer audit olayı ve bağlı alt değişiklikler yazılır.
- Ara durum dışarıdan görünmez.
- Transferin yarısı commit edilemez.

Co-owner ekleme transfer değildir. Ayrı owner promotion işlemidir ve aynı secure grant kurallarına tabidir.

## G. Membership status contract

Minimum status seti:

- INVITED
- ACTIVE
- SUSPENDED
- INACTIVE

Anlamları:

- **INVITED:** Önceden yetkilendirilmiş fakat kimliği henüz bağlanmamış veya onboarding'i tamamlanmamış membership. Authorization sonucu daima DENY.
- **ACTIVE:** Evaluator'a girebilen tek durum.
- **SUSPENDED:** Geçici ve geri alınabilir erişim durdurma. Authorization sonucu daima DENY.
- **INACTIVE:** Offboarding/deactivation sonucu kalıcı operasyonel kapatma. Kayıt ve audit korunur. Authorization sonucu daima DENY.

`DISABLED` ayrı status olmayacaktır. Bu iş kavramı `INACTIVE` ile temsil edilir.

Davet süresinin dolması:

- Ayrı `EXPIRED` status gerektirmez.
- Membership INVITED kalır.
- `invitation_expires_at` geçmişse aktivasyon DENY olur.
- Yetkili secure işlemle davet yenilenebilir.

Ek kurallar:

- User inactive ise membership ACTIVE görünse bile DENY.
- Agency PROVISIONING ise yalnız bootstrap/activation yolu çalışabilir.
- Agency ACTIVE değilse normal CRM authorization DENY.
- Status değişikliği permission grant'lerini otomatik silmez; ancak SUSPENDED/INACTIVE durumda hiçbir grant kullanılamaz.
- Reactivation mevcut grant setini görünür özet ve secure onay olmadan yeniden etkinleştiremez.
- Permission ve status değişiklikleri `permission_version` veya authorization sürümünü artırır.

## H. Record-scope contract

Permission ve record scope iki ayrı zorunlu kapıdır.

Kesin sonuç:

- Permission var fakat record scope dışındaysa DENY.
- Scope var fakat permission yoksa DENY.
- Sensitive permission var fakat normal record permission/scope yoksa DENY.
- Kayıt başka Agency'ye aitse tüm permission ve owner durumlarından bağımsız DENY.

Normal MEMBER:

- Scoped permission `ASSIGNED` ise ilgili hardcoded scope resolver kaydın kullanıcıya atanmış olduğunu kanıtlamalıdır.
- Scoped permission `AGENCY` ise yalnız aynı Agency içindeki kayıtlar erişilebilir.
- Unscoped create/manage permission'ları dahi ilişkili parent ve dependency kontrollerini aşamaz.
- Birden fazla required permission varsa bütün permission'lar geçmeli; scope sonucu bunların kesişimidir.

OWNER:

- NORMAL operational permission'larda implicit `AGENCY` scope alır.
- Owner record scope açısından aynı Agency'nin tüm iş kayıtlarına erişebilir.
- Başka Agency'ye erişemez.
- Sensitive alanlar bu agency-wide normal scope'un istisnasıdır; explicit sensitive permission olmadan alanlar maskelenir veya işlem DENY edilir.
- Owner'ın agency-wide scope'u karantina, legal hold, retention veya domain invariant'ını aşmaz.

Resource bağlantıları:

- Quote, Interaction, Document ve Task hem kendi permission'larını hem bağlı parent kaydın erişimini gerektirir.
- Alt işe erişim aynı müşterinin bütün portföyünü açmaz.
- Scope resolver yalnız server-side agency, assignment ve ilişki verilerini kullanır.
- Client tarafından gönderilen `agency_id`, assignee, role veya owner iddiası dikkate alınmaz.
- Scope resolver hatası, timeout'u, eksik parent veya tutarsız ilişki DENY üretir.

## I. Authorization evaluation algorithm

`authorize(context, action, resource, intent)` için tek algoritma:

1. **Action çözümleme**
   - Action code canonical ve exact-match olmalıdır.
   - Immutable action/permission registry'de bulunmalıdır.
   - Unknown, malformed veya metadata'sı eksik action → DENY.

2. **Authentication**
   - Strict known-session hash lookup; opaque cookie, expiry/idle/revoke, credential-version, live identity/User/Agency/membership/permission-version doğrulanır.
   - Restricted ACTIVATION domain authorization'a giremez; secure descriptor canlı recent-password assurance ister. Access/Bearer alone DENY.
   - Doğrulama hatası → DENY.

3. **Identity**
   - `(issuer, subject)` ile tek AuthIdentity bulunur.
   - Email veya client claim'iyle membership üretilmez.
   - Identity/User bulunamaz veya User inactive → DENY.

4. **Agency**
   - Agency server-side route/resource bağlamından çıkarılır.
   - Agency bulunamaz, PROVISIONING/ACTIVE kuralına uymuyor veya resource agency uyuşmuyor → DENY.
   - Client'ın agency iddiası authorization sağlamaz.

5. **Membership**
   - User + Agency için tek membership yüklenir.
   - Membership yok veya status ACTIVE değil → DENY.
   - Permission lookup hatası → DENY.

6. **Action authority**
   - `PROVISIONING_ONLY` action ise yalnız bootstrap path kabul edilir.
   - `OWNER_ONLY` action ise membership type OWNER değilse → DENY.
   - Grant edilebilir operasyon action'ında required permission listesi değerlendirilir.

7. **NORMAL permission'lar**
   - Actor OWNER ise required NORMAL permission implicit GRANTED ve scope AGENCY kabul edilir.
   - Actor MEMBER ise her required NORMAL permission için pozitif MembershipPermission bulunmalıdır.
   - Eksik permission → DENY.

8. **SENSITIVE permission'lar**
   - Her required SENSITIVE permission için OWNER veya MEMBER ayrımı olmaksızın explicit MembershipPermission bulunmalıdır.
   - Dependency'ler, örneğin write → read, ayrıca bulunmalıdır.
   - Eksik sensitive permission veya dependency → DENY.

9. **Record scope**
   - Resource ve bağlı parent kayıtları aynı Agency'de olmalıdır.
   - MEMBER için ilgili scope resolver çalıştırılır.
   - OWNER'ın implicit normal scope'u AGENCY'dir.
   - Bütün required scope sonuçları geçmelidir.
   - Scope dışı, belirsiz veya resolver hatası → DENY.

10. **Domain/system preconditions**
    - Last-owner, legal hold, quarantine, state machine, version ve benzeri bypass edilemez invariant'ların precondition'ları doğrulanır.
    - İhlal → DENY veya domain conflict; işlem çalıştırılmaz.

11. **High-risk assurance**
    - Descriptor `SECURE_GRANT` gerektiriyorsa son5dakika own-password assurance zorunludur.
    - SensitiveActionGrant actor, membership, agency, action, payload hash, target ID, target version, permission_version ve TTL ile eşleşmelidir.
    - Grant kullanılmış/expired/eşleşmiyor → DENY.

12. **Final atomic recheck**
    - Mutasyon batch'i içinde local session/kind/expiry/idle/revoke/credential-version, identity/User/Agency/membership/permissions/versions/grant/invariant tekrar okunur; KDF await öncesi preflight yeterli değildir.
    - Grant conditional olarak tüketilir.
    - Mutation conditional olarak uygulanır.
    - Post-condition'lar ve active-owner invariant'ı doğrulanır.
    - Audit yazılır.
    - Herhangi bir adım başarısızsa bütün transaction rollback → DENY/CONFLICT.

13. **Final sonuç**
    - Bütün kapılar geçtiyse ALLOW.
    - Bunun dışındaki her sonuç DENY'dır.
    - High-risk mutasyonda transaction dışında verilmiş "preflight ALLOW" nihai authorization değildir.

Pseudo-code:

```text
descriptor = registry.exact(action)
if descriptor missing or invalid:
    return DENY

identity = verifyLiveLocalSession(context.cookie, descriptor.assurance)
if identity invalid:
    return DENY

user = loadUser(identity.issuer, identity.subject)
agency = deriveTrustedAgency(context, resource)
membership = loadMembership(user, agency)

if user inactive or agency invalid or membership.status != ACTIVE:
    return DENY

if resource exists and resource.agency_id != agency.id:
    return DENY

if descriptor.authority == OWNER_ONLY and membership.type != OWNER:
    return DENY

for permission in descriptor.requiredNormalPermissions:
    if membership.type == OWNER:
        effectiveScope = AGENCY
    else:
        grant = loadPositiveGrant(membership, permission)
        if grant missing:
            return DENY
        effectiveScope = grant.scope

    if not scopeAllows(effectiveScope, user, resource):
        return DENY

for permission in descriptor.requiredSensitivePermissions:
    if not hasExplicitPositiveGrant(membership, permission):
        return DENY
    if not allDependenciesGranted(membership, permission):
        return DENY

if not domainPreconditionsAllow(intent):
    return DENY

if descriptor.assurance == SECURE_GRANT:
    grant = validateExactSensitiveActionGrant(context, intent)
    if grant invalid:
        return DENY

if descriptor is read-only and not grant-consuming:
    return ALLOW

return executeAtomically(
    reauthorize,
    consumeGrantIfRequired,
    mutateWithExpectedVersions,
    assertPostConditions,
    writeAudit
)
```

## J. Deny/grant precedence

Explicit DENY kaydı kullanılmayacaktır.

Mutlak precedence:

1. Unknown/malformed action veya eksik catalog metadata
2. Authentication/session/credential-version/recent-password hatası
3. Inactive User
4. Eksik veya ACTIVE olmayan membership
5. Agency/resource boundary uyuşmazlığı
6. Bypass edilemez system/domain invariant
7. Eksik owner-only capability
8. Eksik NORMAL permission
9. Eksik SENSITIVE permission veya dependency
10. Record scope başarısızlığı
11. Eksik/geçersiz/expired/reused SensitiveActionGrant
12. Version veya concurrency conflict
13. ALLOW

Hiçbir grant, üstteki deny koşullarını override edemez.

Özellikle:

- OWNER implicit normal grant'i inactive membership'i aşamaz.
- OWNER implicit normal grant'i sensitive eksikliğini aşamaz.
- Explicit sensitive grant record scope'u aşamaz.
- SensitiveActionGrant permission eksikliğini aşamaz.
- Audit geçmişi authorization sağlamaz.
- UI'da açık buton server deny kararını aşamaz.

## K. Permission catalog classification

Her permission açık ve zorunlu metadata ile tanımlanmalıdır. Classification için default değer yoktur.

Minimum metadata:

- `code`
- `classification`: `NORMAL | SENSITIVE`
- `scope_kind`: `UNSCOPED | RECORD_SCOPED`
- `sensitivity_domain`: identity, health veya gelecekteki açık sınıf
- `dependencies`
- `scope_resolver`
- `assurance`: `NORMAL_SESSION | SECURE_GRANT`
- Türkçe başlık ve açıklama

Owner-only ve provisioning-only action'lar grant edilebilir permission catalog'a konmaz; ayrı sabit action registry'de tutulur.

Catalog davranışı:

- Yeni NORMAL permission:
  - OWNER otomatik kazanır.
  - MEMBER otomatik kazanmaz.
  - Mevcut template veya membership satırları sessizce değişmez.
- Yeni SENSITIVE permission:
  - OWNER otomatik kazanmaz.
  - MEMBER otomatik kazanmaz.
  - Her actor için explicit grant gerekir.
- Classification eksikse build/catalog validation başarısız olmalıdır; runtime fail-closed DENY eder.
- Classification NORMAL'dan SENSITIVE'e değişirse existing implicit/normal erişim devam etmez. Explicit sensitive grant olmadan DENY olur.
- Classification SENSITIVE'ten NORMAL'a değişiklik owner'a otomatik yetki vereceği için güvenlik etkili breaking policy change sayılır ve açık migration/review gerektirir.

`policy.export.bulk` örneği:

- Hassas alanları kendiliğinden açmayan toplu operational export ise `NORMAL + SECURE_GRANT` olabilir.
- OWNER authority'yi implicit kazanır; MEMBER explicit grant ister.
- Export edilen her modül için normal read/scope ayrıca gerekir.
- Identity/health sütunları için ilgili SENSITIVE permission ayrıca gerekir.
- Permission'ın `NORMAL` olması step-up zorunluluğunu kaldırmaz.

## L. Bootstrap contract

Chicken-and-egg çözümü:

- İlk acente oluşturma OWNER bootstrap'tan ayrı controlled LOCAL-ADMIN `provisionInitialAgency` işlemidir; yeni HTTP/action permission veya authorization bypass değildir. Exact account/D1/agency/operation key, trusted terminal ve exact tuple confirmation ile yalnız boş ilk commissioning state'inde version1 PROVISIONING acente + immutable `auth.admin.provision-agency` SYSTEM audit aynı D1 CAS/batch'te yazılır. User/Membership/AuthIdentity/credential/session/parola oluşturmaz. Exact retry yalnız özgün audit/target/tuple + değişmemiş PROVISIONING/boş auth state'inde aynı sonucu verir; conflicting replay, ikinci acente veya kanıtsız mevcut state fail-closed'dur. Remote mode bu LOCAL-only dilimde desteklenmez; ayrıntı nihai plan5.3'tedir.

- İlk owner normal authorization evaluator üzerinden oluşturulmaz.
- Public bootstrap endpoint'i yoktur.
- Bootstrap yalnız kontrollü provisioning CLI/operasyon yoludur.
- İşlemi CRM kullanıcısı değil, isimlendirilmiş teknik provisioning operatörü çalıştırır.
- Operatör CRM OWNER sayılmaz.
- F-27 bootstrap: exact account/D1/agency/owner/email, trusted interactive terminal+explicit target confirmation; local config hedefleri ve remote metadata/admin MFA fail-closed doğrulanır.
- Initial yalnız PROVISIONING+sıfır membership+existing user yok; User/stable local identity/ACTIVE OWNER membership/Agency/temp credential ve system audit tek atomik batch. İlk login yalnız ACTIVATION; kalıcı replacement tamamlanmadan domain erişimi yoktur.
- Legacy bootstrap yalnız ACTIVE agency'de tek ACTIVE intended OWNER+aynı legacy email+yerel credential yokken; owner-count/lifecycle/email/agency-version KDF sonrası batch'te tekrar assert edilir. Başka owner/ambiguous setup DENY.
- Break-glass yalnız exact existing OWNER; verifier+credential-version+must-change/expiry+all-session revoke+safe audit atomik, membership/permission değişmez. HTTP yüzeyi yok; plaintext başarılı terminal'de bir kez ve hiçbir arg/file/log/receipt içinde değil.
- İlk login yapan rastgele kullanıcı owner olmaz.
- Email domain üyeliği owner veya CRM membership üretmez.
- Başarı sonrası bootstrap tekrar secret göstermez; lost response recovery yeni key ile break-glass'tır. Credential varlığı ikinci bootstrap'ı engeller.
- Süresi dolmuş temp için exact owner recovery yeni temporary üretir; eski credential/session geri gelmez.
- Bootstrap tekrar yarışı atomic CAS/unique+system-audit idempotency ile en fazla bir intended owner credential üretir.
- Production açılmadan önce ikinci aktif recovery OWNER oluşturulması zorunlu commissioning kontrolüdür.

## M. Audit contract

Başarılı authorization/membership mutasyonlarında audit, domain mutasyonuyla atomik yazılmalıdır. Audit yazılamazsa mutasyon rollback edilir.

Zorunlu event'ler:

- `membership.created`
- `membership.invited`
- `membership.activated`
- `membership.suspended`
- `membership.inactivated`
- `membership.reactivated`
- `owner.promoted`
- `owner.demoted`
- `owner.transfer`
- `permission.granted`
- `permission.scope_changed`
- `permission.revoked`
- `sensitive_permission.granted`
- `sensitive_permission.revoked`
- `sensitive_action_grant.issued`
- `sensitive_action_grant.consumed`
- `sensitive_action.denied`
- `bootstrap.owner_invited`
- `bootstrap.owner_activated`
- F-27 active auth events: `auth.login`, `auth.logout`, `auth.password.activated`, `auth.password.changed`, `auth.password.reauthenticated`, `personnel.create/reset/suspend/inactivate/reactivate/permissions/promote/demote/transfer`, `auth.admin.bootstrap/break-glass`; grant issuance ve consume aynı atomic evidence ile ilişkilidir. Tarihsel invitation olayları yeni auth onboarding'i değildir.

Minimum alanlar:

- event ID
- occurred_at UTC
- agency ID
- actor kind: USER, SYSTEM, PROVISIONING_OPERATOR
- actor user ID ve membership ID; uygulanmıyorsa null + actor kind
- action code
- outcome: SUCCESS veya DENY
- reason code
- request ID
- operation/idempotency ID
- SensitiveActionGrant ID; varsa
- target entity type ve ID
- target membership/user ID; varsa
- before version
- after version
- değişen alan adları
- permission code ve önce/sonra scope; varsa
- membership önce/sonra type/status; varsa
- actor permission_version
- gerekçe
- maskeli özet

Audit içine yazılmayacaklar:

- JWT
- TOTP/MFA secret
- Grant token material
- Tam request body
- TCKN/VKN
- Sağlık verisi
- Telefon
- Belge içeriği
- Arama sorgusu
- Secret veya credential
- Temporary/permanent plaintext, verifier/salt, session cookie/token/hash, CSRF ve reauth body. Surrogate actor/target/operation IDs ve allowlisted semantic değişiklik kanıtı kullanılır.

Ek kurallar:

- Owner promotion, demotion, transfer, deactivate ve sensitive grant/revoke için gerekçe zorunludur.
- Ownership transfer tek üst event ve aynı operation ID'ye bağlı alt değişikliklerle temsil edilir.
- Denied sensitive/high-risk girişimler security audit üretir.
- Denial audit altyapısı arızalansa dahi istek ALLOW olmaz; DENY devam eder ve logging arızası operasyon alarmına dönüşür.
- Bütün sıradan read deny'larını PII dolu audit'e çevirmek zorunlu değildir.
- Sensitive belge indirme ve export gibi başarılı disclosure işlemleri ayrıca audit edilir.

## N. Concurrency requirements

Zorunlu teknik davranış:

- Her authorization mutation `expected_version` kullanır.
- Permission değişikliği membership `permission_version` değerini artırır.
- Status/type değişikliği authorization sürümünü artırır.
- Stale version işlemi `409`/conflict ile tamamen reddedilir.
- Owner azaltan işlem application count sonucuna güvenmez.
- DB-level aborting guard final active-owner sayısını korur.
- Mutation, grant consumption, post-condition ve audit tek D1 transaction/batch içinde commit edilir.
- Sıfır satır etkileyen conditional update başarı sayılamaz.
- Bir statement başarısızsa bütün batch rollback edilir.
- Grant conditional consume işlemi `used_at IS NULL` ve expiry/version koşullarıyla yapılır.
- Permission lookup veya scope sorgusu hata verirse fail-closed olur.
- Background job yüksek riskli işlemi devralıyorsa başlangıç grant'i iş kapsamına bağlanır; job çalışırken actor aktifliği ve güncel permission tekrar doğrulanır.

M1-T03/M1-T04 için zorunlu gerçek D1 concurrency testleri:

1. Son owner self-demotion yarışı
2. Son owner suspension/inactivation
3. Son owner User inactivation
4. İki owner'ın eşzamanlı olarak birbirini demote etmesi
5. İki owner'ın tek batch içinde birlikte düşürülmesi
6. Transfer ile eski owner suspension yarışması
7. Promotion ile hedef membership deactivation yarışması
8. Aynı SensitiveActionGrant'in iki eşzamanlı kullanımı
9. Permission grant ile membership suspension yarışması
10. Permission revoke ile API request authorization yarışması
11. Stale target version ile owner transfer
12. İki eşzamanlı bootstrap çalıştırması
13. Agency activation sırasında ilk owner identity binding yarışı
14. Audit insert hatasında owner/membership mutation rollback
15. Post-condition hatasında bütün owner transferinin rollback'i

Kabul sonucu:

- Final ACTIVE Agency hiçbir testte sıfır etkin owner'a düşmez.
- Aynı grant ile en fazla bir mutation commit edilir.
- Permission düşüşünden sonra başlayan yeni istek eski permission_version ile başarılı olamaz.
- Mock/in-memory test tek başına yeterli değildir; gerçek D1 davranışı doğrulanmalıdır.

## O. Misuse-case matrix

1. **Normal MEMBER kendine permission vermeye çalışıyor:** DENY. Permission yönetimi owner-only capability'dir ve secure grant gerektirir. Normal permission grant'i bu capability'yi oluşturamaz.
2. **Geniş normal izinlere sahip "admin" kendini OWNER yapmaya çalışıyor:** DENY. "Admin" runtime rolü yoktur. Owner promotion yalnız mevcut aktif OWNER tarafından secure grant ile yapılabilir.
3. **OWNER son etkin OWNER'ı kaldırıyor:** DENY. Last-owner invariant permission ve grant'ten üstündür.
4. **İki eşzamanlı request son iki OWNER'ı ayrı ayrı düşürüyor:** Sıfır-owner sonucu DENY. En fazla bir işlem commit edebilir; diğeri version/DB invariant conflict ile rollback edilir. Finalde en az bir etkin OWNER kalır.
5. **OWNER sensitive.identity izni olmadan tam kimlik verisi istiyor:** DENY. OWNER normal record erişimini implicit alır fakat sensitive.identity explicit grant ister.
6. **Normal permission'a sahip MEMBER scope dışındaki kaydı istiyor:** DENY. Permission ve scope birlikte geçmelidir.
7. **SUSPENDED OWNER API çağrısı yapıyor:** DENY. OWNER branch'ine yalnız ACTIVE membership girebilir.
8. **Catalog'a yeni SENSITIVE permission eklendi:** Explicit grant verilene kadar herkes için DENY; OWNER dahil.
9. **Authorization lookup hata veriyor:** DENY. Cache, DB, dependency veya scope resolver hatası erişim açamaz.
10. **Malformed veya unknown permission/action gönderiliyor:** DENY. Action registry exact-match kullanır; normalize edilerek başka permission'a çevrilmez.

Kompakt karar matrisi:

| Actor | Normal action | Sensitive data action | High-risk administrative action |
|---|---|---|---|
| OWNER | Implicit NORMAL grant + AGENCY scope; diğer bütün kapılar zorunlu | Implicit temel NORMAL + explicit SENSITIVE grant + Agency scope; gerekiyorsa SensitiveActionGrant | Owner-only capability + recent own-password assurance + exact SensitiveActionGrant + invariant/post-condition |
| Normal MEMBER | Explicit positive MembershipPermission + record scope | Explicit normal grant + explicit sensitive grant + record scope; gerekiyorsa SensitiveActionGrant | DENY; owner-only capability permission olarak verilemez |
| SUSPENDED member/OWNER | DENY | DENY | DENY |

## P. M1 implementation consequences

### M1-T03 — Identity / Agency schema

Şimdiden gerekli alanlar ve invariant'lar:

Agency:

- `id`
- `status`: `PROVISIONING | ACTIVE`
- `bootstrap_completed_at`
- `activated_at`
- `version`
- created/updated timestamps

User:

- `id`
- aktif/inactive lifecycle alanı
- `version`
- created/updated timestamps

AuthIdentity:

- `id`
- `user_id`
- `issuer`
- `subject`
- `(issuer, subject)` unique
- verified email display/eşleme alanı
- `bound_at`
- aktif/revoked durumu veya eşdeğer lifecycle bilgisi

AgencyMembership:

- `id`
- `agency_id`
- `user_id`
- `(agency_id, user_id)` unique
- `type`: `OWNER | MEMBER`
- `status`: `INVITED | ACTIVE | SUSPENDED | INACTIVE`
- `permission_version`
- genel `version`
- invitation email/expiry/renewal bilgileri
- activated/suspended/inactivated timestamps
- status/type değişiklik gerekçesine bağlanabilir operation bilgisi
- created/updated timestamps

DB desteği:

- Active owner sorgusunu destekleyen agency/type/status indexi
- Owner azaltan update/delete yollarını koruyan DB-level guard
- Membership hard-delete'in normal servis yolunda bulunmaması
- Agency ACTIVE geçişinde en az bir etkin owner assertion'ı
- User inactivation ve identity unlink işlemlerinin last-owner invariant'ına dahil edilmesi

M1-T03'te yapılmaması gerekenler:

- Owner'ı generic role tablosu yapmak
- Role hierarchy
- User üzerinde agency role taşımak
- Email'i identity primary key veya authority yapmak
- MEMBER/OWNER bilgisini JWT claim'inden kabul etmek

### M1-T04 — Permission catalog

- Katalog kodda sabit olmalıdır.
- Her permission için zorunlu `NORMAL | SENSITIVE` classification eklenmelidir.
- Classification default edilmemelidir.
- Scope kind ve resolver açık olmalıdır.
- Assurance metadata eklenmelidir.
- Dependency listesi bulunmalıdır.
- MembershipPermission yalnız pozitif grant saklamalıdır.
- Scoped grant yalnız ASSIGNED veya AGENCY olmalıdır.
- Row absence DENY'dır.
- DENY kolonuna veya deny satırına ihtiyaç yoktur.
- Owner normal permission satırı üretimi reddedilmelidir.
- Templates yalnız MEMBER grant snapshot'ı üretmelidir.
- Sensitive template grant'leri varsayılan kapalı olmalıdır.
- Catalog validation build/test kapısı olmalıdır.
- Yeni sensitive permission'ın owner'a otomatik verilmediği test edilmelidir.

### M1-T05 — Access JWT verifier

Bu başlık tarihsel checkpoint adıdır, F-27 ile SUPERSEDED. Active verifier strict opaque cookie/hash lookup+live session/credential/identity/agency/membership'tir. Normal vs secure sonuç recent own-password assurance'dan gelir. Header/email/role/agency iddiası yetki vermez. Historical Access isolated unit testleri runtime import grafiğine giremez.

### M1-T06 — Active membership + /api/me

- `/api/me` yalnız aktif User + ACTIVE membership ile başarılı olmalıdır.
- INVITED, SUSPENDED ve INACTIVE DENY olmalıdır.
- V1 Agency membership'i server-side çözülmelidir; client tenant seçimi authority değildir.
- Response membership type ve `permission_version` içerebilir.
- OWNER için effective NORMAL permission'lar katalogdan hesaplanmalıdır; DB'de owner grant satırı aranmaz.
- Sensitive izinler yalnız explicit grant olarak gösterilmelidir.
- `/api/me` çıktısı UI kolaylığıdır; sonraki API isteklerinde server re-evaluation yerine geçmez.
- First-owner local stable identity yalnız exact controlled bootstrap üzerinden kurulmalıdır; public login binding/provisioning yapmaz.
- Agency/owner/temp credential bootstrap atomiktir; ACTIVATION password replacement ayrı atomik restricted→NEW normal session geçişidir.

### M1-T07 — Authorization evaluator

Evaluator doğrudan bu sözleşmenin I bölümünü uygulamalıdır.

Zorunlu test sınıfları:

- MEMBER grant missing
- MEMBER ASSIGNED scope pass/fail
- MEMBER AGENCY scope
- OWNER implicit NORMAL
- OWNER explicit SENSITIVE mevcut/yok
- Owner normal grant satırı veri bozukluğu halinde yok sayma
- Cross-agency denial
- Inactive User
- INVITED/SUSPENDED/INACTIVE membership
- Unknown action
- Catalog metadata eksikliği
- Scope resolver hatası
- Sensitive write dependency eksikliği
- Owner-only action'ın MEMBER tarafından çağrılması
- Permission lookup failure
- Client-supplied agency/role/assignee iddialarının yok sayılması

Evaluator sonucu basit boolean'ın yanında internal reason code taşıyabilir; reason istemciye kayıt varlığını sızdıracak şekilde verilmemelidir.

### M1-T09 — Audit / idempotency / minimal secure action grant

M1-T09 Phase 1 için blocker güvenlik bağımlılığıdır.

Gerekli `SensitiveActionGrant` bilgileri:

- grant ID
- actor user/membership
- agency
- action code
- payload hash
- target identity/version
- actor permission_version
- issued/expires timestamps
- consumed timestamp veya state
- issuing live local session/recent-password assurance evidence
- request/operation ID

Gerekli davranış:

- 3 dakika TTL
- single-use conditional consume
- permission ve status recheck
- exact payload/target binding
- mutation + consume + audit atomikliği
- replay/concurrency testi
- stale version rejection
- denied sensitive/high-risk attempt audit'i

M1-T09 tamamlanmadan membership mutation, permission mutation, owner mutation ve sensitive permission mutation production veya staging kullanıcı yüzeyinde etkinleştirilemez.

## Q. Adversarial self-review

### BLOCKER

- Yok.

### IMPORTANT

- Owner normal permission'larının implicit olması, nihai plandaki "MembershipPermission tek runtime otoritesidir" ifadesini şu kesin anlamla sınırlar: MembershipPermission explicit kullanıcı grant'lerinin otoritesidir; OWNER normal yetkisinin otoritesi korunan membership type + catalog classification'dır.
- Catalog classification güvenlik sınırıdır. Yeni sensitive yetkinin yanlışlıkla NORMAL işaretlenmesi OWNER'a otomatik erişim verir. Bu nedenle classification zorunlu, defaultsuz ve security review/test kapılıdır.
- Tek aktif owner teknik invariant'ı hesap/posta/MFA kaybından doğan operasyonel lockout'u tek başına çözmez. Production açılmadan ikinci aktif recovery OWNER ve MFA-korumalı administrative CLI break-glass prosedürü doğrulanmalıdır.
- Last-owner koruması yalnız membership mutation'a değil User inactivation ve AuthIdentity unlink/revoke yollarına da uygulanmalıdır.
- Minimal SensitiveActionGrant Phase 5'e ertelenemez. M1-T09 tamamlanana kadar personel/permission/owner mutation yüzeylerinin kapalı kalması zorunludur.
- Denied-attempt audit altyapısı arızalansa bile authorization fail-closed kalmalıdır; logging başarısızlığı erişim açma gerekçesi olamaz.
- Owner demotion sırasında eski implicit normal yetkilerden permission seti türetilmemelidir. Nihai MEMBER grant seti payload'da açıkça verilmelidir.
- Bootstrap için PROVISIONING Agency durumu zorunludur; aksi halde "ACTIVE Agency sıfır owner olamaz" invariant'ı ile ilk owner daveti arasında çözülemez döngü oluşur.

### OPTIONAL

- V1'de role hierarchy, policy DSL, generic ABAC, explicit deny, grup mirası ve second-approver workflow eklenmemelidir.
- Four-eyes approval gelecekte yüksek hacimli veya mevzuatça gerekli işlemler için ayrı mimari değişiklik olarak değerlendirilebilir; RG-00 veya V1 gereksinimi değildir.

## R. RG-00 final verdict

**PASS**
