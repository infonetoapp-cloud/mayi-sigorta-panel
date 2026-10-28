/**
 * Mayı Sigorta CRM — İzin Kataloğu ve Doğrulama Modülü (M1-T04)
 *
 * KRİTİK GÜVENLİK VE MİMARİ KURALLAR:
 * 1. Bu modül istemci ve sunucu arasında paylaşılan (src/shared) güvenli alandadır.
 * 2. Asla gizli anahtar, sunucuya özel import veya ortam değişkeni içeremez.
 * 3. İzin kataloğu çalışma zamanında tamamen değişmezdir (immutable).
 * 4. Yalnızca NIHAI_MIMARI_VE_UYGULAMA_PLANI.md Bölüm 4.2'deki 40 somut izin kodunu içerir.
 * 5. Sınıflandırma (NORMAL / SENSITIVE) için örtük varsayılan (default/infer) yasaktır.
 * 6. Doğrulama fonksiyonu fail-closed çalışır; geçersiz meta veriyi derhal reddeder.
 */

export type PermissionClassification = 'NORMAL' | 'SENSITIVE';
export type PermissionScopeKind = 'UNSCOPED' | 'RECORD_SCOPED';
export type PermissionAssurance = 'NORMAL_SESSION' | 'SECURE_GRANT';
export type SensitivityDomain = 'identity' | 'health';

export const PERMISSION_CODES = [
  'customer.read',
  'customer.create',
  'customer.update',
  'customer.archive',
  'customer.assign',
  'policy.read',
  'policy.create',
  'policy.update',
  'policy.archive',
  'policy.assign',
  'renewal.read',
  'renewal.update',
  'renewal.close_won',
  'renewal.close_lost',
  'renewal.assign',
  'renewal.reopen',
  'renewal.void',
  'quote.read',
  'quote.manage',
  'interaction.read',
  'interaction.create',
  'interaction.correct',
  'task.read',
  'task.create',
  'task.update',
  'task.assign',
  'task.team',
  'document.read',
  'document.upload',
  'document.archive',
  'sensitive.identity.read',
  'sensitive.identity.write',
  'sensitive.health.read',
  'sensitive.health.write',
  'report.operations',
  'report.management',
  'export.scoped',
  'export.portfolio',
  'audit.read',
  'catalog.manage',
  'agency.settings.manage',
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];

export const STABLE_SCOPE_RESOLVERS = Object.freeze([
  'customer_record_resolver',
  'policy_record_resolver',
  'renewal_record_resolver',
  'quote_record_resolver',
  'interaction_record_resolver',
  'task_record_resolver',
  'document_record_resolver',
  'report_scope_resolver',
] as const);

export type StableScopeResolver = (typeof STABLE_SCOPE_RESOLVERS)[number];

export interface PermissionDefinition {
  readonly code: string;
  readonly classification: PermissionClassification;
  readonly scopeKind: PermissionScopeKind;
  readonly sensitivityDomain: SensitivityDomain | null;
  readonly dependencies: readonly string[];
  readonly scopeResolver: StableScopeResolver | null;
  readonly assurance: PermissionAssurance;
  readonly title: string;
  readonly description: string;
}

export class CatalogValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'CatalogValidationError';
    this.code = code;
  }
}

const CANONICAL_CODE_REGEX = /^[a-z]+(\.[a-z0-9_]+)+$/;

/**
 * İzin kataloğu tanımlarını fail-closed olarak doğrular.
 * Negatif testler için ham/bilinmeyen nesne listesini kabul eder.
 */
