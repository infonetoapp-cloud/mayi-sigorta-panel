// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';
import { createApp, type Env } from '../src/server/index';
import type { VerifiedAccessPrincipal } from '../src/server/auth/types';
import {
  previewRenewalWhatsApp,
  openRenewalWhatsApp,
  listRenewalInteractions,
  createRenewalInteraction,
} from '../src/server/renewals/engagement';
import { openRenewalWhatsAppSchema } from '../src/server/renewals/validation';
import { normalizeWhatsAppPhone } from '../src/server/renewals/whatsapp-target';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const actor: AuthenticatedUserContext = {
  userId: 'wa-user',
  identityId: 'wa-identity',
  assurance: 'NORMAL',
  memberships: [
    {
      id: 'wa-member',
      agencyId: 'wa-agency',
      type: 'OWNER',
      status: 'ACTIVE',
      permissionVersion: 2,
    },
  ],
};
let db: D1Database;
let mf: miniflare.Miniflare;
let member: AuthenticatedUserContext = {
  userId: 'wa-staff',
  identityId: 'wa-staff-identity',
  assurance: 'NORMAL',
  memberships: [
    {
      id: 'wa-staff-member',
      agencyId: 'wa-agency',
      type: 'MEMBER',
      status: 'ACTIVE',
      permissionVersion: 2,
    },
  ],
};
async function openInput(id: string, contactId: string | null = null, context = actor) {
  const preview = await previewRenewalWhatsApp(context, db, id, { companyContactId: contactId });
  return {
    companyContactId: contactId,
    expectedRenewalVersion: preview.expectedRenewalVersion,
    expectedPhone: preview.phone,
    message: preview.message,
  };
}
function beforeBatch(effect: () => Promise<unknown>) {
  let changed = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!changed) {
            changed = true;
            await effect();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;
}
async function seed(
  suffix: string,
  type = 'INDIVIDUAL',
  phone: string | null = '+90 (532) 123-45-67',
) {
  const customer = `c-${suffix}`;
  const renewal = `r-${suffix}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,company_title,phone,assignee_membership_id)
      VALUES(?,'wa-agency',?,'Sensitive hidden metadata',?,?,?,?,'wa-member')`,
      )
      .bind(
        customer,
        type,
        type === 'INDIVIDUAL' ? 'Test' : null,
        type === 'INDIVIDUAL' ? 'Customer' : null,
        type === 'COMPANY' ? 'Company' : null,
        phone,
      ),
    db
      .prepare(
        `INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
      assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency)
      VALUES(?,'wa-agency',?,'wa-insurer','wa-product','wa-branch','wa-payment','wa-member',?,?,'2026-01-01','2026-12-01',10000,'TRY')`,
      )
      .bind(`p-${suffix}`, customer, suffix, suffix),
    db
      .prepare(
        `INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id,state)
      VALUES(?,'wa-agency',?,'wa-member','CONTACT_PENDING')`,
      )
      .bind(renewal, `p-${suffix}`),
    db
      .prepare(
        `INSERT INTO tasks(id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,status,actor_kind)
      VALUES(?,'wa-agency',?,?,'RENEWAL_FOLLOWUP','Follow-up','2026-10-01T00:00:00.000Z','wa-member','OPEN','SYSTEM')`,
      )
      .bind(`t-${suffix}`, customer, renewal),
  ]);
  return renewal;
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response(null); } }',
      d1Databases: { DB: '00000000-0000-0000-0000-000000000044' },
    }),
  );
  db = await mf.getD1Database('DB');
  const folder = resolve(__dirname, '../db/migrations');
  for (const file of readdirSync(folder)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort()) {
    for (const sql of readFileSync(resolve(folder, file), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  }
  await db.batch([
    db.prepare("INSERT INTO agencies(id,status) VALUES('wa-agency','PROVISIONING')"),
    db.prepare("INSERT INTO users(id,status) VALUES('wa-user','INACTIVE')"),
    db.prepare(`INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at)
      VALUES('wa-member','wa-agency','wa-user','OWNER','INVITED','wa@test.test','2099-01-01T00:00:00.000Z')`),
    db.prepare(`INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
      VALUES('wa-identity','wa-user','https://team.cloudflareaccess.com','wa-subject','wa@test.test','ACTIVE')`),
    db.prepare(`INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
      VALUES('wa-backup-identity','wa-user','https://team.cloudflareaccess.com','wa-backup-subject','wa@test.test','ACTIVE')`),
  ]);
  await db.prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='wa-user'").run();
  await db
    .prepare(
      "UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',permission_version=2,version=2 WHERE id='wa-member'",
    )
    .run();
  await db
    .prepare(
      "UPDATE agencies SET status='ACTIVE',bootstrap_completed_at='2026-01-01T00:00:00.000Z',activated_at='2026-01-01T00:00:00.000Z',version=2 WHERE id='wa-agency'",
    )
    .run();
  await db.batch([
    db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('wa-insurer','wa-agency','I','Insurer')",
    ),
    db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('wa-branch','wa-agency','AUTO','Auto','GENERAL')",
    ),
    db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('wa-product','wa-agency','wa-insurer','wa-branch','AUTO','Auto')",
    ),
    db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments) VALUES('wa-payment','wa-agency','CASH','Cash',0,12)",
    ),
  ]);
  await db.batch([
    db.prepare("INSERT INTO users(id,status) VALUES('wa-staff','INACTIVE')"),
    db.prepare(`INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at)
      VALUES('wa-staff-member','wa-agency','wa-staff','MEMBER','INVITED','staff@test.test','2099-01-01T00:00:00.000Z')`),
    db.prepare(`INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
      VALUES('wa-staff-identity','wa-staff','https://team.cloudflareaccess.com','staff-subject','staff@test.test','ACTIVE')`),
  ]);
  await db.prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='wa-staff'").run();
  await db
    .prepare(
      "UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',permission_version=2,version=2 WHERE id='wa-staff-member'",
    )
    .run();
  for (const code of [
    'customer.read',
    'policy.read',
    'renewal.read',
    'interaction.read',
    'interaction.create',
  ]) {
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,'wa-staff-member',?,'AGENCY')",
      )
      .bind(`staff-${code}`, code)
      .run();
  }
}, 180000);
afterAll(async () => {
  await mf?.dispose();
});

