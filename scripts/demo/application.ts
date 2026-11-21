import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import { createApp, createWorker, type Env } from '../../src/server/index';
import { localAdminPasswordHasher } from '../../src/server/auth/password-admin';
import { validatePermanentPassword } from '../../src/server/auth/password';
import { createOnboardingTemplateGrants } from '../../src/shared/permissions';
import { createCustomerNote } from '../../src/server/customers/notes';
import { createRenewalQuote } from '../../src/server/renewals/engagement';
import { ensureRenewalForPolicy } from '../../src/server/renewals/generation';
import type { AuthenticatedUserContext } from '../../src/server/auth/identity';

export const DEMO_ORIGIN = 'https://localhost:8443';
export const DEMO_USERS = [
  { id: 'owner', name: 'Acente Sahibi', email: 'sahip@demo.invalid', type: 'OWNER' },
  { id: 'ahmet', name: 'Ahmet', email: 'ahmet@demo.invalid', type: 'MEMBER' },
  { id: 'ayse', name: 'Ayşe', email: 'ayse@demo.invalid', type: 'MEMBER' },
] as const;
function limiter(maximum: number): RateLimit {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async limit({ key }: { key: string }) {
      const now = Date.now();
      let entry = windows.get(key);
      if (!entry || now - entry.start >= 60000) {
        entry = { start: now, count: 0 };
        windows.set(key, entry);
      }
      return { success: ++entry.count <= maximum };
    },
  } as RateLimit;
}

/** Offline CLI-only composition. Fresh in-memory D1; no config, dotenv, remote
 * adapter, existing persistence directory, credential bypass or session seed. */