export function validatePermissionCatalog(rawCatalog: unknown): PermissionDefinition[] {
  if (!Array.isArray(rawCatalog)) {
    throw new CatalogValidationError(
      'INVALID_CATALOG_STRUCTURE',
      'İzin kataloğu bir dizi (array) olmalıdır.',
    );
  }

  if (rawCatalog.length === 0) {
    throw new CatalogValidationError('EMPTY_CATALOG', 'İzin kataloğu boş olamaz.');
  }

  const seenCodes = new Set<string>();
  const validatedEntries: PermissionDefinition[] = [];

  for (let i = 0; i < rawCatalog.length; i++) {
    const raw = rawCatalog[i];
    if (!raw || typeof raw !== 'object') {
      throw new CatalogValidationError(
        'INVALID_ENTRY',
        `İndeks ${i} üzerindeki katalog girişi bir nesne olmalıdır.`,
      );
    }

    const entry = raw as Partial<PermissionDefinition>;

    // 1. Kod doğrulama
    if (
      typeof entry.code !== 'string' ||
      !CANONICAL_CODE_REGEX.test(entry.code.trim()) ||
      entry.code !== entry.code.trim()
    ) {
      throw new CatalogValidationError(
        'MALFORMED_CODE',
        `İndeks ${i} üzerinde geçersiz veya biçimsiz izin kodu: '${String(entry.code)}'`,
      );
    }

    if (seenCodes.has(entry.code)) {
      throw new CatalogValidationError(
        'DUPLICATE_CODE',
        `Yinelenen izin kodu tespit edildi: '${entry.code}'`,
      );
    }
    seenCodes.add(entry.code);

    // 2. Sınıflandırma (classification) doğrulama - Örtük varsayılan yok!
    if (entry.classification !== 'NORMAL' && entry.classification !== 'SENSITIVE') {
      throw new CatalogValidationError(
        'INVALID_CLASSIFICATION',
        `'${entry.code}' izninde geçersiz veya eksik sınıflandırma: '${String(entry.classification)}'`,
      );
    }

    // 3. Kapsam türü (scopeKind) doğrulama
    if (entry.scopeKind !== 'UNSCOPED' && entry.scopeKind !== 'RECORD_SCOPED') {
      throw new CatalogValidationError(
        'INVALID_SCOPE_KIND',
        `'${entry.code}' izninde geçersiz veya eksik kapsam türü: '${String(entry.scopeKind)}'`,
      );
    }

    // 4. Güvence (assurance) düzeyi doğrulama
    if (entry.assurance !== 'NORMAL_SESSION' && entry.assurance !== 'SECURE_GRANT') {
      throw new CatalogValidationError(
        'INVALID_ASSURANCE',
        `'${entry.code}' izninde geçersiz veya eksik güvence: '${String(entry.assurance)}'`,
      );
    }

    // 5. Başlık ve Açıklama (title / description) Türkçe ve boşluksuz
    if (typeof entry.title !== 'string' || entry.title.trim().length === 0) {
      throw new CatalogValidationError(
        'INVALID_TITLE',
        `'${entry.code}' izninde başlık (title) boş olamaz.`,
      );
    }

    if (typeof entry.description !== 'string' || entry.description.trim().length === 0) {
      throw new CatalogValidationError(
        'INVALID_DESCRIPTION',
        `'${entry.code}' izninde açıklama (description) boş olamaz.`,
      );
    }

    // 6. Bağımlılık dizisi (dependencies) doğrulama
    if (!Array.isArray(entry.dependencies)) {
      throw new CatalogValidationError(
        'INVALID_DEPENDENCIES',
        `'${entry.code}' izninde bağımlılıklar bir dizi olmalıdır.`,
      );
    }

    const seenDeps = new Set<string>();
    for (const dep of entry.dependencies) {
      if (typeof dep !== 'string' || dep.trim().length === 0) {
        throw new CatalogValidationError(
          'INVALID_DEPENDENCY_ITEM',
          `'${entry.code}' izninde geçersiz bağımlılık elemanı: '${String(dep)}'`,
        );
      }
      if (dep === entry.code) {
        throw new CatalogValidationError(
          'SELF_DEPENDENCY',
          `'${entry.code}' izni kendine bağımlı olamaz.`,
        );
      }
      if (seenDeps.has(dep)) {
        throw new CatalogValidationError(
          'DUPLICATE_DEPENDENCY',
          `'${entry.code}' izninde yinelenen bağımlılık: '${dep}'`,
        );
      }
      seenDeps.add(dep);
    }

    // 7. Hassasiyet alanı (sensitivityDomain) tutarlılığı
    // Sessizce undefined -> null normalleştirmesi yasaktır; NORMAL için açıkça null olmalıdır!
    if (entry.classification === 'SENSITIVE') {
      if (entry.sensitivityDomain !== 'identity' && entry.sensitivityDomain !== 'health') {
        throw new CatalogValidationError(
          'MISSING_SENSITIVITY_DOMAIN',
          `'${entry.code}' SENSITIVE izni açık ve geçerli bir hassasiyet alanı ('identity' | 'health') taşımalıdır.`,
        );
      }
    } else {
      // classification === 'NORMAL'
      if (entry.sensitivityDomain !== null) {
        throw new CatalogValidationError(
          'INCOMPATIBLE_SENSITIVITY_DOMAIN',
          `'${entry.code}' NORMAL izninde sensitivityDomain açıkça null olmalıdır (atlanamaz veya değer taşıyamaz).`,
        );
      }
    }

    // 8. Kapsam çözümleyici (scopeResolver) tutarlılığı ve allowlist doğrulaması
    // Sessizce undefined -> null normalleştirmesi yasaktır; UNSCOPED için açıkça null olmalıdır!
    if (entry.scopeKind === 'RECORD_SCOPED') {
      if (
        typeof entry.scopeResolver !== 'string' ||
        !STABLE_SCOPE_RESOLVERS.includes(entry.scopeResolver as StableScopeResolver)
      ) {
        throw new CatalogValidationError(
          'INVALID_SCOPE_RESOLVER',
          `'${entry.code}' RECORD_SCOPED izninde izin verilen listede olmayan scopeResolver: '${String(entry.scopeResolver)}'. İzin verilenler: ${STABLE_SCOPE_RESOLVERS.join(', ')}`,
        );
      }
    } else {
      // scopeKind === 'UNSCOPED'
      if (entry.scopeResolver !== null) {
        throw new CatalogValidationError(
          'UNSCOPED_HAS_RESOLVER',
          `'${entry.code}' UNSCOPED izninde scopeResolver açıkça null olmalıdır (atlanamaz veya değer taşıyamaz).`,
        );
      }
    }

    validatedEntries.push({
      code: entry.code,
      classification: entry.classification,
      scopeKind: entry.scopeKind,
      sensitivityDomain: entry.classification === 'SENSITIVE' ? entry.sensitivityDomain! : null,
      dependencies: Object.freeze([...entry.dependencies]),
      scopeResolver:
        entry.scopeKind === 'RECORD_SCOPED'
          ? (entry.scopeResolver!.trim() as StableScopeResolver)
          : null,
      assurance: entry.assurance,
      title: entry.title.trim(),
      description: entry.description.trim(),
    });
  }

  // 9. Çapraz kontroller: Bilinmeyen bağımlılıklar
  for (const entry of validatedEntries) {
    for (const dep of entry.dependencies) {
      if (!seenCodes.has(dep)) {
        throw new CatalogValidationError(
          'UNKNOWN_DEPENDENCY',
          `'${entry.code}' izninde katalogda tanımlı olmayan bağımlılık: '${dep}'`,
        );
      }
    }
  }

  // 10. Döngüsel bağımlılık kontrolü (DFS döngü tespiti)
  const dependencyMap = new Map<string, readonly string[]>();
  for (const entry of validatedEntries) {
    dependencyMap.set(entry.code, entry.dependencies);
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function detectCycle(currentCode: string): void {
    visited.add(currentCode);
    recursionStack.add(currentCode);

    const deps = dependencyMap.get(currentCode) ?? [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        detectCycle(dep);
      } else if (recursionStack.has(dep)) {
        throw new CatalogValidationError(
          'DEPENDENCY_CYCLE',
          `Döngüsel izin bağımlılığı tespit edildi: '${currentCode}' -> '${dep}'`,
        );
      }
    }

    recursionStack.delete(currentCode);
  }

  for (const entry of validatedEntries) {
    if (!visited.has(entry.code)) {
      detectCycle(entry.code);
    }
  }

  return validatedEntries;
}

