import { describe, expect, it } from 'vitest';
import {
  PERMISSION_CATALOG,
  validatePermissionCatalog,
  CatalogValidationError,
  ONBOARDING_TEMPLATE_IDS,
  ONBOARDING_TEMPLATES,
  createOnboardingTemplateGrants,
  STABLE_SCOPE_RESOLVERS,
  type PermissionDefinition,
  type OnboardingTemplateId,
} from '../src/shared/permissions';

describe('M1-T04 İzin Kataloğu ve Doğrulama Sözleşmesi', () => {
  const validNormalEntry: PermissionDefinition = {
    code: 'customer.read',
    classification: 'NORMAL',
    scopeKind: 'RECORD_SCOPED',
    sensitivityDomain: null,
    dependencies: [],
    scopeResolver: 'customer_record_resolver',
    assurance: 'NORMAL_SESSION',
    title: 'Müşteri Görüntüleme',
    description: 'Müşteri kartı ve temel bilgilerini görüntüleme yetkisi',
  };

  const validSensitiveEntry: PermissionDefinition = {
    code: 'sensitive.identity.read',
    classification: 'SENSITIVE',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: 'identity',
    dependencies: [],
    scopeResolver: null,
    assurance: 'NORMAL_SESSION',
    title: 'Hassas Kimlik Bilgisi Okuma',
    description: 'Maskelenmemiş tam TCKN/VKN ve kimlik sınıfı belgeleri görme yetkisi',
  };

  const validSensitiveWriteEntry: PermissionDefinition = {
    code: 'sensitive.identity.write',
    classification: 'SENSITIVE',
    scopeKind: 'UNSCOPED',
    sensitivityDomain: 'identity',
    dependencies: ['sensitive.identity.read'],
    scopeResolver: null,
    assurance: 'NORMAL_SESSION',
    title: 'Hassas Kimlik Bilgisi Düzenleme',
    description: 'TCKN/VKN ve kimlik sınıfı belgeleri düzenleme yetkisi',
  };

  it('1: yinelenen izin kodu reddedilmelidir', () => {
    const entries = [validNormalEntry, { ...validNormalEntry, title: 'Farklı başlık' }];
    expect(() => validatePermissionCatalog(entries)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(entries)).toThrow(/DUPLICATE_CODE/);
  });

  it('2: eksik veya geçersiz sınıflandırma (classification) reddedilmelidir', () => {
    const missingClassification = [
      {
        ...validNormalEntry,
        classification: undefined as unknown as 'NORMAL',
      },
    ];
    expect(() => validatePermissionCatalog(missingClassification)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(missingClassification)).toThrow(
      /INVALID_CLASSIFICATION/,
    );

    const invalidClassification = [
      {
        ...validNormalEntry,
        classification: 'ADMIN' as unknown as 'NORMAL',
      },
    ];
    expect(() => validatePermissionCatalog(invalidClassification)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(invalidClassification)).toThrow(
      /INVALID_CLASSIFICATION/,
    );
  });

  it('3: eksik veya geçersiz kapsam türü (scopeKind) reddedilmelidir', () => {
    const missingScopeKind = [
      {
        ...validNormalEntry,
        scopeKind: undefined as unknown as 'RECORD_SCOPED',
      },
    ];
    expect(() => validatePermissionCatalog(missingScopeKind)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(missingScopeKind)).toThrow(/INVALID_SCOPE_KIND/);

    const invalidScopeKind = [
      {
        ...validNormalEntry,
        scopeKind: 'TENANT' as unknown as 'RECORD_SCOPED',
      },
    ];
    expect(() => validatePermissionCatalog(invalidScopeKind)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(invalidScopeKind)).toThrow(/INVALID_SCOPE_KIND/);
  });

  it('4: katalogda tanımlı olmayan bağımlılık (unknown dependency) reddedilmelidir', () => {
    const withUnknownDep = [
      {
        ...validNormalEntry,
        dependencies: ['non_existent.permission'],
      },
    ];
    expect(() => validatePermissionCatalog(withUnknownDep)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(withUnknownDep)).toThrow(/UNKNOWN_DEPENDENCY/);
  });

  it('5: kendine bağımlılık (self dependency) reddedilmelidir', () => {
    const withSelfDep = [
      {
        ...validNormalEntry,
        dependencies: ['customer.read'],
      },
    ];
    expect(() => validatePermissionCatalog(withSelfDep)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(withSelfDep)).toThrow(/SELF_DEPENDENCY/);
  });

  it('6: döngüsel bağımlılık (dependency cycle) reddedilmelidir', () => {
    const cycleEntries = [
      {
        ...validNormalEntry,
        code: 'module.a',
        dependencies: ['module.b'],
      },
      {
        ...validNormalEntry,
        code: 'module.b',
        dependencies: ['module.c'],
      },
      {
        ...validNormalEntry,
        code: 'module.c',
        dependencies: ['module.a'],
      },
    ];
    expect(() => validatePermissionCatalog(cycleEntries)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(cycleEntries)).toThrow(/DEPENDENCY_CYCLE/);
  });

  it('7: geçerli NORMAL izin girişi kabul edilmelidir', () => {
    const result = validatePermissionCatalog([validNormalEntry]);
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe('customer.read');
    expect(result[0]?.classification).toBe('NORMAL');
  });

  it('8: geçerli SENSITIVE izin girişi kabul edilmelidir', () => {
    const result = validatePermissionCatalog([validSensitiveEntry, validSensitiveWriteEntry]);
    expect(result).toHaveLength(2);
    expect(result[0]?.classification).toBe('SENSITIVE');
    expect(result[1]?.classification).toBe('SENSITIVE');
    expect(result[1]?.dependencies).toContain('sensitive.identity.read');
  });

  it('9: SENSITIVE sınıfı açık hassasiyet alanı (sensitivityDomain) gerektirir', () => {
    const sensitiveWithoutDomain = [
      {
        ...validSensitiveEntry,
        sensitivityDomain: null as unknown as 'identity',
      },
    ];
    expect(() => validatePermissionCatalog(sensitiveWithoutDomain)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(sensitiveWithoutDomain)).toThrow(
      /MISSING_SENSITIVITY_DOMAIN/,
    );
  });

  it('10: NORMAL sınıfı hassasiyet metadata’sı taşıyamaz (incompatible metadata)', () => {
    const normalWithSensitiveDomain = [
      {
        ...validNormalEntry,
        sensitivityDomain: 'identity' as unknown as null,
      },
    ];
    expect(() => validatePermissionCatalog(normalWithSensitiveDomain)).toThrow(
      CatalogValidationError,
    );
    expect(() => validatePermissionCatalog(normalWithSensitiveDomain)).toThrow(
      /INCOMPATIBLE_SENSITIVITY_DOMAIN/,
    );
  });

  it('11: sınıflandırma için örtük varsayılan (implicit default) bulunmamalıdır', () => {
    const rawEntryWithoutClassification = {
      code: 'unclassified.permission',
      scopeKind: 'UNSCOPED',
      sensitivityDomain: null,
      dependencies: [],
      scopeResolver: null,
      assurance: 'NORMAL_SESSION',
      title: 'Tanımsız İzin',
      description: 'Açıklama',
    };
    expect(() =>
      validatePermissionCatalog([rawEntryWithoutClassification as unknown as PermissionDefinition]),
    ).toThrow(CatalogValidationError);
    expect(() =>
      validatePermissionCatalog([rawEntryWithoutClassification as unknown as PermissionDefinition]),
    ).toThrow(/INVALID_CLASSIFICATION/);
  });

  it('12: katalog girişi tek başına örtük üye yetkisi (implicit MEMBER grant) üretemez', () => {
    // Katalog salt meta veridir; üzerinde grant durumu, boolean aktiflik veya üye eşlemesi taşımaz
    for (const entry of PERMISSION_CATALOG) {
      expect(entry).not.toHaveProperty('granted');
      expect(entry).not.toHaveProperty('enabled');
      expect(entry).not.toHaveProperty('memberDefault');
      expect(entry).not.toHaveProperty('role');
    }
  });

  it('yinelenen bağımlılık reddedilmelidir', () => {
    const withDupDep = [
      validSensitiveEntry,
      {
        ...validSensitiveWriteEntry,
        dependencies: ['sensitive.identity.read', 'sensitive.identity.read'],
      },
    ];
    expect(() => validatePermissionCatalog(withDupDep)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(withDupDep)).toThrow(/DUPLICATE_DEPENDENCY/);
  });

  it('geçersiz güvence (assurance) düzeyi reddedilmelidir', () => {
    const withBadAssurance = [
      {
        ...validNormalEntry,
        assurance: 'HIGH_PRIVILEGE' as unknown as 'NORMAL_SESSION',
      },
    ];
    expect(() => validatePermissionCatalog(withBadAssurance)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(withBadAssurance)).toThrow(/INVALID_ASSURANCE/);
  });

  it('RECORD_SCOPED izinde geçerli ve allowlist içindeki scopeResolver zorunludur', () => {
    const scopedWithNullResolver = [
      {
        ...validNormalEntry,
        scopeKind: 'RECORD_SCOPED' as const,
        scopeResolver: null,
      },
    ];
    expect(() => validatePermissionCatalog(scopedWithNullResolver)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(scopedWithNullResolver)).toThrow(
      /INVALID_SCOPE_RESOLVER/,
    );

    const scopedWithTypoResolver = [
      {
        ...validNormalEntry,
        scopeKind: 'RECORD_SCOPED' as const,
        scopeResolver: 'customer_typo_resolver' as unknown as null,
      },
    ];
    expect(() => validatePermissionCatalog(scopedWithTypoResolver)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(scopedWithTypoResolver)).toThrow(
      /INVALID_SCOPE_RESOLVER/,
    );
  });

  it('UNSCOPED izinde scopeResolver açıkça null olmalıdır (atlanamaz ve değer taşıyamaz)', () => {
    const unscopedWithResolver = [
      {
        ...validSensitiveEntry,
        scopeKind: 'UNSCOPED' as const,
        scopeResolver: 'customer_record_resolver' as unknown as null,
      },
    ];
    expect(() => validatePermissionCatalog(unscopedWithResolver)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(unscopedWithResolver)).toThrow(/UNSCOPED_HAS_RESOLVER/);

    const { scopeResolver: _omitted, ...unscopedOmittedResolver } = validSensitiveEntry;
    expect(() => validatePermissionCatalog([unscopedOmittedResolver])).toThrow(
      CatalogValidationError,
    );
    expect(() => validatePermissionCatalog([unscopedOmittedResolver])).toThrow(
      /UNSCOPED_HAS_RESOLVER/,
    );
  });

  it('NORMAL izinde sensitivityDomain açıkça null olmalıdır (atlanamaz ve değer taşıyamaz)', () => {
    const { sensitivityDomain: _omitted, ...normalOmittedDomain } = validNormalEntry;
    expect(() => validatePermissionCatalog([normalOmittedDomain])).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog([normalOmittedDomain])).toThrow(
      /INCOMPATIBLE_SENSITIVITY_DOMAIN/,
    );
  });

  it('boş veya beyaz boşluklu Türkçe başlık ve açıklama reddedilmelidir', () => {
    const emptyTitle = [{ ...validNormalEntry, title: '   ' }];
    expect(() => validatePermissionCatalog(emptyTitle)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(emptyTitle)).toThrow(/INVALID_TITLE/);

    const emptyDesc = [{ ...validNormalEntry, description: '' }];
    expect(() => validatePermissionCatalog(emptyDesc)).toThrow(CatalogValidationError);
    expect(() => validatePermissionCatalog(emptyDesc)).toThrow(/INVALID_DESCRIPTION/);
  });

  it('bozuk veya kanonik olmayan izin kodu biçimi reddedilmelidir', () => {
    const badCodes = [
      'INVALID_UPPERCASE',
      'no-dot-separator',
      'dot..double',
      '   leading.space',
      'customer.read ',
    ];
    for (const badCode of badCodes) {
      const entry = [{ ...validNormalEntry, code: badCode }];
      expect(() => validatePermissionCatalog(entry)).toThrow(CatalogValidationError);
      expect(() => validatePermissionCatalog(entry)).toThrow(/MALFORMED_CODE/);
    }
  });

  it('üretim PERMISSION_CATALOG listesi tam olarak Bölüm 4.2’deki 40 izni içermelidir', () => {
    expect(PERMISSION_CATALOG.length).toBe(40);
    expect(Object.isFrozen(PERMISSION_CATALOG)).toBe(true);

    const codes = new Set(PERMISSION_CATALOG.map((p) => p.code));
    const expectedCodes = [
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
    ];

    expect(codes.size).toBe(40);
    for (const expected of expectedCodes) {
      expect(codes.has(expected), `Eksik izin kodu: ${expected}`).toBe(true);
    }

    // Doğrulama fonksiyonu üretim kataloğunu başarıyla geçmelidir
    const validated = validatePermissionCatalog(PERMISSION_CATALOG);
    expect(validated.length).toBe(40);
  });

  it('üretim kataloğundaki SENSITIVE izinler yalnızca kimlik ve sağlık olmalıdır', () => {
    const sensitive = PERMISSION_CATALOG.filter((p) => p.classification === 'SENSITIVE');
    expect(sensitive.length).toBe(4);
    const sensitiveCodes = sensitive.map((p) => p.code).sort();
    expect(sensitiveCodes).toEqual([
      'sensitive.health.read',
      'sensitive.health.write',
      'sensitive.identity.read',
      'sensitive.identity.write',
    ]);
  });

  it('üretim kataloğundaki kapsamlar Bölüm 4.2 matrisini yansıtmalıdır', () => {
    const recordScoped = PERMISSION_CATALOG.filter((p) => p.scopeKind === 'RECORD_SCOPED');
    // A/T olanlar RECORD_SCOPED olmalı
    const expectedScopedCodes = [
      'customer.read',
      'customer.update',
      'customer.archive',
      'customer.assign',
      'policy.read',
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
      'task.update',
      'task.assign',
      'document.read',
      'document.upload',
      'document.archive',
      'report.operations',
      'report.management',
    ];
    expect(recordScoped.map((p) => p.code).sort()).toEqual(expectedScopedCodes.sort());
  });

  it('üretim kataloğundaki dışa aktarım (export) izinleri SECURE_GRANT gerektirmelidir', () => {
    const secureGrantEntries = PERMISSION_CATALOG.filter((p) => p.assurance === 'SECURE_GRANT');
    expect(secureGrantEntries.map((p) => p.code).sort()).toEqual([
      'export.portfolio',
      'export.scoped',
    ]);
  });
});