export async function openDemo(
  passwords: readonly string[],
  options: { companyRegistrationActors?: readonly (typeof DEMO_USERS)[number]['id'][] } = {},
) {
  if (passwords.length !== 3) throw new Error('Üç farklı demo hesabı parolası gereklidir.');
  const verifiers: string[] = [];
  for (const [index, user] of DEMO_USERS.entries())
    verifiers.push(
      await localAdminPasswordHasher.hash(validatePermanentPassword(passwords[index], user.email)),
    );
  const { Miniflare, convertV4MiniflareOptions } = miniflare;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response(null)}}',
      cf: false,
      d1Databases: { DB: '00000000-0000-4000-8000-00000000de00' },
    }),
  );
  try {
    const db = await mf.getD1Database('DB');
    for (const file of readdirSync('db/migrations')
      .filter((file) => /^\d{4}_.*\.sql$/.test(file))
      .sort())
      for (const sql of readFileSync(resolve('db/migrations', file), 'utf8')
        .split('--> statement-breakpoint')
        .map((value) => value.trim())
        .filter(Boolean))
        await db.prepare(sql).run();
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO agencies(id,status) VALUES('demo-agency','PROVISIONING')").run();
    const contexts: AuthenticatedUserContext[] = [];
    for (const [index, user] of DEMO_USERS.entries()) {
      await db
        .prepare("INSERT INTO users(id,status,display_name) VALUES(?,'ACTIVE',?)")
        .bind('demo-user-' + user.id, user.name)
        .run();
      await db
        .prepare(
          "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,email_provenance) VALUES(?,?,'urn:mayisigorta:local-auth:v1',?,?,'OWNER_PROVISIONED')",
        )
        .bind(
          'demo-identity-' + user.id,
          'demo-user-' + user.id,
          'demo-subject-' + user.id,
          user.email,
        )
        .run();
      await db
        .prepare(
          "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES(?,'demo-agency',?,?,'INVITED',?,'2099-01-01T00:00:00.000Z')",
        )
        .bind('demo-member-' + user.id, 'demo-user-' + user.id, user.type, user.email)
        .run();
      await db
        .prepare(
          "UPDATE agency_memberships SET status='ACTIVE',activated_at=?,version=version+1,permission_version=permission_version+1 WHERE id=?",
        )
        .bind(now, 'demo-member-' + user.id)
        .run();
      await db
        .prepare(
          'INSERT INTO local_credentials(user_id,identity_id,login_email,verifier,must_change_password,updated_at) VALUES(?,?,?,?,0,?)',
        )
        .bind(
          'demo-user-' + user.id,
          'demo-identity-' + user.id,
          user.email,
          verifiers[index],
          Date.now(),
        )
        .run();
      if (user.type === 'OWNER')
        await db
          .prepare(
            "UPDATE agencies SET status='ACTIVE',bootstrap_completed_at=?,activated_at=?,version=version+1 WHERE id='demo-agency'",
          )
          .bind(now, now)
          .run();
      else
        await db.batch(
          createOnboardingTemplateGrants('personel').map((grant) =>
            db
              .prepare(
                'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
              )
              .bind(
                crypto.randomUUID(),
                'demo-member-' + user.id,
                grant.permission_code,
                grant.scope,
              ),
          ),
        );
      if (options.companyRegistrationActors?.includes(user.id)) {
        await db.batch(
          ['sensitive.identity.read', 'sensitive.identity.write'].map((permission) =>
            db
              .prepare(
                "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,'UNSCOPED')",
              )
              .bind(crypto.randomUUID(), 'demo-member-' + user.id, permission),
          ),
        );
      }
      contexts.push({
        userId: 'demo-user-' + user.id,
        identityId: 'demo-identity-' + user.id,
        assurance: 'NORMAL',
        memberships: [
          {
            id: 'demo-member-' + user.id,
            agencyId: 'demo-agency',
            type: user.type,
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      });
    }
    await db.batch([
      db.prepare(
        "INSERT INTO insurers(id,agency_id,code,name) VALUES('demo-insurer','demo-agency','ANADOLU','Anadolu Sigorta')",
      ),
      db.prepare(
        "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('demo-branch','demo-agency','AUTO','Kasko','GENERAL')",
      ),
      db.prepare(
        "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('demo-product','demo-agency','demo-insurer','demo-branch','KASKO','Kasko')",
      ),
      db.prepare(
        "INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments) VALUES('demo-payment','demo-agency','CASH','Peşin',0,12)",
      ),
      db.prepare(
        "INSERT INTO loss_reasons(id,agency_id,code,name) VALUES('demo-loss-price','demo-agency','PRICE','Fiyat nedeniyle'),('demo-loss-other','demo-agency','OTHER','Diğer')",
      ),
      db.prepare(
        "INSERT INTO agency_settings(id,agency_id,default_insurer_id) VALUES('demo-settings','demo-agency','demo-insurer')",
      ),
    ]);
    const names = [
      ['Deniz', 'Yılmaz'],
      ['Ece', 'Kaya'],
      ['Mert', 'Demir'],
      ['Selin', 'Çelik'],
      ['Can', 'Aydın'],
      ['Derya', 'Şahin'],
      ['Bora', 'Arslan'],
      ['İpek', 'Koç'],
      ['Oğuz', 'Yıldız'],
      ['Elif', 'Aksoy'],
    ];
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Istanbul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const date = (days: number) =>
      new Date(Date.parse(today + 'T00:00:00.000Z') + days * 86400000).toISOString().slice(0, 10);
    for (const [index, [first, last]] of names.entries()) {
      const employee = (index % 2) + 1,
        context = contexts[employee]!;
      await db
        .prepare(
          "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,email,assignee_membership_id) VALUES(?,'demo-agency','INDIVIDUAL',?,?,?,?,?)",
        )
        .bind(
          'demo-customer-' + index,
          `${first} ${last}`,
          first,
          last,
          `musteri${index}@example.invalid`,
          context.memberships[0]!.id,
        )
        .run();
      await db
        .prepare(
          "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES(?,'demo-agency',?,'demo-insurer','demo-product','demo-branch','demo-payment',?,?,?, ?,?,?,'TRY')",
        )
        .bind(
          'demo-policy-' + index,
          'demo-customer-' + index,
          context.memberships[0]!.id,
          'DEMO-' + index,
          'DEMO' + index,
          date(-335),
          date(5 + index),
          1200000 + index * 50000,
        )
        .run();
      await ensureRenewalForPolicy(db, 'demo-agency', 'demo-policy-' + index);
      const renewal = await db
        .prepare('SELECT id,version FROM renewal_opportunities WHERE expiring_policy_id=?')
        .bind('demo-policy-' + index)
        .first<{ id: string; version: number }>();
      if (!renewal) throw new Error('DEMO_RENEWAL_MISSING');
      await db
        .prepare("UPDATE tasks SET due_at=?,version=version+1 WHERE renewal_id=? AND status='OPEN'")
        .bind(`${date(index < 4 ? -1 : index < 8 ? 0 : 2)}T09:00:00.000Z`, renewal.id)
        .run();
      await createCustomerNote(
        db,
        context,
        'demo-customer-' + index,
        { content: 'Tamamen kurgusal demo kaydı. Yenileme için görüşme planlandı.' },
        'demo-note-' + index,
      );
      await createRenewalQuote(
        context,
        db,
        renewal.id,
        {
          expectedRenewalVersion: renewal.version,
          version: {
            insurerId: 'demo-insurer',
            productId: 'demo-product',
            branchId: 'demo-branch',
            paymentMethodId: 'demo-payment',
            startDate: date(6 + index),
            endDate: date(371 + index),
            validUntil: new Date(Date.now() + 7 * 86400000).toISOString(),
            grossPremiumMinor: 1400000 + index * 50000,
            currency: 'TRY',
            installmentCount: null,
            termsSummary: 'Sentetik demo teklifi',
          },
        },
        'demo-quote-' + index,
      );
    }
    await createCustomerNote(
      db,
      contexts[2]!,
      'demo-customer-0',
      { content: 'Ayşe tarafından eklenen ortak müşteri notu.' },
      'demo-note-shared',
    );
    const env: Env = {
      DB: db,
      APP_ENV: 'development',
      PANEL_ORIGIN: DEMO_ORIGIN,
      CSRF_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),
      IDENTITY_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
        'hex',
      ),
      IDENTITY_HMAC_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),
      IDENTITY_KEY_VERSION: '1',
      DOCUMENTS_ENABLED: 'false',
      DOCUMENT_JOBS_ENABLED: 'false',
      DOCUMENT_CRON_ENABLED: 'false',
      RENEWAL_CONTINUATION_ENABLED: 'false',
      AUTH_ACCOUNT_RATE_LIMITER: limiter(10),
      AUTH_SOURCE_RATE_LIMITER: limiter(1000),
    };
    const app = createApp({ passwordHasher: localAdminPasswordHasher });
    const worker = createWorker(app);
    return {
      db,
      async fetch(request: Request, assets?: (request: Request) => Promise<Response>) {
        return worker.fetch(
          request,
          assets ? { ...env, ASSETS: { fetch: assets } as Fetcher } : env,
          { waitUntil: () => {} } as unknown as ExecutionContext,
        );
      },
      async dispose() {
        await mf.dispose();
      },
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