const RAW_PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  // 1. Müşteri (Customer)
  {
    code: 'customer.read',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: [],
    scopeResolver: 'customer_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Müşteri Görüntüleme',
    description: 'Müşteri kartı ve temel bilgilerini görüntüleme yetkisi',
  },
  {
    code: 'customer.create',
    classification: 'NORMAL',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: null,
    dependencies: ['customer.read'],
    scopeResolver: null,
    assurance: 'NORMAL_SESSION',
    title: 'Müşteri Oluşturma',
    description: 'Yeni bireysel veya kurumsal müşteri kaydı oluşturma yetkisi',
  },
  {
    code: 'customer.update',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['customer.read'],
    scopeResolver: 'customer_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Müşteri Güncelleme',
    description: 'Kapsamdaki müşterinin temel iletişim ve profil bilgilerini güncelleme yetkisi',
  },
  {
    code: 'customer.archive',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['customer.read'],
    scopeResolver: 'customer_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Müşteri Arşivleme',
    description: 'Müşteri kaydını gerekçeli olarak kullanımdan kaldırma yetkisi',
  },
  {
    code: 'customer.assign',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['customer.read'],
    scopeResolver: 'customer_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Müşteri Sorumlusu Atama',
    description: 'Müşteriye sorumlu personel atama veya sorumluyu değiştirme yetkisi',
  },

  // 2. Poliçe (Policy)
  {
    code: 'policy.read',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: [],
    scopeResolver: 'policy_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Poliçe Görüntüleme',
    description: 'Poliçe detaylarını ve sözleşme bilgilerini görüntüleme yetkisi',
  },
  {
    code: 'policy.create',
    classification: 'NORMAL',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: null,
    dependencies: ['policy.read'],
    scopeResolver: null,
    assurance: 'NORMAL_SESSION',
    title: 'Poliçe Oluşturma',
    description: 'Erişilebilir müşteri için yeni poliçe kaydı oluşturma yetkisi',
  },
  {
    code: 'policy.update',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['policy.read'],
    scopeResolver: 'policy_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Poliçe Güncelleme',
    description: 'İzin verilen poliçe alanlarını düzeltme ve güncelleme yetkisi',
  },
  {
    code: 'policy.archive',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['policy.read'],
    scopeResolver: 'policy_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Poliçe Arşivleme',
    description: 'Poliçeyi geçmişini silmeden arşivleme yetkisi',
  },
  {
    code: 'policy.assign',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['policy.read'],
    scopeResolver: 'policy_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Poliçe Sorumlusu Atama',
    description: 'Poliçeye sorumlu personel atama veya sorumluyu değiştirme yetkisi',
  },

  // 3. Yenileme (Renewal)
  {
    code: 'renewal.read',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: [],
    scopeResolver: 'renewal_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Yenileme Görüntüleme',
    description: 'Yenileme işini, vadesini ve detaylarını görüntüleme yetkisi',
  },
  {
    code: 'renewal.update',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['renewal.read'],
    scopeResolver: 'renewal_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Yenileme Güncelleme',
    description: 'Açık yenileme işinin durum, takip ve öncelik bilgilerini güncelleme yetkisi',
  },
  {
    code: 'renewal.close_won',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['renewal.read'],
    scopeResolver: 'renewal_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Yenileme Kazanıldı Olarak Kapatma',
    description: 'Yenileme işini sonuç poliçesi bağlayarak kazanıldı olarak tamamlama yetkisi',
  },
  {
    code: 'renewal.close_lost',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['renewal.read'],
    scopeResolver: 'renewal_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Yenileme Kayıp Olarak Kapatma',
    description: 'Yenileme işini zorunlu kayıp gerekçesiyle kapatma yetkisi',
  },
  {
    code: 'renewal.assign',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['renewal.read'],
    scopeResolver: 'renewal_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Yenileme Sorumlusu Atama',
    description: 'Yenileme işine sorumlu personel atama veya sorumluyu değiştirme yetkisi',
  },
  {
    code: 'renewal.reopen',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['renewal.read'],
    scopeResolver: 'renewal_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Yenileme Yeniden Açma',
    description: 'Kapanmış yenileme işini kontrollü biçimde tekrar açma yetkisi',
  },
  {
    code: 'renewal.void',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['renewal.read'],
    scopeResolver: 'renewal_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Yenileme İptal Etme',
    description: 'Hatalı veya uygunsuz yenileme işini rapor dışı bırakarak iptal etme yetkisi',
  },

  // 4. Teklif (Quote)
  {
    code: 'quote.read',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: [],
    scopeResolver: 'quote_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Teklif Görüntüleme',
    description: 'Yenileme veya müşteriye bağlı teklifleri görüntüleme yetkisi',
  },
  {
    code: 'quote.manage',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['quote.read'],
    scopeResolver: 'quote_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Teklif Yönetimi',
    description: 'Teklif oluşturma, revize etme ve pasifleştirme yetkisi',
  },

  // 5. Görüşme (Interaction)
  {
    code: 'interaction.read',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: [],
    scopeResolver: 'interaction_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Görüşme Geçmişi Görüntüleme',
    description: 'Müşteri ve yenileme temas geçmişini görüntüleme yetkisi',
  },
  {
    code: 'interaction.create',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['interaction.read'],
    scopeResolver: 'interaction_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Görüşme Kaydı Ekleme',
    description: 'Yeni temas, arama veya görüşme notu kaydetme yetkisi',
  },
  {
    code: 'interaction.correct',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['interaction.read'],
    scopeResolver: 'interaction_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Görüşme Kaydı Düzeltme',
    description: 'Görüşme kaydını eski içeriği koruyarak gerekçeli düzeltme yetkisi',
  },

  // 6. Görev (Task)
  {
    code: 'task.read',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    // Parent type is polymorphic; Task service must authorize the linked record read
    // and set parentReadAuthorized before evaluating this action.
    dependencies: [],
    scopeResolver: 'task_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Görev Görüntüleme',
    description: 'Görevleri ve takip kayıtlarını görüntüleme yetkisi',
  },
  {
    code: 'task.create',
    classification: 'NORMAL',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: null,
    dependencies: ['task.read'],
    scopeResolver: null,
    assurance: 'NORMAL_SESSION',
    title: 'Görev Oluşturma',
    description: 'Erişilebilir kayıt üzerinde veya kendine görev oluşturma yetkisi',
  },
  {
    code: 'task.update',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['task.read'],
    scopeResolver: 'task_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Görev Güncelleme',
    description: 'Kapsamdaki görev detaylarını, durumunu veya vadesini güncelleme yetkisi',
  },
  {
    code: 'task.assign',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['task.read'],
    scopeResolver: 'task_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Görev Atama',
    description: 'Görevi başka personele atama veya sorumluyu değiştirme yetkisi',
  },

  // 7. Belge (Document)
  {
    code: 'document.read',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: [],
    scopeResolver: 'document_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Belge Görüntüleme',
    description: 'Yetkili kayda ait temiz belgeleri görüntüleme yetkisi',
  },
  {
    code: 'document.upload',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['document.read'],
    scopeResolver: 'document_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Belge Yükleme',
    description: 'Kapsamdaki kayda yeni belge ekleme yetkisi',
  },
  {
    code: 'document.archive',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: ['document.read'],
    scopeResolver: 'document_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Belge Arşivleme',
    description: 'Belgeyi kullanımdan kaldırma ve arşivleme yetkisi',
  },

  // 8. Hassas Veri (Sensitive Data)
  {
    code: 'sensitive.identity.read',
    classification: 'SENSITIVE',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: 'identity',
    dependencies: [],
    scopeResolver: null,
    assurance: 'NORMAL_SESSION',
    title: 'Hassas Kimlik Bilgisi Okuma',
    description: 'Maskelenmemiş tam TCKN/VKN ve kimlik sınıfı belgeleri görme yetkisi',
  },
  {
    code: 'sensitive.identity.write',
    classification: 'SENSITIVE',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: 'identity',
    dependencies: ['sensitive.identity.read'],
    scopeResolver: null,
    assurance: 'NORMAL_SESSION',
    title: 'Hassas Kimlik Bilgisi Düzenleme',
    description: 'TCKN/VKN ve kimlik sınıfı belgeleri düzenleme yetkisi',
  },
  {
    code: 'sensitive.health.read',
    classification: 'SENSITIVE',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: 'health',
    dependencies: [],
    scopeResolver: null,
    assurance: 'NORMAL_SESSION',
    title: 'Hassas Sağlık Bilgisi Okuma',
    description: 'Sağlık branşı detaylarını ve sağlık poliçesi belgelerini görme yetkisi',
  },
  {
    code: 'sensitive.health.write',
    classification: 'SENSITIVE',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: 'health',
    dependencies: ['sensitive.health.read'],
    scopeResolver: null,
    assurance: 'NORMAL_SESSION',
    title: 'Hassas Sağlık Bilgisi Düzenleme',
    description: 'İzinli sağlık branşı verilerini ve belgelerini işleme yetkisi',
  },

  // 9. Raporlar (Reports)
  {
    code: 'report.operations',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: [],
    scopeResolver: 'report_scope_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Operasyonel Raporlar',
    description: 'Kapsamdaki iş yükü ve operasyonel iş listesi raporlarını görüntüleme yetkisi',
  },
  {
    code: 'report.management',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: [],
    scopeResolver: 'report_scope_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Yönetim Raporları',
    description: 'Kapsamdaki acente yönetim metriklerini ve özet raporları görüntüleme yetkisi',
  },

  // 10. Dışa Aktarım (Export)
  {
    code: 'export.scoped',
    classification: 'NORMAL',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: null,
    dependencies: [],
    scopeResolver: null,
    assurance: 'SECURE_GRANT',
    title: 'Kapsamlı Dışa Aktarım',
    description: 'Görülebildiği kapsamdaki kayıtları kontrollü dışa aktarma yetkisi',
  },
  {
    code: 'export.portfolio',
    classification: 'NORMAL',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: null,
    dependencies: [],
    scopeResolver: null,
    assurance: 'SECURE_GRANT',
    title: 'Tam Portföy Dışa Aktarım',
    description: 'Erişilebilen modüllerde acente geneli tam portföyü dışa aktarma yetkisi',
  },

  {
    code: 'task.team',
    classification: 'NORMAL',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: null,
    dependencies: ['task.read'],
    scopeResolver: null,
    assurance: 'NORMAL_SESSION',
    title: 'Ekip Görevlerine Erişim',
    description:
      'Açık yetki: AGENCY kapsamlı görev izinlerini diğer çalışanların görevlerinde kullanma. Tek başına okuma, değiştirme veya atama yetkisi vermez.',
  },

  // 11. Güvenlik Denetim İzi (Audit)
  {
    code: 'audit.read',
    classification: 'NORMAL',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: null,
    dependencies: [],
    scopeResolver: null,
    assurance: 'NORMAL_SESSION',
    title: 'Denetim İzi Okuma',
    description: 'Maskelenmiş güvenlik ve işlem denetim günlüklerini görüntüleme yetkisi',
  },

  // 12. Katalog Yönetimi (Catalog)
  {
    code: 'catalog.manage',
    classification: 'NORMAL',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: null,
    dependencies: [],
    scopeResolver: null,
    assurance: 'NORMAL_SESSION',
    title: 'Katalog Yönetimi',
    description: 'Sigortacı, ürün, ödeme yöntemi ve kayıp nedeni kataloglarını yönetme yetkisi',
  },

  // 13. Acente Ayarları (Agency Settings)
  {
    code: 'agency.settings.manage',
    classification: 'NORMAL',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: null,
    dependencies: [],
    scopeResolver: null,
    assurance: 'NORMAL_SESSION',
    title: 'Acente Ayarları Yönetimi',
    description: 'Acente operasyon ayarlarını yönetme yetkisi',
  },
];