describe('M1-T04 Onboarding Şablonları Sözleşmesi (Bölüm 4.2 & RG-00)', () => {
  it('şablon kimlikleri yalnızca personel ve yetkili_personel olmalıdır', () => {
    expect(ONBOARDING_TEMPLATE_IDS).toEqual(['personel', 'yetkili_personel']);
  });

  it('şablonlar yalnızca MEMBER hedefli olmalıdır; OWNER şablonu bulunamaz', () => {
    for (const templateId of ONBOARDING_TEMPLATE_IDS) {
      const template = ONBOARDING_TEMPLATES[templateId];
      expect(template.targetMembershipType).toBe('MEMBER');
      // @ts-expect-error - OWNER şablonu olmamalıdır
      expect(ONBOARDING_TEMPLATES['owner']).toBeUndefined();
    }
  });

  it('her iki şablonda da SENSITIVE izinler varsayılan olarak KAPALI (OFF) olmalıdır', () => {
    const sensitiveCodes = new Set(
      PERMISSION_CATALOG.filter((p) => p.classification === 'SENSITIVE').map((p) => p.code),
    );
    expect(sensitiveCodes.size).toBe(4);

    for (const templateId of ONBOARDING_TEMPLATE_IDS) {
      const template = ONBOARDING_TEMPLATES[templateId];
      for (const grant of template.grants) {
        expect(
          sensitiveCodes.has(grant.permission_code),
          `Şablon [${templateId}] hassas izin [${grant.permission_code}] içeremez!`,
        ).toBe(false);
      }
    }
  });

  it('bütün şablon izinleri PERMISSION_CATALOG içinde tanımlı ve geçerli olmalıdır', () => {
    const catalogCodes = new Set(PERMISSION_CATALOG.map((p) => p.code));

    for (const templateId of ONBOARDING_TEMPLATE_IDS) {
      const template = ONBOARDING_TEMPLATES[templateId];
      for (const grant of template.grants) {
        expect(
          catalogCodes.has(grant.permission_code),
          `Geçersiz izin kodu: ${grant.permission_code}`,
        ).toBe(true);
      }
    }
  });

  it('bütün şablon izinlerinin kapsamları katalog scopeKind kurallarına tam uymalıdır', () => {
    const catalogMap = new Map(PERMISSION_CATALOG.map((p) => [p.code, p]));

    for (const templateId of ONBOARDING_TEMPLATE_IDS) {
      const template = ONBOARDING_TEMPLATES[templateId];
      for (const grant of template.grants) {
        const def = catalogMap.get(grant.permission_code)!;
        if (def.scopeKind === 'UNSCOPED') {
          expect(grant.scope).toBe('UNSCOPED');
        } else if (def.scopeKind === 'RECORD_SCOPED') {
          expect(['ASSIGNED', 'AGENCY']).toContain(grant.scope);
        }
      }
    }
  });

  it('şablonlardaki pozitif izin sayıları ve beklenen anahtar izinler Bölüm 4.2 matrisine uymalıdır', () => {
    // Personel: 20 pozitif yetki (tüm kayıt kapsamlılar ASSIGNED, create'ler UNSCOPED)
    const personelGrants = ONBOARDING_TEMPLATES.personel.grants;
    expect(personelGrants).toHaveLength(20);

    const personelMap = new Map(personelGrants.map((g) => [g.permission_code, g.scope]));
    expect(personelMap.get('customer.read')).toBe('ASSIGNED');
    expect(personelMap.get('customer.create')).toBe('UNSCOPED');
    expect(personelMap.get('customer.update')).toBe('ASSIGNED');
    expect(personelMap.get('customer.archive')).toBeUndefined();
    expect(personelMap.get('catalog.manage')).toBeUndefined();
    expect(personelMap.get('renewal.void')).toBeUndefined();

    // Yetkili Personel: 31 pozitif yetki (tüm kayıt kapsamlılar AGENCY, create ve catalog.manage UNSCOPED)
    const yetkiliGrants = ONBOARDING_TEMPLATES.yetkili_personel.grants;
    expect(yetkiliGrants).toHaveLength(31);

    const yetkiliMap = new Map(yetkiliGrants.map((g) => [g.permission_code, g.scope]));
    expect(yetkiliMap.get('customer.read')).toBe('AGENCY');
    expect(yetkiliMap.get('customer.create')).toBe('UNSCOPED');
    expect(yetkiliMap.get('customer.update')).toBe('AGENCY');
    expect(yetkiliMap.get('customer.archive')).toBe('AGENCY');
    expect(yetkiliMap.get('customer.assign')).toBe('AGENCY');
    expect(yetkiliMap.get('catalog.manage')).toBe('UNSCOPED');
    expect(yetkiliMap.get('renewal.void')).toBeUndefined();
  });

  it('şablon içi bağımlılıklar ve kapsam hiyerarşisi tam olarak karşılanmalıdır', () => {
    const catalogMap = new Map<string, PermissionDefinition>(
      PERMISSION_CATALOG.map((p) => [p.code, p]),
    );

    for (const templateId of ONBOARDING_TEMPLATE_IDS) {
      const template = ONBOARDING_TEMPLATES[templateId];
      const grantMap = new Map<string, string>(
        template.grants.map((g) => [g.permission_code, g.scope]),
      );

      for (const grant of template.grants) {
        const def = catalogMap.get(grant.permission_code)!;
        for (const depCode of def.dependencies) {
          expect(
            grantMap.has(depCode),
            `[${templateId}] ${grant.permission_code} için bağımlılık ${depCode} şablonda bulunmalıdır!`,
          ).toBe(true);

          const depDef = catalogMap.get(depCode)!;
          if (def.scopeKind === 'RECORD_SCOPED' && depDef.scopeKind === 'RECORD_SCOPED') {
            const currentScope = grant.scope;
            const depScope = grantMap.get(depCode)!;
            const weight = (s: string) => (s === 'AGENCY' ? 2 : s === 'ASSIGNED' ? 1 : 0);
            expect(weight(currentScope)).toBeLessThanOrEqual(weight(depScope));
          }
        }
      }
    }
  });

  it('createOnboardingTemplateGrants her çağrıda bağımsız bir anlık görüntü (snapshot) üretmelidir', () => {
    const snapshot1 = createOnboardingTemplateGrants('personel');
    const snapshot2 = createOnboardingTemplateGrants('personel');

    expect(snapshot1).not.toBe(snapshot2);
    expect(snapshot1).toEqual(snapshot2);

    // Snapshot1'in mutasyonu snapshot2'yi veya kaynak şablonu etkilememelidir
    // @ts-expect-error - readonly alanı test amacıyla mutasyona uğratma
    snapshot1[0]!.scope = 'AGENCY';
    snapshot1.pop();

    const snapshot3 = createOnboardingTemplateGrants('personel');
    expect(snapshot3).toHaveLength(20);
    expect(snapshot3[0]!.scope).toBe('ASSIGNED');
    expect(snapshot3).toEqual(snapshot2);

    // Tanımsız şablon kimliği hata vermelidir
    expect(() =>
      createOnboardingTemplateGrants('gecersiz_sablon' as unknown as OnboardingTemplateId),
    ).toThrow(/Geçersiz onboarding şablonu/);
  });

  it('STABLE_SCOPE_RESOLVERS runtime Object.freeze ile dondurulmuş olmalıdır', () => {
    expect(Object.isFrozen(STABLE_SCOPE_RESOLVERS)).toBe(true);
    expect(() => {
      // @ts-expect-error - dondurulmuş diziye eleman ekleme testi
      STABLE_SCOPE_RESOLVERS.push('malicious_resolver');
    }).toThrow();
  });
});
