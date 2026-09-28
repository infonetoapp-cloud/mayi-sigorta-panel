import {
  getPermissionDefinition,
  PERMISSION_CATALOG,
  STABLE_SCOPE_RESOLVERS,
  type PermissionDefinition,
  type StableScopeResolver,
} from '../../shared/permissions';
import type { AuthenticatedUserContext, ActiveMembershipContext } from './identity';
import { canonicalizePayload } from '../mutations/canonical';
import { canonicalizeTargetIds, computeEvidenceHash } from '../mutations/grants';

/**
 * Mayı Sigorta CRM — Merkezi Yetkilendirme Değerlendiricisi (M1-T07)
 *
 * KRİTİK GÜVENLİK VE MİMARİ KURALLAR (RG-00 & NIHAI_MIMARI_VE_UYGULAMA_PLANI):
 * 1. Tek ve merkezi yetkilendirme otoritesidir; mantık route'lara dağıtılamaz.
 * 2. Fail-Closed prensibi: Bilinmeyen eylem, eksik yetki, bozuk veri veya altyapı
 *    hatalarının tamamı derhal DENY üretir.
 * 3. Değişmez Eylem Kayıt Sınırı (Action Registry - BLOCKER-1):
 *    - İstemci yalnızca eylem kodu (action) iletir; yetki listelerini belirleyemez veya ezemez.
 *    - Eylemler değişmez ActionDefinition yapılarıyla kayıt altına alınır:
 *      eylem yetki düzeyi (authority), gerekli NORMAL izinler, gerekli SENSITIVE izinler ve güvence düzeyi.
 *    - Varsayılan eylem kütüğü (DEFAULT_ACTION_REGISTRY) yalnızca katalogdaki NORMAL izinleri
 *      güvenli şekilde birebir eylemlere haritalar (authority: MEMBERSHIP_AUTHORIZED).
 *    - Bağımsız SENSITIVE izin kodları varsayılan kütükte doğrudan yetki veren eylem olarak bulunmaz
 *      (UNKNOWN_ACTION üretir). Hassas eylemler ancak sunucu yapım zamanında bileşik (compound)
 *      eylemler olarak tanımlanır.
 *    - Tek başına hassas izin kaydı asla kayıt erişim yetkisi yaratamaz.
 * 4. Eylem Yetki Modeli (Action Authority - RG-00 I & L):
 *    - Eylemlerin yetki düzeyi (MEMBERSHIP_AUTHORIZED, OWNER_ONLY, PROVISIONING_ONLY) açık kanonik
 *      meta veri olarak doğrulanır ve zorunlu kılınır.
 *    - OWNER_ONLY eylemleri canlı veritabanında doğrulanmış ACTIVE OWNER gerektirir; MEMBER çağıramaz (OWNER_REQUIRED).
 *    - PROVISIONING_ONLY eylemleri normal çalışma zamanı değerlendiricisinde daima reddedilir (PROVISIONING_NOT_ALLOWED).
 *    - Bütün ActionDefinition'lar en az bir NORMAL operasyonel izne bağlı olmalıdır; yapay sahip izinleri icat edilemez.
 * 5. Bağlam ve Kaynak Bağımsız Anlık Görüntüsü (Detached Deeply-Immutable Snapshots):
 *    - validateAuthenticatedUserContext tüm üst ve alt yetki alanlarını tam olarak BİR KEZ yakalar,
 *      ilkel değerleri bağımsız dondurulmuş nesnelere kopyalar ve yalnızca bu görüntüyü döndürür.
 *      Doğrulama sonrasında veya async işlemler boyunca arayan nesneleri asla tutulmaz ya da tekrar okunmaz.
 *    - Kaynak meta verisi ve içeriği ilk await öncesinde özyinelemeli olarak bağımsız, derinlemesine dondurulmuş
 *      bir anlık görüntüye (resourceSnapshot) dönüştürülür. resourceEnvelope.raw tamamen kaldırılmıştır.
 *      Çözümleyicilere yalnızca bu güvenilir anlık görüntü iletilir.
 * 6. Kapsam Kesişimi ve Kayıt Kapsamı Yükümlülüğü (IMPORTANT-1):
 *    - Kapsamsız (UNSCOPED) bir eylem, kayıt kapsamlı (RECORD_SCOPED) bir izne bağımlıysa,
 *      kayıt kapsamı yükümlülüğü (ASSIGNED veya AGENCY) ortadan kalkmaz.
 *    - Nihai karar kapsamı, tüm gerekli izin ve bağımlılıkların en dar kesişimidir
 *      (ASSIGNED < AGENCY < UNSCOPED).
 *    - Kayıt kapsamı yükümlülüğü taşıyan her eylem için geçerli kaynak (resource) zorunludur
 *      ve tüm ilgili çözümleyiciler başarıyla doğrulanmalıdır.
 * 7. Acente Üyeliği Belirsizlik Koruması (IMPORTANT-2):
 *    - Kimlik bağlamında (context) aynı acente için birden fazla veya çakışan (OWNER+MEMBER)
 *      üyelik bulunması kesinlikle yasaktır (INVALID_CONTEXT).
 *    - Hedef acente üyeliği seçimi .find() ile ilk eşleşmeyi alamaz; tam olarak tekil (length === 1)
 *      olması zorunludur.
 * 8. OWNER ve SENSITIVE Bütünlük Sözleşmesi (RG-00 C & D):
 *    - OWNER, acente içi tüm NORMAL izinleri örtük (implicit) olarak alır.
 *    - Veritabanındaki NORMAL satırları (bozuk olanlar dahil) OWNER için tamamen yok sayılır.
 *    - OWNER, SENSITIVE izinleri ASLA örtük alamaz; açık veritabanı kaydı zorunludur.
 *    - Hassas değerlendirme sırasında OWNER'ın tüm açık SENSITIVE izinleri ve bağımlılık kapanımı
 *      yapısal olarak doğrulanır: katalog varlığı, saklanan kapsam, SENSITIVE bağımlılıkların mevcudiyeti.
 *      Bilinmeyen açık satırlar fail-closed ret üretir (UNKNOWN_PERMISSION).
 * 9. MEMBER Sözleşmesi:
 *    - MEMBER, tüm gerekli izinler (normal ve hassas) için veritabanında saklanan açık (explicit)
 *      ve pozitif bir MembershipPermission kaydına sahip olmalıdır.
 * 10. Canlı Yaşam Döngüsü ve İlişki Doğrulaması (I-01 & I-05):
 *    - Canlı AuthIdentity, User, AgencyMembership ve Agency varlığı, ilişki ID eşleşmeleri
 *      (identity_id, user_id, membership_id, agency_id), aktif durumları ve permission_version
 *      veritabanından kesin olarak doğrulanır.
 * 11. Karar Mesajı Güvenliği (I-06):
 *    - Yetkilendirme kararı mesajları her neden kategorisi için sabit ve jenerik metinlerdir;
 *      saldırgan kontrollü hiçbir dinamik değer veya depolama ayrıntısı dışarı sızdırılmaz.
 * 12. Yüksek Risk Güvence Kapısı:
 *    - SECURE_GRANT gerektiren izinler T07'de daima DENY üretir (SensitiveActionGrant henüz yok).
 */

export type AuthorizationDecision = 'ALLOW' | 'DENY';

export type EffectiveScope = 'UNSCOPED' | 'ASSIGNED' | 'AGENCY';

export type ActionAuthority = 'MEMBERSHIP_AUTHORIZED' | 'OWNER_ONLY' | 'PROVISIONING_ONLY';

export type AuthorizationReasonCode =
  | 'ALLOWED'
  | 'INVALID_CONTEXT'
  | 'USER_INACTIVE'
  | 'MEMBERSHIP_NOT_FOUND'
  | 'MEMBERSHIP_INACTIVE'
  | 'AGENCY_MISMATCH'
  | 'UNKNOWN_ACTION'
  | 'UNKNOWN_PERMISSION'
  | 'MALFORMED_INPUT'
  | 'MISSING_CATALOG_METADATA'
  | 'PERMISSION_NOT_GRANTED'
  | 'OWNER_REQUIRED'
  | 'PROVISIONING_NOT_ALLOWED'
  | 'OWNER_SENSITIVE_GRANT_REQUIRED'
  | 'INVALID_STORED_GRANT'
  | 'INVALID_STORED_SCOPE'
  | 'DEPENDENCY_MISSING'
  | 'DEPENDENCY_INVALID'
  | 'DEPENDENCY_SCOPE_TOO_NARROW'
  | 'DEPENDENCY_CORRUPT'
  | 'SCOPE_RESOLVER_DENIED'
  | 'SCOPE_RESOLVER_ERROR'
  | 'UNKNOWN_SCOPE_RESOLVER'
  | 'SECURE_GRANT_REQUIRED'
  | 'DATABASE_ERROR';

export interface AuthorizationResult {
  readonly decision: AuthorizationDecision;
  readonly code: AuthorizationReasonCode;
  readonly effectiveScope?: EffectiveScope;
  readonly message: string;
}

export interface EvaluationResource {
  readonly agencyId: string;
  readonly id?: string;
  readonly [key: string]: unknown;
}

export interface SecureGrantBinding {
  readonly evidence: string;
  readonly payload: unknown;
  readonly targetIds: readonly string[];
  readonly expectedTargetVersion: number | null;
}

export interface AuthorizationRequest {
  readonly context: AuthenticatedUserContext | unknown;
  readonly action?: unknown;
  readonly permissionCode?: unknown;
  readonly agencyId?: unknown;
  readonly resource?: EvaluationResource | unknown;
  readonly secureGrantBinding?: SecureGrantBinding | unknown;
}

export interface ScopeResolutionContext {
  readonly userId: string;
  readonly membershipId: string;
  readonly agencyId: string;
  readonly effectiveScope: 'ASSIGNED' | 'AGENCY';
  readonly permissionCode: string;
  readonly resource: unknown;
}

export type ScopeResolverFunction = (context: ScopeResolutionContext) => Promise<boolean> | boolean;

export type ScopeResolverRegistry = Readonly<Record<StableScopeResolver, ScopeResolverFunction>>;

export interface ActionDefinition {
  readonly code: string;
  readonly authority: ActionAuthority;
  readonly requiredNormalPermissions: readonly string[];
  readonly requiredSensitivePermissions: readonly string[];
  readonly assurance: 'NORMAL_SESSION' | 'SECURE_GRANT';
}

export interface ActionRegistry {
  get(code: string): ActionDefinition | undefined;
  has(code: string): boolean;
  list(): readonly ActionDefinition[];
  entries(): IterableIterator<[string, ActionDefinition]>;
  [Symbol.iterator](): IterableIterator<[string, ActionDefinition]>;
}

export interface AuthorizationOptions {
  readonly resolvers?: Partial<ScopeResolverRegistry>;
  readonly actions?:
    | ActionRegistry
    | {
        get(code: string): unknown;
        has?(code: string): boolean;
        list?(): readonly ActionDefinition[];
      };
}

export interface AuthorizationEvaluator {
  authorize(request: AuthorizationRequest): Promise<AuthorizationResult>;
}

interface RawPermissionGrantRow {
  id: unknown;
  membership_id: unknown;
  permission_code: unknown;
  scope: unknown;
}

const CANONICAL_CODE_REGEX = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const MAX_ACTION_REGISTRY_ENTRIES = 1000;