// Modül başlatma anında üretim kataloğunu fail-closed doğrula
const validatedCatalog = validatePermissionCatalog(RAW_PERMISSION_CATALOG);

// Çalışma zamanında mutasyona karşı derin dondurma
for (const entry of validatedCatalog) {
  Object.freeze(entry);
  Object.freeze(entry.dependencies);
}

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = Object.freeze(validatedCatalog);

const PERMISSION_CATALOG_BY_CODE = new Map<string, PermissionDefinition>(
  PERMISSION_CATALOG.map((entry) => [entry.code, entry]),
);

/**
 * Verilen kodun geçerli katalogda olup olmadığını denetler.
 */
export function isPermissionCode(code: string): code is PermissionCode {
  return PERMISSION_CATALOG_BY_CODE.has(code);
}

/**
 * Kod ile izin tanımını döndürür. Bulunamazsa undefined döner.
 */
export function getPermissionDefinition(code: string): PermissionDefinition | undefined {
  return PERMISSION_CATALOG_BY_CODE.get(code);
}

// =============================================================================
// Onboarding Şablonları (Bölüm 4.2 ve RG-00 Sözleşmesi)
//
// KRİTİK KURALLAR:
// 1. Şablonlar çalışma zamanı rolü veya yetki kaynağı değildir; yalnız başlangıç kopyalama kalıbıdır.
// 2. Yalnızca MEMBER hedefli iki şablon tanımlıdır: 'personel' ve 'yetkili_personel'.
// 3. OWNER şablonu YOKTUR; veritabanı şablon tablosu, API veya UI YOKTUR.
// 4. Bütün SENSITIVE izinler (kimlik ve sağlık) şablonlarda varsayılan olarak KAPALIDIR (OFF).
// 5. Yalnızca pozitif grant satırları üretilir; NONE satırı depolanmaz.
// 6. createOnboardingTemplateGrants her çağrıda bağımsız bir kopya (snapshot) döndürür.
// =============================================================================

