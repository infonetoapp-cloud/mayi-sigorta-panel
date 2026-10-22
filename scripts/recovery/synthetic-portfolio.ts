// Local/synthetic source producer, reusing Gate A's actual D1/API seed path.
// No caller-supplied seed, target, config, data file or credential is accepted.
import { createSyntheticAuthBackup } from './local-auth-restore-proof';
import { createApp } from '../../src/server/index';
import { createOnboardingTemplateGrants } from '../../src/shared/permissions';
import {
  randomSessionToken,
  hashSessionToken,
  sessionInsert,
  NORMAL_ABSOLUTE_MS,
} from '../../src/server/auth/session';

export async function createOps001Portfolio() {
  const app = createApp({
    passwordHasher: {
      supports: () => false,
      async hash() {
        throw new Error('KDF_FORBIDDEN');
      },
      async verify() {
        return { matches: false, needsRehash: false };
      },
    },
  });
  const agency = 'synthetic-auth-agency',
    owner = 'synthetic-temporary';
  const cookies: Record<string, string> = {};
  return createSyntheticAuthBackup(undefined, async (db) => {
    const now = Date.now(),
      iso = new Date(now).toISOString();
    await db
      .prepare(
        'UPDATE local_credentials SET must_change_password=0,temporary_expires_at=NULL,credential_version=credential_version+1,updated_at=? WHERE user_id=?',
      )
      .bind(now, owner)
      .run();
    for (const id of ['offboard', 'revoked'])
      await db.batch([
        db.prepare("INSERT INTO users(id,status) VALUES(?,'ACTIVE')").bind(`synthetic-${id}`),
        db
          .prepare(
            "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,email_provenance) VALUES(?,?,'urn:mayisigorta:local-auth:v1',?,?,'OWNER_PROVISIONED')",
          )
          .bind(
            `synthetic-identity-${id}`,
            `synthetic-${id}`,
            `synthetic-subject-${id}`,
            `${id}@example.invalid`,
          ),
        db
          .prepare(
            "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,permission_version,invitation_email,invitation_expires_at,activated_at) VALUES(?,?,?,'MEMBER','ACTIVE',3,?,'2099-01-01T00:00:00.000Z',?)",
          )
          .bind(
            `synthetic-membership-${id}`,
            agency,
            `synthetic-${id}`,
            `${id}@example.invalid`,
            iso,
          ),
        db
          .prepare(
            'INSERT INTO local_credentials(user_id,identity_id,login_email,verifier,credential_version,must_change_password,updated_at) VALUES(?,?,?,?,7,0,?)',
          )
          .bind(
            `synthetic-${id}`,
            `synthetic-identity-${id}`,
            `${id}@example.invalid`,
            'synthetic-offline-verifier',
            now,
          ),
      ]);
    await db.batch(
      createOnboardingTemplateGrants('personel').map((g) =>
        db
          .prepare(
            'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
          )
          .bind(crypto.randomUUID(), 'synthetic-membership-permanent', g.permission_code, g.scope),
      ),
    );
    for (const id of [owner, 'synthetic-permanent', 'synthetic-offboard', 'synthetic-revoked']) {
      const principal = await db
        .prepare(
          'SELECT c.user_id,c.identity_id,c.credential_version,m.id AS membership_id,m.permission_version FROM local_credentials c JOIN agency_memberships m ON m.user_id=c.user_id WHERE c.user_id=?',
        )
        .bind(id)
        .first<{
          user_id: string;
          identity_id: string;
          credential_version: number;
          membership_id: string;
          permission_version: number;
        }>();
      if (!principal) throw new Error('SYNTHETIC_PRINCIPAL_MISSING');
      const token = randomSessionToken();
      await sessionInsert(
        db,
        await hashSessionToken(token),
        principal,
        'NORMAL',
        now,
        now + NORMAL_ABSOLUTE_MS,
        now,
      ).run();
      cookies[id] = `__Host-mayi-session=${token}`;
    }
    await db
      .prepare(
        "UPDATE agency_memberships SET status='SUSPENDED',suspended_at=?,version=version+1,permission_version=permission_version+1 WHERE id='synthetic-membership-revoked'",
      )
      .bind(iso)
      .run();
    await db.batch([
      db
        .prepare(
          "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('ops-health',?,'HEALTH','Synthetic health','HEALTH')",
        )
        .bind(agency),
      db
        .prepare(
          "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('ops-health-product',?,'synthetic-insurer','ops-health','HEALTH','Synthetic health')",
        )
        .bind(agency),
      db
        .prepare(
          "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('ops-health-policy',?,'synthetic-customer','synthetic-insurer','ops-health-product','ops-health','synthetic-payment','synthetic-membership-temporary','OPS-HEALTH','OPS-HEALTH','2026-01-01','2026-09-15',123456,'TRY')",
        )
        .bind(agency),
    ]);
    const request = (path: string, body?: unknown, csrf?: string, key?: string) =>
      app.fetch(
        new Request('https://panel.mayisigorta.com' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            cookie: cookies[owner]!,
            ...(body === undefined
              ? {}
              : { origin: 'https://panel.mayisigorta.com', 'content-type': 'application/json' }),
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
            ...(key ? { 'idempotency-key': key } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        {
          DB: db,
          APP_ENV: 'test',
          PANEL_ORIGIN: 'https://panel.mayisigorta.com',
          CSRF_SECRET: 'synthetic-local-ops001-csrf-not-a-production-secret',
          DOCUMENTS_ENABLED: 'false',
        },
      );
    async function data(response: Response, status: number) {
      if (response.status !== status) throw new Error('SYNTHETIC_API_SEED_FAILED');
      return ((await response.json()) as { data: Record<string, unknown> }).data;
    }
    const csrf = String((await data(await request('/api/auth/csrf-token'), 200)).token);
    const post = (path: string, body: unknown, key: string = crypto.randomUUID()) =>
      request(path, body, csrf, key);
    const url = '/api/renewals/synthetic-renewal-00/quotes';
    const defaults = (await data(await request(url), 200)).defaultVersion as Record<
      string,
      unknown
    >;
    const renewal = await db
      .prepare("SELECT version FROM renewal_opportunities WHERE id='synthetic-renewal-00'")
      .first<{ version: number }>();
    const version = {
      ...defaults,
      validUntil: '2099-01-01T00:00:00.000Z',
      grossPremiumMinor: 12345,
    };
    const quote = await data(
      await post(url, { expectedRenewalVersion: renewal!.version, version }),
      201,
    );
    const revision = await data(
      await post(`${url}/${quote.quoteId}/versions`, {
        expectedQuoteVersion: 1,
        version: { ...version, grossPremiumMinor: 23456 },
      }),
      201,
    );
    const key = crypto.randomUUID(),
      body = { expectedQuoteVersion: 2, quoteVersionId: revision.quoteVersionId };
    const first = await data(await post(`${url}/${quote.quoteId}/send`, body, key), 201);
    const repeat = await data(await post(`${url}/${quote.quoteId}/send`, body, key), 200);
    if (JSON.stringify(first) !== JSON.stringify(repeat))
      throw new Error('SYNTHETIC_RECEIPT_REPLAY_FAILED');
  });
}