function isNonArrayObject(value: unknown): value is Record<PropertyKey, unknown> {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

function hasCallablePrepare(value: unknown): value is D1Database {
  try {
    return isNonArrayObject(value) && typeof value.prepare === 'function';
  } catch {
    return false;
  }
}

function createDatabaseAdapterSnapshot(value: unknown): D1Database {
  if (!isNonArrayObject(value)) {
    throw new Error('D1 adapter yapılandırması geçersiz.');
  }

  let capturedPrepare: unknown;
  try {
    capturedPrepare = value.prepare;
  } catch {
    throw new Error('D1 prepare fonksiyonu okunamadı.');
  }
  if (typeof capturedPrepare !== 'function') {
    throw new Error('D1 prepare yapılandırması bir fonksiyon olmalıdır.');
  }

  const prepare = ((query: string) =>
    Reflect.apply(capturedPrepare, value, [query])) as D1Database['prepare'];
  return Object.freeze({ prepare }) as unknown as D1Database;
}

const DECISION_MESSAGES: Readonly<Record<AuthorizationReasonCode, string>> = Object.freeze({
  ALLOWED: 'Erişim yetkilendirildi.',
  INVALID_CONTEXT: 'Kullanıcı veya kimlik bağlamı geçersiz ya da etkin değil.',
  USER_INACTIVE: 'Kullanıcı hesabı aktif değil.',
  MEMBERSHIP_NOT_FOUND: 'Kullanıcının belirtilen acentede aktif üyeliği bulunamadı.',
  MEMBERSHIP_INACTIVE: 'Acente üyeliği aktif değil.',
  AGENCY_MISMATCH: 'Hedef acente sınırı uyuşmuyor.',
  UNKNOWN_ACTION: 'İstenen eylem tanımlı değil.',
  UNKNOWN_PERMISSION: 'İstenen izin katalogda tanımlı değil.',
  MALFORMED_INPUT: 'Yetkilendirme isteği biçimi geçersiz.',
  MISSING_CATALOG_METADATA: 'İzin katalog meta verisi eksik veya bozuk.',
  PERMISSION_NOT_GRANTED: 'İstenen izin bu üyelik için tanımlı değildir.',
  OWNER_REQUIRED: 'Bu işlem yalnızca acente sahibi (OWNER) tarafından gerçekleştirilebilir.',
  PROVISIONING_NOT_ALLOWED:
    'Sistem ilk kurulum eylemleri normal çalışma zamanı yetkilendiricisi üzerinden yürütülemez.',
  OWNER_SENSITIVE_GRANT_REQUIRED: 'Hassas veri izinleri için açık yetkilendirme kaydı gereklidir.',
  INVALID_STORED_GRANT: 'Saklanan yetkilendirme kaydı geçersiz.',
  INVALID_STORED_SCOPE: 'Saklanan izin kapsamı geçersiz.',
  DEPENDENCY_MISSING: 'Zorunlu önkoşul izni tanımlı değil.',
  DEPENDENCY_INVALID: 'Bağımlı izin tanımı geçersiz.',
  DEPENDENCY_SCOPE_TOO_NARROW: 'Bağımlı izin kapsamı yetersiz.',
  DEPENDENCY_CORRUPT: 'İzin bağımlılık yapısı bozuk.',
  SCOPE_RESOLVER_DENIED: 'Kayıt kapsamı erişimi reddetti.',
  SCOPE_RESOLVER_ERROR: 'Kapsam çözümleyici yürütme hatası oluştu.',
  UNKNOWN_SCOPE_RESOLVER: 'Kapsam çözümleyici bulunamadı.',
  SECURE_GRANT_REQUIRED: 'Bu işlem için ek güvenlik onayı zorunludur.',
  DATABASE_ERROR: 'Veritabanı işlemi sırasında hata oluştu.',
});

function deny(code: AuthorizationReasonCode): AuthorizationResult {
  return Object.freeze({
    decision: 'DENY' as const,
    code,
    message: DECISION_MESSAGES[code],
  });
}

function allow(effectiveScope: EffectiveScope): AuthorizationResult {
  return Object.freeze({
    decision: 'ALLOW' as const,
    code: 'ALLOWED' as const,
    effectiveScope,
    message: DECISION_MESSAGES.ALLOWED,
  });
}

function scopeWeight(scope: EffectiveScope): number {
  if (scope === 'ASSIGNED') return 1;
  if (scope === 'AGENCY') return 2;
  return 0; // UNSCOPED
}

const ALLOWED_ACTION_DEFINITION_KEYS = new Set([
  'code',
  'authority',
  'requiredNormalPermissions',
  'requiredSensitivePermissions',
  'assurance',
]);

/**
 * Eylem tanımını klonlayarak derin dondurulmuş güvenli kopya döndürür.
 */
function cloneActionDefinition(def: ActionDefinition): ActionDefinition {
  return Object.freeze({
    code: def.code,
    authority: def.authority,
    requiredNormalPermissions: Object.freeze([...def.requiredNormalPermissions]),
    requiredSensitivePermissions: Object.freeze([...def.requiredSensitivePermissions]),
    assurance: def.assurance,
  });
}

/**
 * Eylem tanımını tek seferlik güvenli alan yakalama (defensive minimal capture),
 * fail-closed doğrulama ve değişmez kanonik kopya (canonical detached copy)
 * inşası ile TOCTOU ve Proxy/getter manipülasyonlarına karşı korur.
 *
 * KRİTİK MİMARİ İNVARYANTLAR:
 * 1. Her eylem tanımı açık bir yetki düzeyi (authority: MEMBERSHIP_AUTHORIZED | OWNER_ONLY | PROVISIONING_ONLY) taşımalıdır.
 * 2. Her authorizable eylem en az bir katalog kaynaklı NORMAL operasyonel izin içermelidir (OWNER_ONLY ve PROVISIONING_ONLY dahil).
 * 3. SENSITIVE izinler asla tek başına eylem yetkisi olamaz; daima NORMAL izne eklenir (additive).
 * 4. Arayan sınıflandırması kataloğu ezemez; katalogdaki classification esastır.
 * 5. Kütük anahtarı (expectedCode) ile eylem tanım kodu birebir eşleşmelidir.
 * 6. Tüm desteklenen alanlar ve güvence düzeyleri fail-closed doğrulanır.
 * 7. Güvenilmez nesne alanları tam olarak BİR KEZ okunur; nesne asla yeniden okunmaz.
 * 8. Arayan dizi referansları asla saklanmaz; bağımsız eleman kopyaları çıkarılır ve dondurulur.
 */
function validateActionDefinitionInternal(
  rawDef: unknown,
  expectedCode?: string,
): { valid: true; action: ActionDefinition } | { valid: false; error: string } {
  if (!isNonArrayObject(rawDef)) {
    return { valid: false, error: 'Eylem tanımı nesne olmalıdır.' };
  }

  // 1. Desteklenen tüm alanların sınır denetimi (fail-closed, ekstra alan reddi)
  // Hostile Proxy ownKeys tuzağına karşı try/catch ile korunur.
  let ownKeys: string[];
  try {
    ownKeys = Object.keys(rawDef);
  } catch {
    return { valid: false, error: 'Eylem tanımı anahtarları okunurken hata oluştu.' };
  }

  for (const key of ownKeys) {
    if (!ALLOWED_ACTION_DEFINITION_KEYS.has(key)) {
      return { valid: false, error: `Eylem tanımında geçersiz/desteklenmeyen alan: '${key}'` };
    }
  }

  // 2. Güvenilmez alanların TEK SEFERDE yakalanması (Defensive Minimal Capture)
  let capturedCode: unknown;
  let capturedAuthority: unknown;
  let capturedNormal: unknown;
  let capturedSensitive: unknown;
  let capturedAssurance: unknown;

  try {
    const record = rawDef as Record<string, unknown>;
    capturedCode = record.code;
    capturedAuthority = record.authority;
    capturedNormal = record.requiredNormalPermissions;
    capturedSensitive = record.requiredSensitivePermissions;
    capturedAssurance = record.assurance;
  } catch {
    return { valid: false, error: 'Eylem tanımı alanları yakalanırken hata oluştu.' };
  }

  // rawDef nesnesi bundan sonra ASLA tekrar okunmaz veya referans verilmez!

  // 3. Eylem kodu doğrulaması (yakalanan capturedCode üzerinden)
  if (
    typeof capturedCode !== 'string' ||
    !CANONICAL_CODE_REGEX.test(capturedCode) ||
    capturedCode !== capturedCode.trim()
  ) {
    return { valid: false, error: `Geçersiz eylem kodu: ${String(capturedCode)}` };
  }

  // Registry anahtarı ile eylem kodu eşleşme denetimi (defense-in-depth)
  if (expectedCode !== undefined && capturedCode !== expectedCode) {
    return {
      valid: false,
      error: `Eylem kütük anahtarı ('${expectedCode}') ile eylem tanım kodu ('${capturedCode}') uyuşmuyor.`,
    };
  }

  // 4. Yetki düzeyi (authority) doğrulaması (Finding 4)
  if (
    capturedAuthority !== 'MEMBERSHIP_AUTHORIZED' &&
    capturedAuthority !== 'OWNER_ONLY' &&
    capturedAuthority !== 'PROVISIONING_ONLY'
  ) {
    return {
      valid: false,
      error: `Eylem tanımında yetki düzeyi (authority) zorunludur ve 'MEMBERSHIP_AUTHORIZED' | 'OWNER_ONLY' | 'PROVISIONING_ONLY' olmalıdır: '${String(capturedAuthority)}'`,
    };
  }

  // 5. İzin dizilerinin yakalanması ve yerel bağımsız kopyaya aktarılması
  try {
    if (capturedNormal !== undefined && !Array.isArray(capturedNormal)) {
      return { valid: false, error: 'requiredNormalPermissions bir dizi olmalıdır.' };
    }

    if (capturedSensitive !== undefined && !Array.isArray(capturedSensitive)) {
      return { valid: false, error: 'requiredSensitivePermissions bir dizi olmalıdır.' };
    }
  } catch {
    return { valid: false, error: 'Eylem izin dizileri doğrulanamadı.' };
  }

  const rawNormalList = (capturedNormal as readonly unknown[] | undefined) ?? [];
  const rawSensitiveList = (capturedSensitive as readonly unknown[] | undefined) ?? [];

  const copiedNormalItems: unknown[] = [];
  try {
    for (let i = 0; i < rawNormalList.length; i++) {
      copiedNormalItems.push(rawNormalList[i]);
    }
  } catch {
    return { valid: false, error: 'requiredNormalPermissions elemanları kopyalanamadı.' };
  }

  const copiedSensitiveItems: unknown[] = [];
  try {
    for (let i = 0; i < rawSensitiveList.length; i++) {
      copiedSensitiveItems.push(rawSensitiveList[i]);
    }
  } catch {
    return { valid: false, error: 'requiredSensitivePermissions elemanları kopyalanamadı.' };
  }

  // ZORUNLU KURAL: Her eylem tanımı en az bir katalog kaynaklı NORMAL operasyonel izin içermelidir!
  // (SENSITIVE tek başına yetki veremez; OWNER_ONLY ve PROVISIONING_ONLY dahil).
  if (copiedNormalItems.length === 0) {
    return {
      valid: false,
      error: `'${capturedCode}' eylemi en az bir NORMAL operasyonel izin gerektirmelidir (SENSITIVE tek başına yetki veremez).`,
    };
  }

  // 6. NORMAL izinlerin doğrulanması
  const seenNormal: string[] = [];
  const seenNormalSet = new Set<string>();
  for (const code of copiedNormalItems) {
    if (
      typeof code !== 'string' ||
      !CANONICAL_CODE_REGEX.test(code) ||
      code !== code.trim() ||
      seenNormalSet.has(code)
    ) {
      return { valid: false, error: `Geçersiz veya yinelenen normal izin kodu: ${String(code)}` };
    }
    const catDef = getPermissionDefinition(code);
    if (!catDef || catDef.classification !== 'NORMAL') {
      return {
        valid: false,
        error: `'${code}' katalogda bulunamadı veya NORMAL sınıfında değil (arayan sınıflandırması kataloğu ezemez).`,
      };
    }
    seenNormalSet.add(code);
    seenNormal.push(code);
  }

  // 7. SENSITIVE izinlerin doğrulanması
  const seenSensitive: string[] = [];
  const seenSensitiveSet = new Set<string>();
  for (const code of copiedSensitiveItems) {
    if (
      typeof code !== 'string' ||
      !CANONICAL_CODE_REGEX.test(code) ||
      code !== code.trim() ||
      seenSensitiveSet.has(code)
    ) {
      return { valid: false, error: `Geçersiz veya yinelenen hassas izin kodu: ${String(code)}` };
    }
    const catDef = getPermissionDefinition(code);
    if (!catDef || catDef.classification !== 'SENSITIVE') {
      return {
        valid: false,
        error: `'${code}' katalogda bulunamadı veya SENSITIVE sınıfında değil (arayan sınıflandırması kataloğu ezemez).`,
      };
    }
    if (seenNormalSet.has(code)) {
      return {
        valid: false,
        error: `'${code}' hem normal hem hassas izin olarak tanımlanamaz.`,
      };
    }
    seenSensitiveSet.add(code);
    seenSensitive.push(code);
  }

  // 8. Güvence (assurance) düzeyi doğrulaması
  if (
    capturedAssurance !== undefined &&
    capturedAssurance !== 'NORMAL_SESSION' &&
    capturedAssurance !== 'SECURE_GRANT'
  ) {
    return {
      valid: false,
      error: `'${capturedCode}' eyleminde geçersiz güvence düzeyi: ${String(capturedAssurance)}`,
    };
  }

  let computedAssurance: 'NORMAL_SESSION' | 'SECURE_GRANT' = 'NORMAL_SESSION';
  for (const code of [...seenNormal, ...seenSensitive]) {
    const catDef = getPermissionDefinition(code)!;
    if (catDef.assurance === 'SECURE_GRANT') {
      computedAssurance = 'SECURE_GRANT';
    }
  }

  const finalAssurance =
    (capturedAssurance as 'NORMAL_SESSION' | 'SECURE_GRANT' | undefined) ?? computedAssurance;
  if (computedAssurance === 'SECURE_GRANT' && finalAssurance !== 'SECURE_GRANT') {
    return {
      valid: false,
      error: `'${capturedCode}' eylemi SECURE_GRANT izni içerdiğinden SECURE_GRANT güvencesi taşımalıdır.`,
    };
  }

  // 9. Yeni ve tamamen bağımsız, derinlemesine dondurulmuş (deep-frozen) kanonik nesne oluştur
  return {
    valid: true,
    action: Object.freeze({
      code: capturedCode,
      authority: capturedAuthority as ActionAuthority,
      requiredNormalPermissions: Object.freeze([...seenNormal]),
      requiredSensitivePermissions: Object.freeze([...seenSensitive]),
      assurance: finalAssurance,
    }),
  };
}

function captureActionPermissionArray(
  rawValue: unknown,
  fieldName: string,
): { valid: true; value: readonly unknown[] | undefined } | { valid: false; error: string } {
  if (rawValue === undefined) {
    return { valid: true, value: undefined };
  }

  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    if (!Array.isArray(rawValue)) {
      return { valid: false, error: `${fieldName} bir dizi olmalıdır.` };
    }
    descriptors = Object.getOwnPropertyDescriptors(rawValue) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    return { valid: false, error: `${fieldName} güvenli biçimde okunamadı.` };
  }

  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > 1000
  ) {
    return { valid: false, error: `${fieldName} uzunluğu geçersiz.` };
  }

  const length = lengthDescriptor.value;
  const copied: unknown[] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) {
      return { valid: false, error: `${fieldName} desteklenmeyen bir alan içeriyor.` };
    }
  }

  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) {
      return { valid: false, error: `${fieldName} erişimci veya boş eleman içeremez.` };
    }
    copied.push(descriptor.value);
  }

  return { valid: true, value: Object.freeze(copied) };
}