describe('M4 WhatsApp preview/open semantics', () => {
  it('does not allow manual WHATSAPP_OPENED through the generic interaction command', async () => {
    const id = await seed('manual-open');
    await expect(
      createRenewalInteraction(
        actor,
        db,
        id,
        {
          outcome: 'WHATSAPP_OPENED',
          channel: 'WHATSAPP',
          occurredAt: new Date().toISOString(),
          companyContactId: null,
          note: null,
        },
        'manual-open-key',
      ),
    ).rejects.toThrow();
  });
  it('returns actionable missing/invalid phone errors without writing business evidence', async () => {
    const missing = await seed('missing', 'INDIVIDUAL', null);
    await expect(
      previewRenewalWhatsApp(actor, db, missing, { companyContactId: null }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_PHONE_REQUIRED' });
    const invalid = await seed('invalid', 'INDIVIDUAL', '905321234567?text=secret\n&x=1');
    await expect(
      previewRenewalWhatsApp(actor, db, invalid, { companyContactId: null }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_PHONE_INVALID' });
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM renewal_interactions WHERE renewal_id IN (?,?)')
        .bind(missing, invalid)
        .first(),
    ).toEqual({ n: 0 });
  });
  it('selects only the exact active CompanyContact under the authorized company, never company fallback or a foreign phone', async () => {
    const id = await seed('company', 'COMPANY', '905555555555');
    await seed('other-company', 'COMPANY');
    await db.batch([
      db.prepare(`INSERT INTO company_contacts(id,agency_id,customer_id,first_name,last_name,phone,is_primary)
        VALUES('cc','wa-agency','c-company','Safe','Contact','0532 123 45 67',1),
          ('wrong-cc','wa-agency','c-other-company','Wrong','Contact','905551111111',1)`),
      db.prepare("INSERT INTO agencies(id,status) VALUES('foreign-agency','PROVISIONING')"),
      db.prepare(`INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at)
        VALUES('foreign-member','foreign-agency','wa-user','OWNER','INVITED','foreign@test.test','2099-01-01T00:00:00.000Z')`),
      db.prepare(
        "INSERT INTO customers(id,agency_id,type,display_name,company_title,assignee_membership_id) VALUES('foreign-company','foreign-agency','COMPANY','Foreign','Foreign','foreign-member')",
      ),
      db.prepare(
        "INSERT INTO company_contacts(id,agency_id,customer_id,first_name,last_name,phone) VALUES('foreign-cc','foreign-agency','foreign-company','Foreign','Contact','905552222222')",
      ),
    ]);
    await expect(
      previewRenewalWhatsApp(actor, db, id, { companyContactId: null }),
    ).rejects.toMatchObject({ code: 'COMPANY_CONTACT_REQUIRED' });
    for (const contactId of ['wrong-cc', 'foreign-cc']) {
      await expect(
        previewRenewalWhatsApp(actor, db, id, { companyContactId: contactId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        openRenewalWhatsApp(
          actor,
          db,
          id,
          {
            companyContactId: contactId,
            expectedRenewalVersion: 1,
            expectedPhone: '905321234567',
            message: 'Hello',
          },
          `denied-${contactId}`,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    const input = await openInput(id, 'cc');
    expect(input.expectedPhone).toBe('905321234567');
    await expect(
      openRenewalWhatsApp(
        actor,
        db,
        id,
        { ...input, expectedPhone: '905555555555' },
        'phone-injection',
      ),
    ).rejects.toMatchObject({ code: 'WHATSAPP_PREVIEW_STALE' });
    await openRenewalWhatsApp(actor, db, id, input, 'company-open');
    expect(
      await db
        .prepare(
          'SELECT company_contact_id,customer_id FROM renewal_interactions WHERE renewal_id=?',
        )
        .bind(id)
        .first(),
    ).toEqual({ company_contact_id: 'cc', customer_id: 'c-company' });
    await db
      .prepare("UPDATE company_contacts SET status='INACTIVE',version=version+1 WHERE id='cc'")
      .run();
    await expect(openRenewalWhatsApp(actor, db, id, input, 'company-open')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('denies a foreign agency context and a missing normal permission at both preview and open', async () => {
    const id = await seed('normal-deny');
    const input = await openInput(id);
    const foreign = {
      ...actor,
      memberships: [{ ...actor.memberships[0]!, agencyId: 'foreign-agency' }],
    };
    await expect(
      previewRenewalWhatsApp(foreign, db, id, { companyContactId: null }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(openRenewalWhatsApp(foreign, db, id, input, 'foreign-open')).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    await db
      .prepare("DELETE FROM membership_permissions WHERE id='staff-interaction.create'")
      .run();
    try {
      await expect(
        previewRenewalWhatsApp(member, db, id, { companyContactId: null }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        openRenewalWhatsApp(member, db, id, input, 'missing-permission'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await db
        .prepare(
          "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('staff-interaction.create','wa-staff-member','interaction.create','AGENCY')",
        )
        .run();
    }
  });
  it('requires explicit HEALTH permissions even for OWNER and never templates restricted fields', async () => {
    const id = await seed('health');
    const input = await openInput(id);
    await db
      .prepare("UPDATE insurance_branches SET data_classification='HEALTH' WHERE id='wa-branch'")
      .run();
    try {
      for (const context of [actor, member]) {
        await expect(
          previewRenewalWhatsApp(context, db, id, { companyContactId: null }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          openRenewalWhatsApp(context, db, id, input, 'health-deny'),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      for (const code of ['sensitive.health.read', 'sensitive.health.write'])
        await db
          .prepare(
            "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,'wa-member',?,'UNSCOPED')",
          )
          .bind(code, code)
          .run();
      const preview = await previewRenewalWhatsApp(actor, db, id, { companyContactId: null });
      expect(preview.message).toBe(input.message);
      expect(preview.message).not.toMatch(/HEALTH|Sensitive|TCKN|token|key|r2|policy|document/i);
    } finally {
      await db
        .prepare("UPDATE insurance_branches SET data_classification='GENERAL' WHERE id='wa-branch'")
        .run();
      await db.prepare("DELETE FROM membership_permissions WHERE membership_id='wa-member'").run();
    }
  });
  it('denies revoked permission after preview, including completed exact replay', async () => {
    const id = await seed('revocation');
    const input = await openInput(id, null, member);
    await openRenewalWhatsApp(member, db, id, input, 'before-revoke');
    await db
      .prepare("DELETE FROM membership_permissions WHERE id='staff-interaction.create'")
      .run();
    try {
      for (const key of ['after-revoke', 'before-revoke'])
        await expect(openRenewalWhatsApp(member, db, id, input, key)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
    } finally {
      await db
        .prepare(
          "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('staff-interaction.create','wa-staff-member','interaction.create','AGENCY')",
        )
        .run();
    }
  });
  it('atomically rolls back open when phone changes after resolution', async () => {
    const id = await seed('phone-race');
    const input = await openInput(id);
    const raced = beforeBatch(() =>
      db
        .prepare(
          "UPDATE customers SET phone='905339999999',version=version+1 WHERE id='c-phone-race'",
        )
        .run(),
    );
    await expect(
      openRenewalWhatsApp(actor, raced, id, input, 'phone-race-key'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM renewal_interactions WHERE renewal_id=?')
        .bind(id)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM operation_receipts WHERE idempotency_key='phone-race-key'",
        )
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM audit_events WHERE idempotency_key='phone-race-key'")
        .first(),
    ).toEqual({ n: 0 });
  });
  it('enforces scope dependencies inside the mutation batch without relying on permission_version changes', async () => {
    const id = await seed('scope-race');
    const input = await openInput(id, null, member);
    const raced = beforeBatch(() =>
      db
        .prepare(
          "UPDATE membership_permissions SET scope='ASSIGNED' WHERE id='staff-interaction.read'",
        )
        .run(),
    );
    try {
      await expect(
        openRenewalWhatsApp(member, raced, id, input, 'scope-race-key'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await db
        .prepare(
          "UPDATE membership_permissions SET scope='AGENCY' WHERE id='staff-interaction.read'",
        )
        .run();
    }
  });
  it('rejects stale renewal version without completing follow-up', async () => {
    const id = await seed('cas');
    const input = await openInput(id);
    await expect(
      openRenewalWhatsApp(actor, db, id, { ...input, expectedRenewalVersion: 2 }, 'cas-key'),
    ).rejects.toMatchObject({ code: 'OPTIMISTIC_CONCURRENCY_CONFLICT' });
    expect(
      await db.prepare('SELECT status FROM tasks WHERE renewal_id=?').bind(id).first(),
    ).toEqual({ status: 'OPEN' });
  });
  it('converges concurrent exact opens on one interaction, receipt and success audit', async () => {
    const id = await seed('concurrent');
    const input = await openInput(id);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racing = new Proxy(db, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (++arrivals === 2) release();
            await barrier;
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const results = await Promise.all([
      openRenewalWhatsApp(actor, racing, id, input, 'concurrent-key'),
      openRenewalWhatsApp(actor, racing, id, input, 'concurrent-key'),
    ]);
    expect(results[0]!.data).toEqual(results[1]!.data);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    for (const table of ['operation_receipts', 'audit_events'])
      expect(
        await db
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE idempotency_key='concurrent-key'`)
          .first(),
      ).toEqual({ n: 1 });
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM renewal_interactions WHERE renewal_id=?')
        .bind(id)
        .first(),
    ).toEqual({ n: 1 });
  });
  it('reauthorizes ASSIGNED replay after reassignment and permits AGENCY access', async () => {
    const id = await seed('assigned');
    await db
      .prepare(
        "UPDATE customers SET assignee_membership_id='wa-staff-member',version=version+1 WHERE id='c-assigned'",
      )
      .run();
    await db
      .prepare(
        "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='wa-staff-member'",
      )
      .run();
    try {
      const input = await openInput(id, null, member);
      const opened = await openRenewalWhatsApp(member, db, id, input, 'assigned-key');
      await db
        .prepare(
          "UPDATE customers SET assignee_membership_id='wa-member',version=version+1 WHERE id='c-assigned'",
        )
        .run();
      await expect(
        openRenewalWhatsApp(member, db, id, input, 'assigned-key'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await db
        .prepare(
          "UPDATE membership_permissions SET scope='AGENCY' WHERE membership_id='wa-staff-member'",
        )
        .run();
      expect((await openRenewalWhatsApp(member, db, id, input, 'assigned-key')).data).toEqual(
        opened.data,
      );
    } finally {
      await db
        .prepare(
          "UPDATE membership_permissions SET scope='AGENCY' WHERE membership_id='wa-staff-member'",
        )
        .run();
    }
  });
  it('denies inactive membership and identity revocation between preflight and batch', async () => {
    const id = await seed('identity-race');
    const input = await openInput(id, null, member);
    const raced = beforeBatch(() =>
      db
        .prepare(
          "UPDATE auth_identities SET status='REVOKED',revoked_at='2026-10-04T00:00:00.000Z',version=version+1 WHERE id='wa-staff-identity'",
        )
        .run(),
    );
    try {
      await expect(
        openRenewalWhatsApp(member, raced, id, input, 'identity-race-key'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await db
        .prepare(
          "UPDATE auth_identities SET status='ACTIVE',revoked_at=NULL,version=version+1 WHERE id='wa-staff-identity'",
        )
        .run();
    }
    await db
      .prepare(
        "UPDATE agency_memberships SET status='SUSPENDED',suspended_at='2026-10-04T00:00:00.000Z',permission_version=permission_version+1,version=version+1 WHERE id='wa-staff-member'",
      )
      .run();
    try {
      await expect(
        openRenewalWhatsApp(member, db, id, input, 'inactive-member-key'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await db
        .prepare(
          "UPDATE agency_memberships SET status='ACTIVE',suspended_at=NULL,permission_version=permission_version+1,version=version+1 WHERE id='wa-staff-member'",
        )
        .run();
      member = { ...member, memberships: [{ ...member.memberships[0]!, permissionVersion: 4 }] };
    }
  });
  it('rejects HEALTH reclassification during open instead of using cached GENERAL authority', async () => {
    const id = await seed('health-race');
    const input = await openInput(id);
    const raced = beforeBatch(() =>
      db
        .prepare("UPDATE insurance_branches SET data_classification='HEALTH' WHERE id='wa-branch'")
        .run(),
    );
    try {
      await expect(
        openRenewalWhatsApp(actor, raced, id, input, 'health-race-key'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await db
        .prepare("UPDATE insurance_branches SET data_classification='GENERAL' WHERE id='wa-branch'")
        .run();
    }
  });
  it('rejects a corrupted persisted open DTO rather than disclosing arbitrary receipt fields', async () => {
    const id = await seed('corrupt');
    const input = await openInput(id);
    const opened = await openRenewalWhatsApp(actor, db, id, input, 'corrupt-key');
    const receipt = { ...opened.data } as Record<string, unknown>;
    delete receipt.url;
    await db
      .prepare("UPDATE operation_receipts SET response_body=? WHERE idempotency_key='corrupt-key'")
      .bind(JSON.stringify({ ...receipt, secret: 'PRIVATE_TOKEN' }))
      .run();
    await expect(openRenewalWhatsApp(actor, db, id, input, 'corrupt-key')).rejects.toMatchObject({
      code: 'REPLAY_NOT_AUTHORIZED',
    });
    await db
      .prepare("UPDATE operation_receipts SET response_body=? WHERE idempotency_key='corrupt-key'")
      .bind(JSON.stringify(receipt))
      .run();
    expect((await openRenewalWhatsApp(actor, db, id, input, 'corrupt-key')).data).toEqual(
      opened.data,
    );
  });
  it('binds replay to the exact immutable audited interaction, not a same-millisecond sibling', async () => {
    const id = await seed('sibling-receipt');
    const input = await openInput(id);
    const clock = vi
      .spyOn(Date.prototype, 'toISOString')
      .mockReturnValue('2026-10-04T12:00:00.000Z');
    try {
      const first = await openRenewalWhatsApp(actor, db, id, input, 'sibling-first');
      const second = await openRenewalWhatsApp(actor, db, id, input, 'sibling-second');
      const body = {
        operationId: first.data.operationId,
        interactionId: second.data.interactionId,
        renewalId: id,
        outcome: 'WHATSAPP_OPENED',
        occurredAt: second.data.occurredAt,
      };
      await db
        .prepare(
          "UPDATE operation_receipts SET response_body=? WHERE idempotency_key='sibling-first'",
        )
        .bind(JSON.stringify(body))
        .run();
      await expect(
        openRenewalWhatsApp(actor, db, id, input, 'sibling-first'),
      ).rejects.toMatchObject({ code: 'REPLAY_NOT_AUTHORIZED' });
    } finally {
      clock.mockRestore();
    }
  });
  it('bounds plain draft without claiming sensitive classification and rejects hidden authority fields', () => {
    const input = {
      companyContactId: null,
      expectedPhone: '905321234567',
      expectedRenewalVersion: 1,
      message: 'x',
    };
    for (const message of ['', ' '.repeat(2), 'x'.repeat(1001), 'x\u0000', 'x\r\n', 'x\u202e'])
      expect(openRenewalWhatsAppSchema.safeParse({ ...input, message }).success).toBe(false);
    expect(
      openRenewalWhatsAppSchema.safeParse({
        ...input,
        message: 'Hello\n&text=x#token=not-an-app-token',
      }).success,
    ).toBe(true);
    for (const field of ['tckn', 'documentToken', 'storageKey', 'agencyId', 'outcome', 'phone'])
      expect(openRenewalWhatsAppSchema.safeParse({ ...input, [field]: 'injected' }).success).toBe(
        false,
      );
  });
  it.each(['+90 (532) 123-45-67', '00905321234567', '05321234567', '5321234567', '905321234567'])(
    'normalizes allowed phone %s',
    (phone) => {
      expect(normalizeWhatsAppPhone(phone)).toBe('905321234567');
    },
  );
  it('wires no-store authorized preview and CSRF/idempotency guarded open routes', async () => {
    const id = await seed('routes');
    const app = createApp({
      createVerifier: (config) => ({
        config,
        verify: async () => ({ subject: 'wa-subject' }) as VerifiedAccessPrincipal,
      }),
      createResolver: () => ({ resolve: async () => actor }) as never,
    });
    const env: Env = {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUDIENCE: 'normal-audience',
      CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    };
    const base = `https://panel.mayisigorta.test/api/renewals/${id}`;
    const response = await app.request(`${base}/whatsapp-preview`, { method: 'GET' }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const preview = (
      (await response.json()) as {
        data: { phone: string; message: string; expectedRenewalVersion: number };
      }
    ).data;
    const body = JSON.stringify({
      companyContactId: null,
      expectedPhone: preview.phone,
      expectedRenewalVersion: preview.expectedRenewalVersion,
      message: preview.message,
    });
    const csrf = (
      (await (
        await app.request('https://panel.mayisigorta.test/api/csrf-token', {}, env)
      ).json()) as { data: { token: string } }
    ).data.token;
    const headers = {
      'Content-Type': 'application/json',
      Origin: 'https://panel.mayisigorta.com',
      'X-CSRF-Token': csrf,
      'Idempotency-Key': 'wa-route-open',
    };
    expect(
      (
        await app.request(
          `${base}/whatsapp-open`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
          env,
        )
      ).status,
    ).toBe(403);
    const opened = await app.request(
      `${base}/whatsapp-open`,
      { method: 'POST', headers, body },
      env,
    );
    expect(opened.status).toBe(201);
    expect(await opened.json()).toMatchObject({ data: { outcome: 'WHATSAPP_OPENED' } });
    expect(
      (await app.request(`${base}/whatsapp-open`, { method: 'POST', headers, body }, env)).status,
    ).toBe(200);
    expect((await app.request(`${base}/whatsapp-preview?phone=99999999999`, {}, env)).status).toBe(
      400,
    );
    expect(
      (
        await app.request(
          `${base}/whatsapp-open`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...JSON.parse(body), phone: '99999999999' }),
          },
          env,
        )
      ).status,
    ).toBe(400);
  });
  it('rechecks live identity after phone resolution before disclosing preview', async () => {
    const id = await seed('preview-revoke');
    const raced = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!sql.startsWith('SELECT phone FROM customers')) return stmt;
            return {
              bind: (...args: unknown[]) => ({
                first: async () => {
                  const row = await stmt.bind(...args).first();
                  await target
                    .prepare(
                      "UPDATE auth_identities SET status='REVOKED',revoked_at='2026-10-04T00:00:00.000Z',version=version+1 WHERE id='wa-identity'",
                    )
                    .run();
                  return row;
                },
              }),
            };
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    try {
      await expect(
        previewRenewalWhatsApp(actor, raced, id, { companyContactId: null }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await db
        .prepare(
          "UPDATE auth_identities SET status='ACTIVE',revoked_at=NULL,version=version+1 WHERE id='wa-identity'",
        )
        .run();
    }
  });
  it('records only WHATSAPP_OPENED, preserves renewal/task, replays once and confirms actual contact separately', async () => {
    const id = await seed('open');
    const preview = await previewRenewalWhatsApp(actor, db, id, { companyContactId: null });
    const input = {
      companyContactId: null,
      expectedRenewalVersion: preview.expectedRenewalVersion,
      expectedPhone: preview.phone,
      message: 'Merhaba &text=hacked?x=1#fragment\nTürkçe + /',
    };
    const opened = await openRenewalWhatsApp(actor, db, id, input, 'open-key');
    expect(opened.data.outcome).toBe('WHATSAPP_OPENED');
    const target = new URL(opened.data.url);
    expect([...target.searchParams.keys()]).toEqual(['text']);
    expect(target.searchParams.get('text')).toBe(input.message);
    expect(target.hash).toBe('');
    const replay = await openRenewalWhatsApp(actor, db, id, input, 'open-key');
    expect(replay).toMatchObject({ replayed: true, data: opened.data });
    await expect(
      openRenewalWhatsApp(actor, db, id, { ...input, message: 'Different draft' }, 'open-key'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const beforeContact = await listRenewalInteractions(actor, db, id);
    expect(beforeContact.lastContactAt).toBeNull();
    expect(beforeContact.lastAttemptAt).toBe(opened.data.occurredAt);
    expect(beforeContact.interactions).toHaveLength(1);
    expect(
      await db
        .prepare('SELECT state,version FROM renewal_opportunities WHERE id=?')
        .bind(id)
        .first(),
    ).toEqual({ state: 'CONTACT_PENDING', version: 1 });
    expect(
      await db.prepare('SELECT status,version FROM tasks WHERE renewal_id=?').bind(id).first(),
    ).toEqual({ status: 'OPEN', version: 1 });
    const audit = await db
      .prepare('SELECT metadata_json FROM audit_events WHERE idempotency_key=?')
      .bind('open-key')
      .all();
    expect(audit.results).toHaveLength(1);
    expect(JSON.stringify(audit.results)).not.toContain(input.message);
    expect(JSON.stringify(audit.results)).not.toContain(preview.phone);
    const receipt = await db
      .prepare('SELECT response_body FROM operation_receipts WHERE idempotency_key=?')
      .bind('open-key')
      .first<{ response_body: string }>();
    expect(receipt?.response_body).not.toContain('text=');
    const confirmedAt = new Date(Date.parse(opened.data.occurredAt) + 1000).toISOString();
    await createRenewalInteraction(
      actor,
      db,
      id,
      {
        outcome: 'CONTACT_CONFIRMED',
        channel: 'WHATSAPP',
        occurredAt: confirmedAt,
        companyContactId: null,
        note: null,
      },
      'real-contact-key',
    );
    expect((await listRenewalInteractions(actor, db, id)).lastContactAt).toBe(confirmedAt);
  });
  it('resolves an authorized canonical phone and previews without any contact or mutation', async () => {
    const id = await seed('preview');
    const receipts = await db.prepare('SELECT count(*) AS n FROM operation_receipts').first();
    const preview = await previewRenewalWhatsApp(actor, db, id, { companyContactId: null });
    expect(preview.phone).toBe('905321234567');
    const url = new URL(preview.url);
    expect(url.origin).toBe('https://wa.me');
    expect(url.pathname).toBe('/905321234567');
    expect(url.searchParams.get('text')).toBe(preview.message);
    expect(preview.message).not.toContain('Sensitive hidden metadata');
    expect(await db.prepare('SELECT count(*) AS n FROM operation_receipts').first()).toEqual(
      receipts,
    );
    expect(await listRenewalInteractions(actor, db, id)).toMatchObject({
      lastContactAt: null,
      lastAttemptAt: null,
    });
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM renewal_interactions WHERE renewal_id=?')
        .bind(id)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await db.prepare('SELECT count(*) AS n FROM audit_events WHERE target_id=?').bind(id).first(),
    ).toEqual({ n: 0 });
  });
});
