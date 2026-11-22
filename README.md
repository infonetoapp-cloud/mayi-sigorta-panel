# Mayı Sigorta CRM

Geliştirme için repodaki `.node-version` dosyasında belirtilen Node.js sürümünü kullanın. Yerel demo, OpenSSL ile oluşturulan bir test sertifikası, geçici D1 veritabanı ve sentetik kayıtlarla çalışır.

```sh
npm ci
npm run demo
```

## GitHub Actions

[CRM CI](.github/workflows/ci.yml) ana dala veya `codex/ui-modernization` dalına gönderilen kodu ve bu dalları hedefleyen birleştirme isteklerini denetler.

| Kontrol                  | Kapsam                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Code and build           | Biçim, lint, TypeScript, istemci paketi, kaynak sınırları, Worker deneme derlemesi ve üretim bağımlılığı taraması |
| Application and D1 tests | Yetki ve günlük kullanım regresyonları, geçici D1 üzerinde gerçek API testleri                                    |
| Browser smoke test       | Sentetik hesaplarla giriş, müşteri, yetki ve poliçe işlemleri                                                     |

Sonuçlar GitHub’ın **Actions** sekmesinde ve ilgili birleştirme isteğinin **Checks** bölümünde görünür. Ana dala alındığında tüm Vitest testleri **Run workflow** üzerinden `full_suite` seçilerek ayrıca çalıştırılabilir. Yerel karşılığı `npm test -- --maxWorkers=2` komutudur.

CI yalnızca doğrulama yapar. Testler geçici veritabanları ve sentetik kayıtlar kullanır. Canlı yayın ayrı bir işlemdir.

[Proje mimarisi ve uygulama durumu](MayiSigorta_CRM_Planning_Pack_v2/README.md)