/**
 * Fabrika/builder yapılandırması için erişimci çalıştırmadan tek-seferlik action
 * snapshot'ı oluşturur. Accessor tabanlı tanımlar atomik enumerate/capture
 * garantisi veremediğinden fail-closed reddedilir.
 */
function validateActionDefinitionSnapshot(
  rawDef: unknown,
  expectedCode?: string,
): { valid: true; action: ActionDefinition } | { valid: false; error: string } {
  if (!isNonArrayObject(rawDef)) {
    return { valid: false, error: 'Eylem tanımı nesne olmalıdır.' };
  }

  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(rawDef) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    return { valid: false, error: 'Eylem tanımı alan tanımları okunamadı.' };
  }

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !ALLOWED_ACTION_DEFINITION_KEYS.has(key)) {
      return {
        valid: false,
        error: `Eylem tanımında geçersiz/desteklenmeyen alan: '${String(key)}'`,
      };
    }
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) {
      return { valid: false, error: `Eylem tanımı erişimci alan içeremez: '${key}'` };
    }
  }

  try {
    structuredClone(rawDef);
  } catch {
    return { valid: false, error: 'Eylem tanımı Proxy veya kopyalanamaz değer içeremez.' };
  }

  const valueOf = (key: string): unknown => descriptors[key]?.value;
  const normal = captureActionPermissionArray(
    valueOf('requiredNormalPermissions'),
    'requiredNormalPermissions',
  );
  if (!normal.valid) return normal;
  const sensitive = captureActionPermissionArray(
    valueOf('requiredSensitivePermissions'),
    'requiredSensitivePermissions',
  );
  if (!sensitive.valid) return sensitive;

  const detached = Object.freeze({
    code: valueOf('code'),
    authority: valueOf('authority'),
    requiredNormalPermissions: normal.value,
    requiredSensitivePermissions: sensitive.value,
    assurance: valueOf('assurance'),
  });
  return validateActionDefinitionInternal(detached, expectedCode);
}

/**
 * Eylem tanımı doğrulaması yapar ve değişmez bir ActionDefinition nesnesi döndürür.
 */
export function validateAndCreateActionDefinition(def: {
  code: string;
  authority: ActionAuthority;
  requiredNormalPermissions?: readonly string[];
  requiredSensitivePermissions?: readonly string[];
  assurance?: 'NORMAL_SESSION' | 'SECURE_GRANT';
}): ActionDefinition {
  const result = validateActionDefinitionInternal(def);
  if (!result.valid) {
    throw new Error(result.error);
  }
  return result.action;
}

/**
 * Verilen eylem tanımlarından çalışma zamanında tamamen değişmez (deep-frozen),
 * özel kapsülleme (private closure) ile saklanan güvenli bir ActionRegistry üretir.
 * Dışarıya hiçbir mutable Map, Set veya nesne referansı açılmaz.
 */
export function createActionRegistry(
  entries?:
    | Iterable<ActionDefinition | readonly [string, ActionDefinition]>
    | Record<string, ActionDefinition>
    | Map<string, ActionDefinition>,
): ActionRegistry {
  const backingStore = new Map<string, ActionDefinition>();
  let capturedEntryCount = 0;

  const storeUnique = (code: string, action: ActionDefinition): void => {
    if (backingStore.has(code)) {
      throw new Error(`Eylem kütüğünde yinelenen kod bulundu: '${code}'.`);
    }
    backingStore.set(code, cloneActionDefinition(action));
  };

  if (entries) {
    if (typeof (entries as Iterable<unknown>)[Symbol.iterator] === 'function') {
      for (const item of entries as Iterable<unknown>) {
        if (capturedEntryCount >= MAX_ACTION_REGISTRY_ENTRIES) {
          throw new Error('Eylem kütüğü izin verilen boyutu aşıyor.');
        }
        capturedEntryCount += 1;
        const tuple = captureActionPermissionArray(item, 'Eylem kütüğü iterator girdisi');
        if (tuple.valid && tuple.value?.length === 2 && typeof tuple.value[0] === 'string') {
          const [key, rawDef] = tuple.value;
          const validated = validateActionDefinitionSnapshot(rawDef, key);
          if (!validated.valid) {
            throw new Error(`Geçersiz eylem tanımı ('${key}'): ${validated.error}`);
          }
          storeUnique(key, validated.action);
        } else if (item && typeof item === 'object') {
          const validated = validateActionDefinitionSnapshot(item);
          if (!validated.valid) {
            throw new Error(`Geçersiz eylem tanımı: ${validated.error}`);
          }
          storeUnique(validated.action.code, validated.action);
        } else {
          throw new Error('Eylem kütüğü geçersiz bir iterable girdisi içeriyor.');
        }
      }
    } else if (typeof entries === 'object' && entries !== null) {
      let descriptors: Record<PropertyKey, PropertyDescriptor>;
      try {
        descriptors = Object.getOwnPropertyDescriptors(entries) as Record<
          PropertyKey,
          PropertyDescriptor
        >;
      } catch {
        throw new Error('Eylem kütüğü kayıt alanları okunamadı.');
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') {
          throw new Error('Eylem kütüğü sembol anahtar içeremez.');
        }
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable) continue;
        if (capturedEntryCount >= MAX_ACTION_REGISTRY_ENTRIES) {
          throw new Error('Eylem kütüğü izin verilen boyutu aşıyor.');
        }
        capturedEntryCount += 1;
        if (!('value' in descriptor)) {
          throw new Error(`Eylem kütüğü erişimci değer içeremez: '${key}'.`);
        }
        const validated = validateActionDefinitionSnapshot(descriptor.value, key);
        if (!validated.valid) {
          throw new Error(`Geçersiz eylem tanımı ('${key}'): ${validated.error}`);
        }
        storeUnique(key, validated.action);
      }
    }
  }

  const registry: ActionRegistry = {
    get(code: string): ActionDefinition | undefined {
      if (typeof code !== 'string') return undefined;
      const found = backingStore.get(code);
      return found ? cloneActionDefinition(found) : undefined;
    },
    has(code: string): boolean {
      if (typeof code !== 'string') return false;
      return backingStore.has(code);
    },
    list(): readonly ActionDefinition[] {
      return Object.freeze(Array.from(backingStore.values()).map(cloneActionDefinition));
    },
    *entries(): IterableIterator<[string, ActionDefinition]> {
      for (const [code, def] of backingStore.entries()) {
        yield [code, cloneActionDefinition(def)];
      }
    },
    [Symbol.iterator](): IterableIterator<[string, ActionDefinition]> {
      return this.entries();
    },
  };

  return Object.freeze(registry);
}

/**
 * Varsayılan eylem kütüğü oluşturur.
 * Yalnızca katalogdaki NORMAL izinleri güvenli şekilde eşler (authority: MEMBERSHIP_AUTHORIZED);
 * doğrudan hassas izinler eylem olarak yer almaz (BLOCKER-1).
 */
export function createDefaultActionRegistry(): ActionRegistry {
  const normalActions: ActionDefinition[] = [];

  for (const perm of PERMISSION_CATALOG) {
    if (perm.classification === 'NORMAL') {
      const actionDef = validateAndCreateActionDefinition({
        code: perm.code,
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: [perm.code],
        requiredSensitivePermissions: [],
        assurance: perm.assurance,
      });
      normalActions.push(actionDef);
    }
  }

  for (const code of ['permission.grant', 'permission.revoke', 'permission.scope.change']) {
    normalActions.push(
      validateAndCreateActionDefinition({
        code,
        authority: 'OWNER_ONLY',
        requiredNormalPermissions: ['agency.settings.manage'],
        requiredSensitivePermissions: [],
        assurance: 'SECURE_GRANT',
      }),
    );
  }

  for (const code of [
    'company_contact.create',
    'company_contact.update',
    'company_contact.set_primary',
    'company_contact.deactivate',
  ] as const) {
    normalActions.push(
      validateAndCreateActionDefinition({
        code,
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['customer.update'],
        requiredSensitivePermissions: [],
        assurance: 'NORMAL_SESSION',
      }),
    );
  }

  // M2-T02 Kanonik Bileşik Eylemler (Canonical Compound Actions)
  normalActions.push(
    validateAndCreateActionDefinition({
      code: 'customer.identity.read',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['customer.read'],
      requiredSensitivePermissions: ['sensitive.identity.read'],
      assurance: 'NORMAL_SESSION',
    }),
    validateAndCreateActionDefinition({
      code: 'customer.identity.update',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['customer.update'],
      requiredSensitivePermissions: ['sensitive.identity.read', 'sensitive.identity.write'],
      assurance: 'NORMAL_SESSION',
    }),
    validateAndCreateActionDefinition({
      code: 'customer.identity.search',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['customer.read'],
      requiredSensitivePermissions: ['sensitive.identity.read'],
      assurance: 'NORMAL_SESSION',
    }),
    validateAndCreateActionDefinition({
      code: 'customer.external_reference.create',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['customer.update'],
      requiredSensitivePermissions: [],
      assurance: 'NORMAL_SESSION',
    }),
  );

  normalActions.push(
    validateAndCreateActionDefinition({
      code: 'policy.health.read',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['policy.read'],
      requiredSensitivePermissions: ['sensitive.health.read'],
      assurance: 'NORMAL_SESSION',
    }),
    validateAndCreateActionDefinition({
      code: 'policy.health.create',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['policy.create'],
      requiredSensitivePermissions: ['sensitive.health.read', 'sensitive.health.write'],
      assurance: 'NORMAL_SESSION',
    }),
    validateAndCreateActionDefinition({
      code: 'policy.health.update',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['policy.update'],
      requiredSensitivePermissions: ['sensitive.health.read', 'sensitive.health.write'],
      assurance: 'NORMAL_SESSION',
    }),
    validateAndCreateActionDefinition({
      code: 'policy.health.archive',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['policy.archive'],
      requiredSensitivePermissions: ['sensitive.health.read', 'sensitive.health.write'],
      assurance: 'NORMAL_SESSION',
    }),
    validateAndCreateActionDefinition({
      code: 'quote.health.manage',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['quote.manage'],
      requiredSensitivePermissions: ['sensitive.health.read', 'sensitive.health.write'],
      assurance: 'NORMAL_SESSION',
    }),
    validateAndCreateActionDefinition({
      code: 'interaction.health.create',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['interaction.create'],
      requiredSensitivePermissions: ['sensitive.health.read', 'sensitive.health.write'],
      assurance: 'NORMAL_SESSION',
    }),
    validateAndCreateActionDefinition({
      code: 'policy.identity_variant.create',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['policy.update'],
      requiredSensitivePermissions: [],
      assurance: 'SECURE_GRANT',
    }),
    validateAndCreateActionDefinition({
      code: 'renewal.policy_links.allocate',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['renewal.update'],
      requiredSensitivePermissions: [],
      assurance: 'SECURE_GRANT',
    }),
    validateAndCreateActionDefinition({
      code: 'renewal.won.correct',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['renewal.update'],
      requiredSensitivePermissions: [],
      assurance: 'SECURE_GRANT',
    }),
    validateAndCreateActionDefinition({
      code: 'renewal.close_won.group',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['renewal.close_won'],
      requiredSensitivePermissions: [],
      assurance: 'SECURE_GRANT',
    }),
  );

  normalActions.push(
    validateAndCreateActionDefinition({
      code: 'document.identity.read',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['document.read'],
      requiredSensitivePermissions: ['sensitive.identity.read'],
      assurance: 'NORMAL_SESSION',
    }),
    validateAndCreateActionDefinition({
      code: 'document.identity.upload',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['document.upload'],
      requiredSensitivePermissions: ['sensitive.identity.read', 'sensitive.identity.write'],
      assurance: 'NORMAL_SESSION',
    }),
    validateAndCreateActionDefinition({
      code: 'document.identity.archive',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['document.archive'],
      requiredSensitivePermissions: ['sensitive.identity.read', 'sensitive.identity.write'],
      assurance: 'NORMAL_SESSION',
    }),
    validateAndCreateActionDefinition({
      code: 'document.health.read',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['document.read'],
      requiredSensitivePermissions: ['sensitive.health.read'],
      assurance: 'NORMAL_SESSION',
    }),
    validateAndCreateActionDefinition({
      code: 'document.health.upload',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['document.upload'],
      requiredSensitivePermissions: ['sensitive.health.read', 'sensitive.health.write'],
      assurance: 'NORMAL_SESSION',
    }),
    validateAndCreateActionDefinition({
      code: 'document.health.archive',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['document.archive'],
      requiredSensitivePermissions: ['sensitive.health.read', 'sensitive.health.write'],
      assurance: 'NORMAL_SESSION',
    }),
  );

  for (const code of [
    'policy_party.create',
    'policy_party.deactivate',
    'policy_amendment.create',
    'policy_external_reference.create',
  ] as const) {
    normalActions.push(
      validateAndCreateActionDefinition({
        code,
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['policy.update'],
        requiredSensitivePermissions: [],
        assurance: 'NORMAL_SESSION',
      }),
    );
  }

  // M2-T03 Kanonik Katalog ve Acente Ayarları Eylemleri (M2-T03 Canonical Actions)
  const catalogManageActions = [
    'catalog.insurer.create',
    'catalog.insurer.update',
    'catalog.insurer.deactivate',
    'catalog.branch.create',
    'catalog.branch.update',
    'catalog.branch.deactivate',
    'catalog.product.create',
    'catalog.product.update',
    'catalog.product.deactivate',
    'catalog.payment_method.create',
    'catalog.payment_method.update',
    'catalog.payment_method.deactivate',
    'catalog.loss_reason.create',
    'catalog.loss_reason.update',
    'catalog.loss_reason.deactivate',
  ];

  for (const code of catalogManageActions) {
    normalActions.push(
      validateAndCreateActionDefinition({
        code,
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['catalog.manage'],
        requiredSensitivePermissions: [],
        assurance: 'NORMAL_SESSION',
      }),
    );
  }

  normalActions.push(
    validateAndCreateActionDefinition({
      code: 'agency.settings.update_operations',
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['agency.settings.manage'],
      requiredSensitivePermissions: [],
      assurance: 'NORMAL_SESSION',
    }),
  );

  return createActionRegistry(normalActions);
}

