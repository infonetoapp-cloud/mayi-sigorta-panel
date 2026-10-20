import { localAuthFixture } from './local-auth-fixture';
import { createOnboardingTemplateGrants } from '../../src/shared/permissions';
export async function customerCoverageFixture() {
  const f = await localAuthFixture();
  await f.seed('coverage-owner', 'OWNER');
  await f.seed('coverage-a');
  await f.seed('coverage-b');
  for (const id of ['coverage-a', 'coverage-b'])
    await f.db.batch(
      createOnboardingTemplateGrants('personel').map((g) =>
        f.db
          .prepare(
            'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
          )
          .bind(crypto.randomUUID(), 'membership-' + id, g.permission_code, g.scope),
      ),
    );
  await f.db
    .prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('coverage-i','agency-auth-test','COVER','Sentetik Sigorta')",
    )
    .run();
  await f.db
    .prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments) VALUES('coverage-pay','agency-auth-test','CASH','Peşin',0,12)",
    )
    .run();
  for (const [id, name, classification] of [
    ['kasko', 'Kasko', 'GENERAL'],
    ['trafik', 'Trafik', 'GENERAL'],
    ['konut', 'Konut', 'GENERAL'],
    ['dask', 'DASK', 'GENERAL'],
    ['health', 'Sağlık', 'HEALTH'],
  ]) {
    await f.db
      .prepare(
        'INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES(?,?,?,?,?)',
      )
      .bind('coverage-' + id, 'agency-auth-test', id, name, classification)
      .run();
    await f.db
      .prepare(
        'INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES(?,?,?,?,?,?)',
      )
      .bind(
        'coverage-product-' + id,
        'agency-auth-test',
        'coverage-i',
        'coverage-' + id,
        id,
        name + ' Ürünü',
      )
      .run();
  }
  async function customer(id: string, assignee = 'coverage-owner') {
    await f.db
      .prepare(
        "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES(?,'agency-auth-test','INDIVIDUAL',?,'Sentetik','Müşteri',?)",
      )
      .bind(id, id, 'membership-' + assignee)
      .run();
  }
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const day = (offset: number) =>
    new Date(Date.parse(today + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
  async function policy(
    id: string,
    customerId: string,
    branch = 'kasko',
    opts: {
      status?: string;
      start?: string;
      end?: string;
      archived?: boolean;
      assignee?: string;
    } = {},
  ) {
    await f.db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status,archived_at,archived_by_membership_id,archive_reason) VALUES(?,'agency-auth-test',?,'coverage-i',?,?,'coverage-pay',?,?,?, ?,?,10000,'TRY',?,?,?,?)",
      )
      .bind(
        id,
        customerId,
        'coverage-product-' + branch,
        'coverage-' + branch,
        'membership-' + (opts.assignee ?? 'coverage-owner'),
        id,
        id,
        opts.start ?? day(-100),
        opts.end ?? day(30),
        opts.status ?? 'ACTIVE',
        opts.archived ? new Date().toISOString() : null,
        opts.archived ? 'membership-coverage-owner' : null,
        opts.archived ? 'TEST_ARCHIVE' : null,
      )
      .run();
  }
  return {
    ...f,
    customer,
    policy,
    today,
    day,
    owner: (await f.session('coverage-owner')).cookie,
    member: (await f.session('coverage-a')).cookie,
  };
}