export const ONBOARDING_TEMPLATE_IDS = ['personel', 'yetkili_personel'] as const;
export type OnboardingTemplateId = (typeof ONBOARDING_TEMPLATE_IDS)[number];

export interface OnboardingTemplateGrant {
  readonly permission_code: PermissionCode;
  readonly scope: 'UNSCOPED' | 'ASSIGNED' | 'AGENCY';
}

export interface OnboardingTemplateDefinition {
  readonly id: OnboardingTemplateId;
  readonly targetMembershipType: 'MEMBER';
  readonly title: string;
  readonly description: string;
  readonly grants: readonly OnboardingTemplateGrant[];
}

const RAW_ONBOARDING_TEMPLATES: Record<OnboardingTemplateId, OnboardingTemplateDefinition> = {
  personel: {
    id: 'personel',
    targetMembershipType: 'MEMBER',
    title: 'Standart Personel Başlangıç Şablonu',
    description:
      'Ortak acente kayıtlarında çalışan, yalnız kendi günlük görevlerini gören standart personel',
    grants: [
      { permission_code: 'customer.read', scope: 'AGENCY' },
      { permission_code: 'customer.create', scope: 'UNSCOPED' },
      { permission_code: 'customer.update', scope: 'AGENCY' },
      { permission_code: 'policy.read', scope: 'AGENCY' },
      { permission_code: 'policy.create', scope: 'UNSCOPED' },
      { permission_code: 'policy.update', scope: 'AGENCY' },
      { permission_code: 'renewal.read', scope: 'AGENCY' },
      { permission_code: 'renewal.update', scope: 'AGENCY' },
      { permission_code: 'renewal.close_won', scope: 'AGENCY' },
      { permission_code: 'renewal.close_lost', scope: 'AGENCY' },
      { permission_code: 'quote.read', scope: 'AGENCY' },
      { permission_code: 'quote.manage', scope: 'AGENCY' },
      { permission_code: 'interaction.read', scope: 'AGENCY' },
      { permission_code: 'interaction.create', scope: 'AGENCY' },
      { permission_code: 'task.read', scope: 'ASSIGNED' },
      { permission_code: 'task.create', scope: 'UNSCOPED' },
      { permission_code: 'task.update', scope: 'ASSIGNED' },
      { permission_code: 'document.read', scope: 'ASSIGNED' },
      { permission_code: 'document.upload', scope: 'ASSIGNED' },
      { permission_code: 'report.operations', scope: 'ASSIGNED' },
    ],
  },
  yetkili_personel: {
    id: 'yetkili_personel',
    targetMembershipType: 'MEMBER',
    title: 'Yetkili Personel Başlangıç Şablonu',
    description:
      'Acente genelinde kayıtları yönetebilen yetkili / yönetici personel başlangıç yetkileri',
    grants: [
      { permission_code: 'customer.read', scope: 'AGENCY' },
      { permission_code: 'customer.create', scope: 'UNSCOPED' },
      { permission_code: 'customer.update', scope: 'AGENCY' },
      { permission_code: 'customer.archive', scope: 'AGENCY' },
      { permission_code: 'customer.assign', scope: 'AGENCY' },
      { permission_code: 'policy.read', scope: 'AGENCY' },
      { permission_code: 'policy.create', scope: 'UNSCOPED' },
      { permission_code: 'policy.update', scope: 'AGENCY' },
      { permission_code: 'policy.archive', scope: 'AGENCY' },
      { permission_code: 'policy.assign', scope: 'AGENCY' },
      { permission_code: 'renewal.read', scope: 'AGENCY' },
      { permission_code: 'renewal.update', scope: 'AGENCY' },
      { permission_code: 'renewal.close_won', scope: 'AGENCY' },
      { permission_code: 'renewal.close_lost', scope: 'AGENCY' },
      { permission_code: 'renewal.reopen', scope: 'AGENCY' },
      { permission_code: 'quote.read', scope: 'AGENCY' },
      { permission_code: 'quote.manage', scope: 'AGENCY' },
      { permission_code: 'interaction.read', scope: 'AGENCY' },
      { permission_code: 'interaction.create', scope: 'AGENCY' },
      { permission_code: 'interaction.correct', scope: 'AGENCY' },
      { permission_code: 'task.read', scope: 'ASSIGNED' },
      { permission_code: 'task.create', scope: 'UNSCOPED' },
      { permission_code: 'task.update', scope: 'ASSIGNED' },
      { permission_code: 'document.read', scope: 'AGENCY' },
      { permission_code: 'document.upload', scope: 'AGENCY' },
      { permission_code: 'document.archive', scope: 'AGENCY' },
      { permission_code: 'report.operations', scope: 'ASSIGNED' },
      { permission_code: 'catalog.manage', scope: 'UNSCOPED' },
    ],
  },
};

for (const tmpl of Object.values(RAW_ONBOARDING_TEMPLATES)) {
  for (const grant of tmpl.grants) {
    Object.freeze(grant);
  }
  Object.freeze(tmpl.grants);
  Object.freeze(tmpl);
}

export const ONBOARDING_TEMPLATES: Readonly<
  Record<OnboardingTemplateId, OnboardingTemplateDefinition>
> = Object.freeze(RAW_ONBOARDING_TEMPLATES);

/**
 * Belirtilen onboarding şablonu için derin kopyalanmış (deep-cloned) pozitif yetki
 * anlık görüntüsü (snapshot) üretir.
 * Sonradan yapılan değişiklikler şablonu veya diğer çağrıları etkilemez.
 */
export function createOnboardingTemplateGrants(
  templateId: OnboardingTemplateId,
): OnboardingTemplateGrant[] {
  const template = ONBOARDING_TEMPLATES[templateId];
  if (!template) {
    throw new Error(`Geçersiz onboarding şablonu: ${templateId}`);
  }

  return template.grants.map((g) => ({
    permission_code: g.permission_code,
    scope: g.scope,
  }));
}