export const DEFAULT_ACTION_REGISTRY = createDefaultActionRegistry();

/**
 * Evaluator fabrikasına verilen eylem kütüğünü tek seferde enumerate eder,
 * her tanımı kanonikleştirir ve dış kaynakla hiçbir mutable alias paylaşmayan
 * private bir ActionRegistry snapshot'ına dönüştürür.
 */
function createActionRegistrySnapshot(actions?: AuthorizationOptions['actions']): ActionRegistry {
  const source = actions ?? DEFAULT_ACTION_REGISTRY;
  if (!source || typeof source !== 'object') {
    throw new Error('Geçersiz eylem kütüğü yapılandırması.');
  }

  let entriesMethod: unknown;
  let iteratorMethod: unknown;
  let listMethod: unknown;
  try {
    const registry = source as Record<PropertyKey, unknown>;
    entriesMethod = registry.entries;
    iteratorMethod = registry[Symbol.iterator];
    listMethod = registry.list;
  } catch {
    throw new Error('Eylem kütüğü yapılandırması okunamadı.');
  }

  const capturedEntries: Array<readonly [string, ActionDefinition]> = [];
  const seenCodes = new Set<string>();
  let sourceMapSize: number | undefined;
  try {
    if (source instanceof Map) {
      sourceMapSize = source.size;
    }
  } catch {
    throw new Error('Eylem kütüğü yapısı doğrulanamadı.');
  }

  const assertSourceMapUnchanged = (): void => {
    if (sourceMapSize === undefined) return;
    let currentSize: number;
    try {
      currentSize = (source as Map<unknown, unknown>).size;
    } catch {
      throw new Error('Eylem kütüğü yapısı yeniden okunamadı.');
    }
    if (currentSize !== sourceMapSize) {
      throw new Error('Eylem kütüğü oluşturma sırasında değiştirildi.');
    }
  };

  const reserveEntryKey = (key: unknown): string => {
    if (typeof key !== 'string' || !CANONICAL_CODE_REGEX.test(key) || key !== key.trim()) {
      throw new Error('Eylem kütüğü geçersiz bir anahtar içeriyor.');
    }
    if (seenCodes.has(key)) {
      throw new Error(`Eylem kütüğünde yinelenen kod bulundu: '${key}'.`);
    }

    seenCodes.add(key);
    return key;
  };

  if (typeof entriesMethod === 'function' || typeof iteratorMethod === 'function') {
    let iterator: Iterator<unknown>;
    try {
      const enumerate =
        typeof entriesMethod === 'function' ? entriesMethod : (iteratorMethod as () => unknown);
      const candidate = enumerate.call(source) as { next?: unknown };
      if (!candidate || typeof candidate.next !== 'function') {
        throw new Error('Geçersiz eylem kütüğü iterator sonucu.');
      }
      iterator = candidate as Iterator<unknown>;
    } catch {
      throw new Error('Eylem kütüğü enumerate edilemedi.');
    }

    for (let index = 0; index <= MAX_ACTION_REGISTRY_ENTRIES; index++) {
      let next: IteratorResult<unknown>;
      try {
        next = iterator.next();
      } catch {
        throw new Error('Eylem kütüğü iterasyonu başarısız oldu.');
      }

      if (next.done) break;
      if (index === MAX_ACTION_REGISTRY_ENTRIES) {
        throw new Error('Eylem kütüğü izin verilen boyutu aşıyor.');
      }

      const item = captureActionPermissionArray(next.value, 'Eylem kütüğü iterator girdisi');
      if (!item.valid || item.value?.length !== 2) {
        throw new Error('Eylem kütüğü iterator girdisi [kod, tanım] olmalıdır.');
      }
      const key = reserveEntryKey(item.value[0]);
      const validated = validateActionDefinitionSnapshot(item.value[1], key);
      if (!validated.valid) {
        throw new Error(`Geçersiz eylem tanımı ('${key}'): ${validated.error}`);
      }
      capturedEntries.push([key, validated.action]);
      assertSourceMapUnchanged();
    }
  } else if (typeof listMethod === 'function') {
    let listed: unknown;
    try {
      listed = listMethod.call(source);
    } catch {
      throw new Error('Eylem kütüğü listesi okunamadı.');
    }

    const listedSnapshot = captureActionPermissionArray(listed, 'Eylem kütüğü listesi');
    if (!listedSnapshot.valid || !listedSnapshot.value) {
      throw new Error('Eylem kütüğü listesi geçersiz.');
    }
    const listedValues = listedSnapshot.value;
    const listedLength = listedValues.length;

    if (!Number.isSafeInteger(listedLength) || listedLength > MAX_ACTION_REGISTRY_ENTRIES) {
      throw new Error('Eylem kütüğü listesi geçersiz.');
    }

    for (let index = 0; index < listedLength; index++) {
      let rawDefinition: unknown;
      try {
        rawDefinition = listedValues[index];
      } catch {
        throw new Error('Eylem kütüğü liste girdisi okunamadı.');
      }
      const validated = validateActionDefinitionSnapshot(rawDefinition);
      if (!validated.valid) {
        throw new Error(`Geçersiz eylem tanımı: ${validated.error}`);
      }
      const key = reserveEntryKey(validated.action.code);
      capturedEntries.push([key, validated.action]);
    }
  } else {
    throw new Error('Eylem kütüğü enumerate edilebilir olmalıdır.');
  }

  assertSourceMapUnchanged();
  return createActionRegistry(capturedEntries);
}

/**
 * Gerçek müşteri ve kişi kayıt kapsamı çözümleyicisi (M2-T01).
 *
 * MİMARİ SÖZLEŞME:
 * - AGENCY kapsamı: Kaynak aktörle aynı acenteye ait olmalıdır.
 * - ASSIGNED kapsamı:
 *   - Müşteri oluşturma: Sunucudan türetilmiş acente ve atanan üyelik doğrulanır.
 *   - Müşteri okuma/güncelleme: Müşterinin assignee_membership_id değeri aktörün üyeliğiyle eşleşmelidir.
 *   - Şirket yetkilisi (Contact): Üst şirketin (parent customer) kapsamı devralınır (parentAssigneeMembershipId).
 * - Bozuk, eksik, farklı acenteye ait veriler veya beklenmeyen hatalarda FAIL-CLOSED ret (false) üretir.
 */
export function customerRecordResolver(context: ScopeResolutionContext): boolean {
  try {
    const { agencyId, membershipId, effectiveScope, resource } = context;

    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
      return false;
    }

    const res = resource as Record<string, unknown>;

    // 1. Aynı acente kontrolü zorunludur (Cross-agency erişim derhal reddedilir)
    if (typeof res.agencyId !== 'string' || res.agencyId !== agencyId) {
      return false;
    }

    // 2. AGENCY kapsamı: Acente içi tüm kayıtlara erişim sağlar
    if (effectiveScope === 'AGENCY') {
      return true;
    }

    // 3. ASSIGNED kapsamı:
    if (effectiveScope === 'ASSIGNED') {
      // A. Koleksiyon veya arama filtresi: Aynı acente içinde sorgulama (sonuç kümesi SQL'de assignee_membership_id ile filtrelenecektir)
      if (res.isCollection === true) {
        return true;
      }

      // B. Müşteri oluşturma (create): sunucudan türetilmiş önerilen agency ve assignee
      if (res.isCreate === true) {
        return (
          typeof res.assigneeMembershipId === 'string' && res.assigneeMembershipId === membershipId
        );
      }

      // B. Şirket yetkilisi (Contact): üst müşterinin assignee_membership_id'si kontrol edilir
      if (typeof res.parentAssigneeMembershipId === 'string') {
        return res.parentAssigneeMembershipId === membershipId;
      }

      // D. Sunucudan kurulan alt görev kaynağındaki bağlı Customer kapsamı
      if (typeof res.customerAssigneeMembershipId === 'string') {
        return res.customerAssigneeMembershipId === membershipId;
      }

      // E. Mevcut müşteri kaydı: atanan üyelik aktörün üyeliği olmalıdır
      if (typeof res.assigneeMembershipId === 'string') {
        return res.assigneeMembershipId === membershipId;
      }

      return false;
    }

    return false;
  } catch {
    return false;
  }
}

export function policyRecordResolver(context: ScopeResolutionContext): boolean {
  try {
    const { agencyId, membershipId, effectiveScope, resource } = context;
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return false;
    const record = resource as Record<string, unknown>;
    if (record.agencyId !== agencyId) return false;
    if (effectiveScope === 'AGENCY') return true;
    if (effectiveScope !== 'ASSIGNED') return false;
    if (record.isCollection === true) return true;
    return (
      record.assigneeMembershipId === membershipId ||
      record.customerAssigneeMembershipId === membershipId
    );
  } catch {
    return false;
  }
}

function parentScopedChildRecordResolver(context: ScopeResolutionContext): boolean {
  try {
    const { agencyId, membershipId, effectiveScope, resource } = context;
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return false;
    const record = resource as Record<string, unknown>;
    if (typeof record.agencyId !== 'string' || record.agencyId !== agencyId) return false;
    if (effectiveScope === 'AGENCY') return true;
    if (effectiveScope !== 'ASSIGNED') return false;
    if (record.isCollection === true) return true;
    return (
      record.renewalAssigneeMembershipId === membershipId ||
      record.policyAssigneeMembershipId === membershipId ||
      record.customerAssigneeMembershipId === membershipId
    );
  } catch {
    return false;
  }
}

export function renewalRecordResolver(context: ScopeResolutionContext): boolean {
  try {
    const { agencyId, membershipId, effectiveScope, resource } = context;
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return false;
    const record = resource as Record<string, unknown>;
    if (typeof record.agencyId !== 'string' || record.agencyId !== agencyId) return false;
    if (effectiveScope === 'AGENCY') return true;
    if (effectiveScope !== 'ASSIGNED') return false;
    if (record.isCollection === true) return true;
    return (
      record.renewalAssigneeMembershipId === membershipId ||
      record.customerAssigneeMembershipId === membershipId
    );
  } catch {
    return false;
  }
}

export function quoteRecordResolver(context: ScopeResolutionContext): boolean {
  return renewalRecordResolver(context);
}

export function interactionRecordResolver(context: ScopeResolutionContext): boolean {
  return renewalRecordResolver(context);
}

export function taskRecordResolver(context: ScopeResolutionContext): boolean {
  try {
    const resource = context.resource;
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return false;
    // Task service sets this only after authorizing every linked customer/policy/renewal read.
    const record = resource as Record<string, unknown>;
    if (record.parentReadAuthorized !== true) return false;
    if (record.isCollection === true) return true;
    if (
      context.effectiveScope === 'ASSIGNED' &&
      record.taskAssigneeMembershipId !== context.membershipId
    ) {
      return false;
    }
    return parentScopedChildRecordResolver(context);
  } catch {
    return false;
  }
}

/**
 * Document erişimini acente ve parent kapsamıyla sınırlar. parentReadAuthorized
 * ve parentAssigneeMembershipId yalnız doğrulanmış parent sorgusundan üretilmelidir.
 */
export function documentRecordResolver(context: ScopeResolutionContext): boolean {
  try {
    const { agencyId, membershipId, effectiveScope, resource } = context;
    if (
      typeof agencyId !== 'string' ||
      typeof membershipId !== 'string' ||
      membershipId.trim().length === 0 ||
      !resource ||
      typeof resource !== 'object' ||
      Array.isArray(resource)
    ) {
      return false;
    }

    const record = resource as Record<string, unknown>;
    if (
      record.agencyId !== agencyId ||
      record.parentReadAuthorized !== true ||
      (record.isCollection !== undefined && typeof record.isCollection !== 'boolean')
    ) {
      return false;
    }

    let parentIdKey: 'customerId' | 'policyId' | 'quoteId';
    let assignedAssigneeKeys: readonly string[];
    if (record.ownerType === 'CUSTOMER') {
      parentIdKey = 'customerId';
      assignedAssigneeKeys = ['assigneeMembershipId'];
    } else if (record.ownerType === 'POLICY') {
      parentIdKey = 'policyId';
      assignedAssigneeKeys = ['assigneeMembershipId', 'customerAssigneeMembershipId'];
    } else if (record.ownerType === 'QUOTE') {
      parentIdKey = 'quoteId';
      assignedAssigneeKeys = ['renewalAssigneeMembershipId', 'customerAssigneeMembershipId'];
    } else {
      return false;
    }

    const parentId = record[parentIdKey];
    if (typeof parentId !== 'string' || parentId.trim().length === 0) return false;
    for (const key of ['customerId', 'policyId', 'quoteId'] as const) {
      if (key !== parentIdKey && record[key] !== null && record[key] !== undefined) {
        return false;
      }
    }

    const isCollection = record.isCollection === true;
    if (!isCollection && (typeof record.id !== 'string' || record.id.trim().length === 0)) {
      return false;
    }

    for (const key of assignedAssigneeKeys) {
      const assigneeMembershipId = record[key];
      if (
        assigneeMembershipId !== null &&
        assigneeMembershipId !== undefined &&
        typeof assigneeMembershipId !== 'string'
      ) {
        return false;
      }
    }

    if (effectiveScope === 'AGENCY') return true;
    if (effectiveScope !== 'ASSIGNED') return false;

    // Policy erişimi policy veya müşteri atamasından; Quote erişimi renewal
    // veya müşteri atamasından gelebilir. Tüm alanlar sunucu parent sorgusundan türetilir.
    return assignedAssigneeKeys.some((key) => record[key] === membershipId);
  } catch {
    return false;
  }
}

/**
 * Varsayılan stabil kayıt kapsam çözümleyicileri. Uygulanmamış alanlar fail-closed kalır;
 * Document resolver'ı parent yetki kanıtı olmadan erişim açmaz.
 */
export function createDefaultScopeResolvers(): ScopeResolverRegistry {
  const failClosedResolver: ScopeResolverFunction = () => false;

  return Object.freeze({
    customer_record_resolver: customerRecordResolver,
    policy_record_resolver: policyRecordResolver,
    renewal_record_resolver: renewalRecordResolver,
    quote_record_resolver: quoteRecordResolver,
    interaction_record_resolver: interactionRecordResolver,
    task_record_resolver: taskRecordResolver,
    document_record_resolver: documentRecordResolver,
    report_scope_resolver: failClosedResolver,
  });
}

const DEFAULT_RESOLVERS = createDefaultScopeResolvers();

/**
 * Yalnız katalogdaki sabit resolver kimliklerini bir defa okuyup fonksiyon
 * referanslarını private, immutable bir yapılandırma snapshot'ına taşır.
 */
function createScopeResolverSnapshot(
  resolvers?: Partial<ScopeResolverRegistry>,
): ScopeResolverRegistry {
  const snapshot = {} as Record<StableScopeResolver, ScopeResolverFunction>;

  for (const resolverName of STABLE_SCOPE_RESOLVERS) {
    let capturedResolver: unknown;
    try {
      capturedResolver = resolvers?.[resolverName];
    } catch {
      throw new Error(`Kapsam çözümleyici '${resolverName}' okunamadı.`);
    }

    const resolver = capturedResolver ?? DEFAULT_RESOLVERS[resolverName];
    if (typeof resolver !== 'function') {
      throw new Error(`Kapsam çözümleyici '${resolverName}' bir fonksiyon olmalıdır.`);
    }
    snapshot[resolverName] = resolver as ScopeResolverFunction;
  }

  return Object.freeze(snapshot);
}

function isValidEmailShape(email: unknown): email is string {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length <= 3) return false;
  const atIndex = trimmed.indexOf('@');
  return atIndex > 0 && atIndex < trimmed.length - 1 && atIndex === trimmed.lastIndexOf('@');
}

/**
 * Kullanıcı bağlamının geçerli ve aktif bir dahili bağlam olduğunu fail-closed doğrular (Finding 1).
 *
 * KRİTİK GÜVENLİK İNVARYANTLARI:
 * 1. Her üst ve alt yetki alanı tam olarak BİR KEZ yakalanır ve yerel değişkenlere aktarılır.
 * 2. İlkel değerler taze, bağımsız ve dondurulmuş (frozen) kanonik nesne ve dizilere kopyalanır.
 * 3. Doğrulama sonrasında veya async işlemler boyunca arayan nesneleri asla tutulmaz ya da tekrar okunmaz.
 * 4. Aynı acente için birden fazla veya çakışan üyelikler (IMPORTANT-2) kesinlikle reddedilir.
 */
function validateAuthenticatedUserContext(
  rawContext: unknown,
): { valid: true; ctx: AuthenticatedUserContext } | { valid: false } {
  if (!isNonArrayObject(rawContext)) {
    return { valid: false };
  }

  let capturedUserId: unknown;
  let capturedIdentityId: unknown;
  let capturedEmail: unknown;
  let capturedAssurance: unknown;
  let capturedMemberships: unknown;

  try {
    const rec = rawContext as Record<string, unknown>;
    capturedUserId = rec.userId;
    capturedIdentityId = rec.identityId;
    capturedEmail = rec.email;
    capturedAssurance = rec.assurance;
    capturedMemberships = rec.memberships;
  } catch {
    return { valid: false };
  }

  // rawContext nesnesi bundan sonra ASLA okunmaz!

  if (
    typeof capturedUserId !== 'string' ||
    capturedUserId.trim() === '' ||
    capturedUserId !== capturedUserId.trim()
  ) {
    return { valid: false };
  }

  if (
    typeof capturedIdentityId !== 'string' ||
    capturedIdentityId.trim() === '' ||
    capturedIdentityId !== capturedIdentityId.trim()
  ) {
    return { valid: false };
  }

  if (capturedAssurance !== 'NORMAL' && capturedAssurance !== 'SECURE') {
    return { valid: false };
  }

  let canonicalEmail: string | undefined;
  if (capturedEmail !== undefined) {
    if (
      typeof capturedEmail !== 'string' ||
      capturedEmail.trim() === '' ||
      capturedEmail !== capturedEmail.trim() ||
      !isValidEmailShape(capturedEmail)
    ) {
      return { valid: false };
    }
    canonicalEmail = capturedEmail;
  }

  let membershipsLen: number;
  try {
    if (!Array.isArray(capturedMemberships)) {
      return { valid: false };
    }
    membershipsLen = capturedMemberships.length;
  } catch {
    return { valid: false };
  }

  if (
    typeof membershipsLen !== 'number' ||
    membershipsLen <= 0 ||
    !Number.isInteger(membershipsLen) ||
    membershipsLen > 1000
  ) {
    return { valid: false };
  }

  const rawMembershipsList: unknown[] = [];
  try {
    for (let i = 0; i < membershipsLen; i++) {
      const memItem = capturedMemberships[i];
      if (memItem === undefined && !(i in (capturedMemberships as Record<number, unknown>))) {
        return { valid: false };
      }
      rawMembershipsList.push(memItem);
    }
  } catch {
    return { valid: false };
  }

  if (rawMembershipsList.length !== membershipsLen) {
    return { valid: false };
  }

  const seenMembershipIds = new Set<string>();
  const seenAgencyIds = new Set<string>();
  const canonicalMemberships: ActiveMembershipContext[] = [];

  for (const rawMem of rawMembershipsList) {
    if (!isNonArrayObject(rawMem)) {
      return { valid: false };
    }

    let capturedMemId: unknown;
    let capturedAgencyId: unknown;
    let capturedType: unknown;
    let capturedStatus: unknown;
    let capturedPermVer: unknown;

    try {
      const mRec = rawMem as Record<string, unknown>;
      capturedMemId = mRec.id;
      capturedAgencyId = mRec.agencyId;
      capturedType = mRec.type;
      capturedStatus = mRec.status;
      capturedPermVer = mRec.permissionVersion;
    } catch {
      return { valid: false };
    }

    // rawMem nesnesi bundan sonra ASLA okunmaz!

    if (
      typeof capturedMemId !== 'string' ||
      capturedMemId.trim() === '' ||
      capturedMemId !== capturedMemId.trim()
    ) {
      return { valid: false };
    }

    if (
      typeof capturedAgencyId !== 'string' ||
      capturedAgencyId.trim() === '' ||
      capturedAgencyId !== capturedAgencyId.trim()
    ) {
      return { valid: false };
    }

    if (capturedType !== 'OWNER' && capturedType !== 'MEMBER') {
      return { valid: false };
    }

    if (capturedStatus !== 'ACTIVE') {
      return { valid: false };
    }

    if (
      typeof capturedPermVer !== 'number' ||
      !Number.isInteger(capturedPermVer) ||
      capturedPermVer < 1
    ) {
      return { valid: false };
    }

    // Duplicate membership ID check
    if (seenMembershipIds.has(capturedMemId)) {
      return { valid: false };
    }
    seenMembershipIds.add(capturedMemId);

    // Duplicate agency ID check (aynı acente için birden fazla/çakışan üyelik engeli)
    if (seenAgencyIds.has(capturedAgencyId)) {
      return { valid: false };
    }
    seenAgencyIds.add(capturedAgencyId);

    canonicalMemberships.push(
      Object.freeze({
        id: capturedMemId,
        agencyId: capturedAgencyId,
        type: capturedType,
        status: 'ACTIVE',
        permissionVersion: capturedPermVer,
      }),
    );
  }

  // Arayan nesnelerinden tamamen izole, bağımsız ve dondurulmuş kanonik bağlam
  const snapshot: AuthenticatedUserContext = Object.freeze({
    userId: capturedUserId,
    identityId: capturedIdentityId,
    ...(canonicalEmail ? { email: canonicalEmail } : {}),
    assurance: capturedAssurance,
    memberships: Object.freeze(canonicalMemberships),
  });

  return { valid: true, ctx: snapshot };
}

const FORBIDDEN_RESOURCE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Değerleri ilk await öncesinde özyinelemeli olarak bağımsız, derinlemesine
 * dondurulmuş (detached deeply-immutable) kanonik anlık görüntüye dönüştürür.
 */
function createDetachedValueSnapshot(
  val: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): { valid: true; snapshot: unknown } | { valid: false } {
  if (depth > 10) {
    return { valid: false };
  }

  if (val === undefined || val === null) {
    return { valid: true, snapshot: val };
  }

  if (typeof val === 'string' || typeof val === 'boolean') {
    return { valid: true, snapshot: val };
  }

  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      return { valid: false };
    }
    return { valid: true, snapshot: val };
  }

  // Fonksiyonlar, semboller, bigint desteklenmez -> fail closed
  if (typeof val !== 'object') {
    return { valid: false };
  }

  // Döngüsel referans kontrolü
  if (seen.has(val)) {
    return { valid: false };
  }
  seen.add(val);

  let valueIsArray: boolean;
  try {
    valueIsArray = Array.isArray(val);
  } catch {
    return { valid: false };
  }

  if (valueIsArray) {
    const arrayValue = val as unknown[];
    let arrLen: number;
    try {
      arrLen = arrayValue.length;
    } catch {
      return { valid: false };
    }

    if (typeof arrLen !== 'number' || !Number.isInteger(arrLen) || arrLen < 0 || arrLen > 1000) {
      return { valid: false };
    }

    const arrCopy: unknown[] = [];
    try {
      for (let i = 0; i < arrLen; i++) {
        const elem = arrayValue[i];
        const detachedElem = createDetachedValueSnapshot(elem, depth + 1, seen);
        if (!detachedElem.valid) {
          return { valid: false };
        }
        arrCopy.push(detachedElem.snapshot);
      }
    } catch {
      return { valid: false };
    }

    if (arrCopy.length !== arrLen) {
      return { valid: false };
    }

    return { valid: true, snapshot: Object.freeze(arrCopy) };
  }

  // Yalnızca düz nesneler kabul edilir; getPrototypeOf trap fırlatırsa yakalanıp fail-closed döner
  let proto: unknown;
  try {
    proto = Object.getPrototypeOf(val);
  } catch {
    return { valid: false };
  }

  if (proto !== Object.prototype && proto !== null) {
    return { valid: false };
  }

  let keys: string[];
  try {
    keys = Object.keys(val);
  } catch {
    return { valid: false };
  }

  const targetObj: Record<string, unknown> = Object.create(null);

  for (const key of keys) {
    if (FORBIDDEN_RESOURCE_KEYS.has(key)) {
      return { valid: false };
    }

    let propVal: unknown;
    try {
      propVal = (val as Record<string, unknown>)[key];
    } catch {
      return { valid: false };
    }

    const detachedProp = createDetachedValueSnapshot(propVal, depth + 1, seen);
    if (!detachedProp.valid) {
      return { valid: false };
    }
    targetObj[key] = detachedProp.snapshot;
  }

  return { valid: true, snapshot: Object.freeze(targetObj) };
}

/**
 * Kaynak nesnesini ilk await öncesinde özyinelemeli olarak bağımsız, derinlemesine
 * dondurulmuş bir kanonik anlık görüntüye (detached deeply-immutable snapshot) dönüştürür (Finding 2).
 *
 * KRİTİK GÜVENLİK İNVARYANTLARI:
 * 1. Her özellik ve dizi uzunluğu tam olarak BİR KEZ okunur.
 * 2. Fırlatan getter/erişimciler, prototype trap'leri, döngüsel (cyclic) yapılar ve
 *    desteklenmeyen değerler (fonksiyon, sembol, bigint) fail-closed olarak reddedilir.
 * 3. Çözümleyicilere asla arayan kontrollü nesne referansı iletilmez; yalnızca bu güvenilir snapshot iletilir.
 */
function createDetachedResourceSnapshot(
  rawResource: unknown,
): { valid: true; snapshot: Record<string, unknown> } | { valid: false } {
  if (!isNonArrayObject(rawResource)) {
    return { valid: false };
  }

  const result = createDetachedValueSnapshot(rawResource, 0, new Set());
  if (
    !result.valid ||
    typeof result.snapshot !== 'object' ||
    result.snapshot === null ||
    Array.isArray(result.snapshot)
  ) {
    return { valid: false };
  }

  return { valid: true, snapshot: result.snapshot as Record<string, unknown> };
}

type CanonicalLifecycleRow = Readonly<{
  identityId: string;
  identityStatus: string;
  userId: string;
  userStatus: string;
  membershipId: string;
  membershipStatus: string;
  membershipType: string;
  permissionVersion: number;
  agencyId: string;
  agencyStatus: string;
}>;

type CanonicalPermissionGrantRow = Readonly<{
  id: string;
  membershipId: string;
  permissionCode: string;
  scope: string;
}>;

function createD1ResultsSnapshot(
  queryResult: unknown,
): { valid: true; rows: readonly unknown[] } | { valid: false } {
  try {
    if (!queryResult || typeof queryResult !== 'object' || Array.isArray(queryResult)) {
      return { valid: false };
    }
  } catch {
    return { valid: false };
  }

  let success: unknown;
  let rawResults: unknown;
  try {
    const envelope = queryResult as Record<string, unknown>;
    success = envelope.success;
    rawResults = envelope.results;
  } catch {
    return { valid: false };
  }

  let resultsAreArray: boolean;
  try {
    resultsAreArray = Array.isArray(rawResults);
  } catch {
    return { valid: false };
  }
  if (success !== true || !resultsAreArray) {
    return { valid: false };
  }
  const resultRows = rawResults as unknown[];

  let length: number;
  try {
    length = resultRows.length;
  } catch {
    return { valid: false };
  }

  if (!Number.isSafeInteger(length) || length < 0) {
    return { valid: false };
  }

  const rows: unknown[] = [];
  try {
    for (let index = 0; index < length; index++) {
      rows.push(resultRows[index]);
    }
  } catch {
    return { valid: false };
  }

  return { valid: true, rows: Object.freeze(rows) };
}

function createLifecycleRowSnapshot(
  rawRow: unknown,
): { valid: true; row: CanonicalLifecycleRow } | { valid: false } {
  try {
    if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
      return { valid: false };
    }
  } catch {
    return { valid: false };
  }

  let identityId: unknown;
  let identityStatus: unknown;
  let userId: unknown;
  let userStatus: unknown;
  let membershipId: unknown;
  let membershipStatus: unknown;
  let membershipType: unknown;
  let permissionVersion: unknown;
  let agencyId: unknown;
  let agencyStatus: unknown;
  try {
    const row = rawRow as Record<string, unknown>;
    identityId = row.identity_id;
    identityStatus = row.identity_status;
    userId = row.user_id;
    userStatus = row.user_status;
    membershipId = row.membership_id;
    membershipStatus = row.membership_status;
    membershipType = row.membership_type;
    permissionVersion = row.permission_version;
    agencyId = row.agency_id;
    agencyStatus = row.agency_status;
  } catch {
    return { valid: false };
  }

  if (
    typeof identityId !== 'string' ||
    typeof identityStatus !== 'string' ||
    typeof userId !== 'string' ||
    typeof userStatus !== 'string' ||
    typeof membershipId !== 'string' ||
    typeof membershipStatus !== 'string' ||
    typeof membershipType !== 'string' ||
    typeof permissionVersion !== 'number' ||
    !Number.isInteger(permissionVersion) ||
    permissionVersion < 1 ||
    typeof agencyId !== 'string' ||
    typeof agencyStatus !== 'string'
  ) {
    return { valid: false };
  }

  return {
    valid: true,
    row: Object.freeze({
      identityId,
      identityStatus,
      userId,
      userStatus,
      membershipId,
      membershipStatus,
      membershipType,
      permissionVersion,
      agencyId,
      agencyStatus,
    }),
  };
}

function createPermissionGrantRowSnapshot(
  rawRow: unknown,
): { valid: true; row: CanonicalPermissionGrantRow } | { valid: false } {
  try {
    if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
      return { valid: false };
    }
  } catch {
    return { valid: false };
  }

  let id: unknown;
  let membershipId: unknown;
  let permissionCode: unknown;
  let scope: unknown;
  try {
    const row = rawRow as Record<string, unknown>;
    id = row.id;
    membershipId = row.membership_id;
    permissionCode = row.permission_code;
    scope = row.scope;
  } catch {
    return { valid: false };
  }

  if (
    typeof id !== 'string' ||
    id.trim() === '' ||
    typeof membershipId !== 'string' ||
    typeof permissionCode !== 'string' ||
    permissionCode.trim() === '' ||
    typeof scope !== 'string'
  ) {
    return { valid: false };
  }

  return {
    valid: true,
    row: Object.freeze({ id, membershipId, permissionCode, scope }),
  };
}

/**
 * Canlı veritabanı durumu üzerinden AuthIdentity, User, AgencyMembership ve Agency
 * varlığını, alan türlerini, ilişki kimliklerini ve güncel permission_version eşleşmesini
 * fail-closed doğrular (I-01 & I-05).
 */
async function verifyLiveLifecycle(
  db: D1Database,
  identityId: string,
  userId: string,
  membershipId: string,
  agencyId: string,
  expectedType: 'OWNER' | 'MEMBER',
  expectedPermissionVersion: number,
): Promise<{ success: true } | { success: false; reason: AuthorizationReasonCode }> {
  if (!hasCallablePrepare(db)) {
    return { success: false, reason: 'DATABASE_ERROR' };
  }

  let queryResult: unknown;
  try {
    const stmt = db.prepare(`
      SELECT
        ai.id AS identity_id,
        ai.status AS identity_status,
        u.id AS user_id,
        u.status AS user_status,
        m.id AS membership_id,
        m.status AS membership_status,
        m.type AS membership_type,
        m.permission_version AS permission_version,
        a.id AS agency_id,
        a.status AS agency_status
      FROM agency_memberships m
      INNER JOIN users u ON m.user_id = u.id
      INNER JOIN agencies a ON m.agency_id = a.id
      INNER JOIN auth_identities ai ON ai.user_id = u.id AND ai.id = ?
      WHERE m.id = ? AND m.agency_id = ? AND m.user_id = ?
    `);
    queryResult = await stmt.bind(identityId, membershipId, agencyId, userId).all();
  } catch {
    return { success: false, reason: 'DATABASE_ERROR' };
  }

  const resultSnapshot = createD1ResultsSnapshot(queryResult);
  if (!resultSnapshot.valid) {
    return { success: false, reason: 'DATABASE_ERROR' };
  }

  // Satır sayısı kontrolleri
  if (resultSnapshot.rows.length === 0) {
    return { success: false, reason: 'INVALID_CONTEXT' };
  }

  if (resultSnapshot.rows.length !== 1) {
    return { success: false, reason: 'DATABASE_ERROR' };
  }

  const lifecycleSnapshot = createLifecycleRowSnapshot(resultSnapshot.rows[0]);
  if (!lifecycleSnapshot.valid) {
    return { success: false, reason: 'DATABASE_ERROR' };
  }
  const r = lifecycleSnapshot.row;

  // İlişki kimliklerini ve üyelik türünü güvenilir bağlam girdileriyle birebir karşılaştır (I-05.3)
  if (
    r.identityId !== identityId ||
    r.userId !== userId ||
    r.membershipId !== membershipId ||
    r.agencyId !== agencyId ||
    r.membershipType !== expectedType
  ) {
    return { success: false, reason: 'INVALID_CONTEXT' };
  }

  // Durum kontrolleri
  if (r.identityStatus !== 'ACTIVE') {
    return { success: false, reason: 'INVALID_CONTEXT' };
  }

  if (r.userStatus !== 'ACTIVE') {
    return { success: false, reason: 'USER_INACTIVE' };
  }

  if (r.agencyStatus !== 'ACTIVE') {
    return { success: false, reason: 'INVALID_CONTEXT' };
  }

  if (r.membershipStatus !== 'ACTIVE') {
    return { success: false, reason: 'MEMBERSHIP_INACTIVE' };
  }

  // İzin sürümü kontrolü
  if (r.permissionVersion !== expectedPermissionVersion) {
    return { success: false, reason: 'MEMBERSHIP_INACTIVE' };
  }

  return { success: true };
}

/**
 * D1 üzerinden üyelik izinlerini sorgular ve dönen zarf/satır yapısını fail-closed doğrular (Finding 3).
 *
 * KRİTİK GÜVENLİK İNVARYANTLARI (RG-00 C & D):
 * 1. OWNER için bilinen NORMAL satırları (bozuk kapsamlı olanlar dahil) tamamen yok sayılır (ignored).
 * 2. Bilinmeyen açık satırlar (unknown rows) fail-closed ret üretir (UNKNOWN_PERMISSION).
 * 3. OWNER'ın tüm açık SENSITIVE izinleri ve bunların bağımlılık kapanımı doğrulanır:
 *    - SENSITIVE bağımlılıklar açıkça mevcut ve kapsam açısından geçerli olmalıdır.
 *    - NORMAL bağımlılıklar OWNER için örtük AGENCY kabul edilir.
 *    - Eksik hassas bağımlılık durumunda derhal fail-closed DENY (DEPENDENCY_MISSING) üretilir.
 */
async function loadAndValidateMembershipPermissions(
  db: D1Database,
  membershipId: string,
  membershipType: 'OWNER' | 'MEMBER',
): Promise<
  | { success: true; grants: Map<string, { id: string; scope: EffectiveScope }> }
  | { success: false; reason: AuthorizationReasonCode }
> {
  if (!hasCallablePrepare(db)) {
    return { success: false, reason: 'DATABASE_ERROR' };
  }

  let queryResult: unknown;
  try {
    const stmt = db.prepare(`
      SELECT id, membership_id, permission_code, scope
      FROM membership_permissions
      WHERE membership_id = ?
    `);
    queryResult = await stmt.bind(membershipId).all<RawPermissionGrantRow>();
  } catch {
    return { success: false, reason: 'DATABASE_ERROR' };
  }

  const resultSnapshot = createD1ResultsSnapshot(queryResult);
  if (!resultSnapshot.valid) {
    return { success: false, reason: 'DATABASE_ERROR' };
  }

  const grants = new Map<string, { id: string; scope: EffectiveScope }>();

  for (const rawRow of resultSnapshot.rows) {
    const grantSnapshot = createPermissionGrantRowSnapshot(rawRow);
    if (!grantSnapshot.valid) {
      return { success: false, reason: 'DATABASE_ERROR' };
    }
    const r = grantSnapshot.row;
    if (r.membershipId !== membershipId) {
      return { success: false, reason: 'DATABASE_ERROR' };
    }

    // 1. Bilinmeyen izin kodu kontrolü (Unknown explicit rows fail closed)
    const descriptor = getPermissionDefinition(r.permissionCode);
    if (!descriptor) {
      return { success: false, reason: 'UNKNOWN_PERMISSION' };
    }

    // RG-00 C/D: OWNER için bilinen NORMAL satırları yok sayılır
    if (membershipType === 'OWNER') {
      if (descriptor.classification === 'NORMAL') {
        continue;
      }
    }

    // 2. Kapsam doğrulaması
    if (r.scope !== 'UNSCOPED' && r.scope !== 'ASSIGNED' && r.scope !== 'AGENCY') {
      return { success: false, reason: 'INVALID_STORED_SCOPE' };
    }

    // 3. Yinelenen izin kontrolü
    if (grants.has(r.permissionCode)) {
      return { success: false, reason: 'DATABASE_ERROR' };
    }

    // 4. Saklanan kapsam uyumluluğu kontrolü
    if (descriptor.scopeKind === 'UNSCOPED') {
      if (r.scope !== 'UNSCOPED') {
        return { success: false, reason: 'INVALID_STORED_SCOPE' };
      }
    } else {
      // RECORD_SCOPED
      if (r.scope !== 'ASSIGNED' && r.scope !== 'AGENCY') {
        return { success: false, reason: 'INVALID_STORED_SCOPE' };
      }
    }

    grants.set(r.permissionCode, Object.freeze({ id: r.id, scope: r.scope as EffectiveScope }));
  }

  // 5. MEMBER için tüm izin kümesinin bağımlılık ve kapsam hiyerarşisi doğrulaması
  if (membershipType === 'MEMBER') {
    for (const [code, grant] of grants.entries()) {
      const def = getPermissionDefinition(code)!;
      for (const depCode of def.dependencies) {
        const depGrant = grants.get(depCode);
        if (!depGrant) {
          return { success: false, reason: 'DEPENDENCY_MISSING' };
        }

        const depDef = getPermissionDefinition(depCode);
        if (!depDef) {
          return { success: false, reason: 'DEPENDENCY_INVALID' };
        }

        if (def.scopeKind === 'RECORD_SCOPED' && depDef.scopeKind === 'RECORD_SCOPED') {
          if (scopeWeight(depGrant.scope) < scopeWeight(grant.scope)) {
            return { success: false, reason: 'DEPENDENCY_SCOPE_TOO_NARROW' };
          }
        }
      }
    }
  }

  // 6. OWNER için açık SENSITIVE izinlerin yapısal geçerliliği ve bağımlılık kapanımı doğrulaması (Finding 3)
  if (membershipType === 'OWNER') {
    for (const [code, grant] of grants.entries()) {
      const def = getPermissionDefinition(code)!;
      for (const depCode of def.dependencies) {
        const depDef = getPermissionDefinition(depCode);
        if (!depDef) {
          return { success: false, reason: 'DEPENDENCY_INVALID' };
        }

        if (depDef.classification === 'SENSITIVE') {
          const depGrant = grants.get(depCode);
          if (!depGrant) {
            return { success: false, reason: 'DEPENDENCY_MISSING' };
          }

          if (def.scopeKind === 'RECORD_SCOPED' && depDef.scopeKind === 'RECORD_SCOPED') {
            if (scopeWeight(depGrant.scope) < scopeWeight(grant.scope)) {
              return { success: false, reason: 'DEPENDENCY_SCOPE_TOO_NARROW' };
            }
          }
        } else {
          // NORMAL bağımlılıklar OWNER için örtük AGENCY kabul edilir (RG-00 B & D)
        }
      }
    }
  }

  return { success: true, grants };
}

/**
 * Eylemin gerektirdiği tüm izinleri ve bağımlılık kapanımını katalogdan özyinelemeli toplar.
 */
function collectPermissionGraph(
  actionDef: ActionDefinition,
):
  | { valid: true; graph: Map<string, PermissionDefinition> }
  | { valid: false; reason: AuthorizationReasonCode } {
  const graph = new Map<string, PermissionDefinition>();

  const queue = [...actionDef.requiredNormalPermissions, ...actionDef.requiredSensitivePermissions];

  while (queue.length > 0) {
    const code = queue.shift()!;
    if (graph.has(code)) continue;

    const desc = getPermissionDefinition(code);
    if (!desc) {
      return { valid: false, reason: 'UNKNOWN_PERMISSION' };
    }

    if (
      (desc.classification !== 'NORMAL' && desc.classification !== 'SENSITIVE') ||
      (desc.scopeKind !== 'UNSCOPED' && desc.scopeKind !== 'RECORD_SCOPED') ||
      (desc.assurance !== 'NORMAL_SESSION' && desc.assurance !== 'SECURE_GRANT')
    ) {
      return { valid: false, reason: 'MISSING_CATALOG_METADATA' };
    }

    graph.set(code, desc);

    for (const depCode of desc.dependencies) {
      if (!graph.has(depCode)) {
        queue.push(depCode);
      }
    }
  }

  return { valid: true, graph };
}

/**
 * Merkezi Fail-Closed Çalışma Zamanı Yetkilendirme Fonksiyonu.
 */
export async function evaluateAuthorization(
  db: D1Database,
  request: AuthorizationRequest,
  options?: AuthorizationOptions,
): Promise<AuthorizationResult> {
  let stableDb: D1Database;
  try {
    stableDb = createDatabaseAdapterSnapshot(db);
  } catch {
    return deny('DATABASE_ERROR');
  }

  let stableResolvers: ScopeResolverRegistry;
  try {
    stableResolvers = createScopeResolverSnapshot(options?.resolvers);
  } catch {
    return deny('UNKNOWN_SCOPE_RESOLVER');
  }

  // 1. Girdi ve İstek Doğrulaması (Fail-Closed)
  if (!isNonArrayObject(request)) {
    return deny('MALFORMED_INPUT');
  }

  // 2. Güvenilmez İstek Alanlarının Tek Seferde Savunmacı Yakalanması (Defensive Minimal Snapshot)
  let capturedContext: unknown;
  let capturedAction: unknown;
  let capturedPermissionCode: unknown;
  let capturedAgencyId: unknown;
  let capturedResource: unknown;
  let capturedSecureGrantBinding: unknown;

  try {
    const reqRecord = request as unknown as Record<string, unknown>;
    capturedContext = reqRecord.context;
    capturedAction = reqRecord.action;
    capturedPermissionCode = reqRecord.permissionCode;
    capturedAgencyId = reqRecord.agencyId;
    capturedResource = reqRecord.resource;
    capturedSecureGrantBinding = reqRecord.secureGrantBinding;
  } catch {
    return deny('MALFORMED_INPUT');
  }

  // Güvenlik Onayı Zarfı (Secure Grant Binding) İlk Await Öncesinde Snapshot ve Doğrulama
  let bindingProvided = false;
  let bindingMalformed = false;
  let bindingEvidence: string | undefined;
  let bindingPayloadCanonical: string | undefined;
  let bindingTargetIds: string[] | undefined;
  let bindingExpectedTargetVersion: number | null | undefined;

  if (capturedSecureGrantBinding !== undefined && capturedSecureGrantBinding !== null) {
    bindingProvided = true;
    if (!isNonArrayObject(capturedSecureGrantBinding)) {
      bindingMalformed = true;
    } else {
      try {
        const evidenceDescriptor = Object.getOwnPropertyDescriptor(
          capturedSecureGrantBinding,
          'evidence',
        );
        const payloadDescriptor = Object.getOwnPropertyDescriptor(
          capturedSecureGrantBinding,
          'payload',
        );
        const targetIdsDescriptor = Object.getOwnPropertyDescriptor(
          capturedSecureGrantBinding,
          'targetIds',
        );
        const versionDescriptor = Object.getOwnPropertyDescriptor(
          capturedSecureGrantBinding,
          'expectedTargetVersion',
        );

        if (
          !evidenceDescriptor ||
          !('value' in evidenceDescriptor) ||
          typeof evidenceDescriptor.value !== 'string' ||
          evidenceDescriptor.value.trim().length === 0
        ) {
          bindingMalformed = true;
        } else {
          bindingEvidence = evidenceDescriptor.value.trim();
        }

        if (!payloadDescriptor || !('value' in payloadDescriptor)) {
          bindingMalformed = true;
        } else {
          bindingPayloadCanonical = canonicalizePayload(payloadDescriptor.value);
        }

        if (
          !targetIdsDescriptor ||
          !('value' in targetIdsDescriptor) ||
          !Array.isArray(targetIdsDescriptor.value) ||
          targetIdsDescriptor.value.length === 0
        ) {
          bindingMalformed = true;
        } else {
          const targetIds = targetIdsDescriptor.value;
          bindingTargetIds = [];
          const seen = new Set<string>();
          for (let index = 0; index < targetIds.length; index += 1) {
            const itemDescriptor = Object.getOwnPropertyDescriptor(targetIds, String(index));
            if (!itemDescriptor || !('value' in itemDescriptor)) {
              bindingMalformed = true;
              break;
            }
            const item = itemDescriptor.value;
            if (
              typeof item !== 'string' ||
              item.trim().length === 0 ||
              item !== item.trim() ||
              seen.has(item)
            ) {
              bindingMalformed = true;
              break;
            }
            seen.add(item);
            bindingTargetIds.push(item);
          }
        }

        if (!versionDescriptor || !('value' in versionDescriptor)) {
          bindingMalformed = true;
        } else if (versionDescriptor.value === null) {
          bindingExpectedTargetVersion = null;
        } else if (
          typeof versionDescriptor.value === 'number' &&
          Number.isInteger(versionDescriptor.value) &&
          versionDescriptor.value >= 0
        ) {
          bindingExpectedTargetVersion = versionDescriptor.value;
        } else {
          bindingMalformed = true;
        }
      } catch {
        bindingMalformed = true;
      }
    }
  }

  // request nesnesi bundan sonra ASLA tekrar okunmaz veya başvurulmaz!

  // 3. Kullanıcı Bağlamı Doğrulaması (Context Detached Snapshot - Finding 1)
  const contextValidation = validateAuthenticatedUserContext(capturedContext);
  if (!contextValidation.valid) {
    return deny('INVALID_CONTEXT');
  }
  const userContext = contextValidation.ctx;

  // 4. Eylem Kodu Çözümlemesi (Action Registry Boundary - BLOCKER-1)
  const rawActionCode = capturedAction !== undefined ? capturedAction : capturedPermissionCode;
  if (capturedAction !== undefined && capturedPermissionCode !== undefined) {
    if (capturedAction !== capturedPermissionCode) {
      return deny('MALFORMED_INPUT');
    }
  }

  if (
    typeof rawActionCode !== 'string' ||
    !CANONICAL_CODE_REGEX.test(rawActionCode) ||
    rawActionCode !== rawActionCode.trim()
  ) {
    return deny('MALFORMED_INPUT');
  }

  let actionDef: ActionDefinition;
  try {
    const activeActions = options?.actions ?? DEFAULT_ACTION_REGISTRY;
    if (!activeActions || typeof (activeActions as { get?: unknown }).get !== 'function') {
      return deny('UNKNOWN_ACTION');
    }

    const rawActionDef = (activeActions as { get: (code: string) => unknown }).get(rawActionCode);
    if (!rawActionDef) {
      if (capturedPermissionCode !== undefined && !getPermissionDefinition(rawActionCode)) {
        return deny('UNKNOWN_PERMISSION');
      }
      return deny('UNKNOWN_ACTION');
    }

    const actionValidation = validateActionDefinitionInternal(rawActionDef, rawActionCode);
    if (!actionValidation.valid) {
      return deny('UNKNOWN_ACTION');
    }
    actionDef = actionValidation.action;
  } catch {
    return deny('UNKNOWN_ACTION');
  }

  // Defense-in-depth eylem yetki düzeyi denetimi (Finding 4)
  if (
    actionDef.authority !== 'MEMBERSHIP_AUTHORIZED' &&
    actionDef.authority !== 'OWNER_ONLY' &&
    actionDef.authority !== 'PROVISIONING_ONLY'
  ) {
    return deny('UNKNOWN_ACTION');
  }

  let requiresSecureGrant = actionDef.assurance === 'SECURE_GRANT';

  // Gerekli izin grafiğini katalog üzerinden topla
  const graphResult = collectPermissionGraph(actionDef);
  if (!graphResult.valid) {
    return deny(graphResult.reason);
  }
  const graph = graphResult.graph;

  // Grafikte SECURE_GRANT gerektiren herhangi bir izin varsa
  for (const desc of graph.values()) {
    if (desc.assurance === 'SECURE_GRANT') {
      requiresSecureGrant = true;
      break;
    }
  }

  if (requiresSecureGrant) {
    if (!bindingProvided) {
      return deny('SECURE_GRANT_REQUIRED');
    }
    if (
      bindingMalformed ||
      !bindingEvidence ||
      bindingPayloadCanonical === undefined ||
      bindingTargetIds === undefined ||
      bindingExpectedTargetVersion === undefined
    ) {
      return deny('MALFORMED_INPUT');
    }
  }

  // 5. Hedef Acente ve Kaynak Doğrulaması (Resource Detached Snapshot - Finding 2)
  let targetAgencyId: string | undefined;

  if (capturedAgencyId !== undefined) {
    if (
      typeof capturedAgencyId !== 'string' ||
      capturedAgencyId === '' ||
      capturedAgencyId !== capturedAgencyId.trim()
    ) {
      return deny('MALFORMED_INPUT');
    }
    targetAgencyId = capturedAgencyId;
  }

  let resourceSnapshot: Record<string, unknown> | undefined;

  if (capturedResource !== undefined) {
    const snapshotResult = createDetachedResourceSnapshot(capturedResource);
    if (!snapshotResult.valid) {
      return deny('MALFORMED_INPUT');
    }
    resourceSnapshot = snapshotResult.snapshot;

    if (resourceSnapshot.agencyId !== undefined) {
      if (
        typeof resourceSnapshot.agencyId !== 'string' ||
        resourceSnapshot.agencyId === '' ||
        resourceSnapshot.agencyId !== resourceSnapshot.agencyId.trim()
      ) {
        return deny('MALFORMED_INPUT');
      }
      if (targetAgencyId !== undefined && resourceSnapshot.agencyId !== targetAgencyId) {
        return deny('AGENCY_MISMATCH');
      }
      targetAgencyId = resourceSnapshot.agencyId;
    }
  }

  if (!targetAgencyId) {
    if (userContext.memberships.length === 1) {
      targetAgencyId = userContext.memberships[0]!.agencyId;
    } else {
      return deny('MALFORMED_INPUT');
    }
  }

  // Hedef acentedeki tekil üyeliği bul (IMPORTANT-2: never use .find() first match)
  const matchingMemberships = userContext.memberships.filter((m) => m.agencyId === targetAgencyId);
  if (matchingMemberships.length !== 1) {
    if (matchingMemberships.length === 0) {
      return deny('MEMBERSHIP_NOT_FOUND');
    }
    return deny('INVALID_CONTEXT');
  }
  const activeMembership = matchingMemberships[0]!;

  // Kaynak verilmişse acente sınırını yakalanan meta veri üzerinden kesin olarak doğrula
  if (resourceSnapshot) {
    if (
      typeof resourceSnapshot.agencyId !== 'string' ||
      resourceSnapshot.agencyId !== targetAgencyId
    ) {
      return deny('AGENCY_MISMATCH');
    }
  }

  // 6. Canlı Yaşam Döngüsü ve İlişki Doğrulaması (I-01 & I-05)
  const lifecycleResult = await verifyLiveLifecycle(
    stableDb,
    userContext.identityId,
    userContext.userId,
    activeMembership.id,
    targetAgencyId,
    activeMembership.type,
    activeMembership.permissionVersion,
  );
  if (!lifecycleResult.success) {
    return deny(lifecycleResult.reason);
  }

  // 6.b SensitiveActionGrant Preflight Doğrulaması (RG-00 & M1-T09)
  if (requiresSecureGrant) {
    let computedPayloadHash: string;
    try {
      const payloadBytes = new TextEncoder().encode(bindingPayloadCanonical!);
      const payloadDigest = await crypto.subtle.digest('SHA-256', payloadBytes);
      computedPayloadHash = Array.from(new Uint8Array(payloadDigest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      return deny('MALFORMED_INPUT');
    }

    let canonicalTargetsJson: string;
    try {
      canonicalTargetsJson = canonicalizeTargetIds(bindingTargetIds!);
    } catch {
      return deny('MALFORMED_INPUT');
    }

    const presentedEvidenceHash = await computeEvidenceHash(bindingEvidence!);

    let grantRow: Record<string, unknown> | undefined;
    try {
      const query = `
        SELECT id, evidence_hash, agency_id, actor_user_id, actor_membership_id, action,
               payload_hash, target_ids_json, expected_target_version, permission_version,
               assurance, status, issued_at, expires_at, consumed_at, revoked_at, consumed_operation_id
        FROM sensitive_action_grants
        WHERE evidence_hash = ?
      `;
      grantRow =
        (await stableDb
          .prepare(query)
          .bind(presentedEvidenceHash)
          .first<Record<string, unknown>>()) ?? undefined;
    } catch {
      return deny('DATABASE_ERROR');
    }

    if (!grantRow) {
      return deny('SECURE_GRANT_REQUIRED');
    }

    // Coercion içermeyen kesin tip ve durum denetimleri
    if (
      typeof grantRow.id !== 'string' ||
      typeof grantRow.evidence_hash !== 'string' ||
      typeof grantRow.agency_id !== 'string' ||
      typeof grantRow.actor_user_id !== 'string' ||
      typeof grantRow.actor_membership_id !== 'string' ||
      typeof grantRow.action !== 'string' ||
      typeof grantRow.payload_hash !== 'string' ||
      typeof grantRow.target_ids_json !== 'string' ||
      typeof grantRow.permission_version !== 'number' ||
      typeof grantRow.assurance !== 'string' ||
      typeof grantRow.status !== 'string' ||
      typeof grantRow.issued_at !== 'string' ||
      typeof grantRow.expires_at !== 'string'
    ) {
      return deny('SECURE_GRANT_REQUIRED');
    }

    if (grantRow.evidence_hash !== presentedEvidenceHash) {
      return deny('SECURE_GRANT_REQUIRED');
    }
    if (grantRow.status !== 'ISSUED') {
      return deny('SECURE_GRANT_REQUIRED');
    }
    if (grantRow.assurance !== 'SECURE_GRANT') {
      return deny('SECURE_GRANT_REQUIRED');
    }
    if (grantRow.revoked_at !== null && grantRow.revoked_at !== undefined) {
      return deny('SECURE_GRANT_REQUIRED');
    }
    if (grantRow.consumed_at !== null && grantRow.consumed_at !== undefined) {
      return deny('SECURE_GRANT_REQUIRED');
    }
    if (grantRow.consumed_operation_id !== null && grantRow.consumed_operation_id !== undefined) {
      return deny('SECURE_GRANT_REQUIRED');
    }
    if (grantRow.agency_id !== targetAgencyId) {
      return deny('SECURE_GRANT_REQUIRED');
    }
    if (grantRow.actor_user_id !== userContext.userId) {
      return deny('SECURE_GRANT_REQUIRED');
    }
    if (grantRow.actor_membership_id !== activeMembership.id) {
      return deny('SECURE_GRANT_REQUIRED');
    }
    if (grantRow.action !== rawActionCode) {
      return deny('SECURE_GRANT_REQUIRED');
    }
    if (grantRow.payload_hash !== computedPayloadHash) {
      return deny('SECURE_GRANT_REQUIRED');
    }
    if (grantRow.target_ids_json !== canonicalTargetsJson) {
      return deny('SECURE_GRANT_REQUIRED');
    }

    if (bindingExpectedTargetVersion === null) {
      if (
        grantRow.expected_target_version !== null &&
        grantRow.expected_target_version !== undefined
      ) {
        return deny('SECURE_GRANT_REQUIRED');
      }
    } else {
      if (
        typeof grantRow.expected_target_version !== 'number' ||
        grantRow.expected_target_version !== bindingExpectedTargetVersion
      ) {
        return deny('SECURE_GRANT_REQUIRED');
      }
    }

    if (grantRow.permission_version !== activeMembership.permissionVersion) {
      return deny('SECURE_GRANT_REQUIRED');
    }

    const issuedAtMs = new Date(grantRow.issued_at).getTime();
    const expiresAtMs = new Date(grantRow.expires_at).getTime();
    if (
      !Number.isFinite(issuedAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      issuedAtMs <= 0 ||
      expiresAtMs <= issuedAtMs
    ) {
      return deny('SECURE_GRANT_REQUIRED');
    }

    const grantTtlSec = (expiresAtMs - issuedAtMs) / 1000;
    if (grantTtlSec < 1 || grantTtlSec > 180) {
      return deny('SECURE_GRANT_REQUIRED');
    }

    const nowMs = Date.now();
    if (nowMs < issuedAtMs || nowMs >= expiresAtMs) {
      return deny('SECURE_GRANT_REQUIRED');
    }
  }

  // 7. Eylem Yetki Düzeyi Denetimi (Action Authority Check - Finding 4)
  if (actionDef.authority === 'PROVISIONING_ONLY') {
    return deny('PROVISIONING_NOT_ALLOWED');
  }

  if (actionDef.authority === 'OWNER_ONLY') {
    if (activeMembership.type !== 'OWNER') {
      return deny('OWNER_REQUIRED');
    }
  }

  // 8. Yetki ve Kapsam Değerlendirmesi (BLOCKER-1 & IMPORTANT-1)
  const effectiveScopeMap = new Map<string, EffectiveScope>();

  const hasSensitiveInGraph = Array.from(graph.values()).some(
    (d) => d.classification === 'SENSITIVE',
  );

  if (activeMembership.type === 'MEMBER') {
    // MEMBER için D1'deki saklanan tüm izin kümesini yükle ve doğrula
    const dbResult = await loadAndValidateMembershipPermissions(
      stableDb,
      activeMembership.id,
      'MEMBER',
    );
    if (!dbResult.success) {
      return deny(dbResult.reason);
    }
    const grantsMap = dbResult.grants;

    for (const [code, desc] of graph.entries()) {
      const grant = grantsMap.get(code);
      if (!grant) {
        return deny('PERMISSION_NOT_GRANTED');
      }

      if (desc.scopeKind === 'UNSCOPED') {
        if (grant.scope !== 'UNSCOPED') {
          return deny('INVALID_STORED_SCOPE');
        }
        effectiveScopeMap.set(code, 'UNSCOPED');
      } else {
        if (grant.scope !== 'ASSIGNED' && grant.scope !== 'AGENCY') {
          return deny('INVALID_STORED_SCOPE');
        }
        effectiveScopeMap.set(code, grant.scope);
      }
    }
  } else {
    // OWNER:
    // 1. Normal operasyonel izinler örtüktür
    for (const [code, desc] of graph.entries()) {
      if (desc.classification === 'NORMAL') {
        effectiveScopeMap.set(code, desc.scopeKind === 'UNSCOPED' ? 'UNSCOPED' : 'AGENCY');
      }
    }

    // 2. Hassas izinler açık D1 kaydı gerektirir (Finding 3)
    if (hasSensitiveInGraph) {
      const dbResult = await loadAndValidateMembershipPermissions(
        stableDb,
        activeMembership.id,
        'OWNER',
      );
      if (!dbResult.success) {
        return deny(dbResult.reason);
      }
      const ownerGrantsMap = dbResult.grants;

      for (const [code, desc] of graph.entries()) {
        if (desc.classification === 'SENSITIVE') {
          const grant = ownerGrantsMap.get(code);
          if (!grant) {
            return deny('OWNER_SENSITIVE_GRANT_REQUIRED');
          }

          if (desc.scopeKind === 'UNSCOPED') {
            if (grant.scope !== 'UNSCOPED') {
              return deny('INVALID_STORED_SCOPE');
            }
            effectiveScopeMap.set(code, 'UNSCOPED');
          } else {
            if (grant.scope !== 'ASSIGNED' && grant.scope !== 'AGENCY') {
              return deny('INVALID_STORED_SCOPE');
            }
            effectiveScopeMap.set(code, grant.scope);
          }
        }
      }
    }
  }

  // Bağımlılık kapsam hiyerarşisi denetimi (üst izin alt izinden daha geniş olamaz)
  for (const [code, desc] of graph.entries()) {
    const parentScope = effectiveScopeMap.get(code)!;
    for (const depCode of desc.dependencies) {
      const depDesc = graph.get(depCode)!;
      const depScope = effectiveScopeMap.get(depCode)!;

      if (desc.scopeKind === 'RECORD_SCOPED' && depDesc.scopeKind === 'RECORD_SCOPED') {
        if (scopeWeight(depScope) < scopeWeight(parentScope)) {
          return deny('DEPENDENCY_SCOPE_TOO_NARROW');
        }
      }
    }
  }

  // 9. Kayıt Kapsamı Yükümlülüklerinin Toplanması (IMPORTANT-1 Propagation)
  interface RecordScopeObligation {
    code: string;
    scope: 'ASSIGNED' | 'AGENCY';
    resolverName: StableScopeResolver;
  }

  const recordObligations: RecordScopeObligation[] = [];
  for (const [code, desc] of graph.entries()) {
    if (desc.scopeKind === 'RECORD_SCOPED') {
      const scope = effectiveScopeMap.get(code) as 'ASSIGNED' | 'AGENCY';
      if (!desc.scopeResolver) {
        return deny('MISSING_CATALOG_METADATA');
      }
      recordObligations.push({
        code,
        scope,
        resolverName: desc.scopeResolver,
      });
    }
  }

  // Nihai karar kapsamı (en dar kesişim: ASSIGNED < AGENCY < UNSCOPED)
  let effectiveDecisionScope: EffectiveScope;
  if (recordObligations.length === 0) {
    effectiveDecisionScope = 'UNSCOPED';
  } else {
    const hasAssigned = recordObligations.some((o) => o.scope === 'ASSIGNED');
    effectiveDecisionScope = hasAssigned ? 'ASSIGNED' : 'AGENCY';
  }

  // 10. Kayıt Kapsam Çözümleyicilerinin Yürütülmesi (Finding 2)
  if (recordObligations.length > 0) {
    if (!resourceSnapshot) {
      return deny('MALFORMED_INPUT');
    }

    for (const obligation of recordObligations) {
      const resolver = stableResolvers[obligation.resolverName];
      if (!resolver || typeof resolver !== 'function') {
        return deny('UNKNOWN_SCOPE_RESOLVER');
      }

      let allowed: boolean;
      try {
        const resolved = await resolver({
          userId: userContext.userId,
          membershipId: activeMembership.id,
          agencyId: targetAgencyId,
          effectiveScope: obligation.scope,
          permissionCode: obligation.code,
          resource: resourceSnapshot,
        });
        allowed = resolved === true;
      } catch {
        return deny('SCOPE_RESOLVER_ERROR');
      }

      if (!allowed) {
        return deny('SCOPE_RESOLVER_DENIED');
      }
    }
  }

  // 11. Bütün kapılardan başarıyla geçti -> ALLOW
  return allow(effectiveDecisionScope);
}

/**
 * Yetkilendirme değerlendirici nesnesi oluşturan fabrika fonksiyonu (Factory pattern).
 */
export function createAuthorizationEvaluator(options: {
  db: D1Database;
  resolvers?: Partial<ScopeResolverRegistry>;
  actions?: AuthorizationOptions['actions'];
}): AuthorizationEvaluator {
  if (!options || typeof options !== 'object') {
    throw new Error('Yetkilendirme değerlendiricisi yapılandırması geçersiz.');
  }

  let dbInput: D1Database;
  let actionInput: AuthorizationOptions['actions'];
  let resolverInput: Partial<ScopeResolverRegistry> | undefined;
  try {
    dbInput = options.db;
    actionInput = options.actions;
    resolverInput = options.resolvers;
  } catch {
    throw new Error('Yetkilendirme değerlendiricisi yapılandırması okunamadı.');
  }

  const db = createDatabaseAdapterSnapshot(dbInput);
  const actions = createActionRegistrySnapshot(actionInput);
  const resolvers = createScopeResolverSnapshot(resolverInput);

  return Object.freeze({
    authorize: (request: AuthorizationRequest) =>
      evaluateAuthorization(db, request, {
        resolvers,
        actions,
      }),
  });
}
