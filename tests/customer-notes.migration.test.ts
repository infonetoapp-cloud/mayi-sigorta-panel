// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import miniflare from 'miniflare';
import { expect, it } from 'vitest';
it('upgrades a populated pre-notes D1 database without altering customer data or other tables', async () => {
  const { Miniflare, convertV4MiniflareOptions } = miniflare;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response(null)}}',
      d1Databases: { DB: '00000000-0000-0000-0000-000000000021' },
    }),
  );
  try {
    const db = await mf.getD1Database('DB');
    async function apply(file: string) {
      for (const statement of readFileSync(`db/migrations/${file}`, 'utf8')
        .split('--> statement-breakpoint')
        .map((part) => part.trim())
        .filter(Boolean))
        await db.prepare(statement).run();
    }
    for (const file of readdirSync('db/migrations')
      .filter((file) => /^\d{4}_.*\.sql$/.test(file) && file < '0021_')
      .sort())
      await apply(file);
    await db.batch([
      db.prepare("INSERT INTO agencies(id,status) VALUES('upgrade-notes-agency','PROVISIONING')"),
      db.prepare("INSERT INTO users(id,status) VALUES('upgrade-notes-owner','INACTIVE')"),
      db.prepare(
        "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('upgrade-notes-membership','upgrade-notes-agency','upgrade-notes-owner','OWNER','INVITED','upgrade@example.invalid','2099-01-01T00:00:00.000Z')",
      ),
      db.prepare(
        "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('upgrade-notes-customer','upgrade-notes-agency','INDIVIDUAL','Preserved Customer','Preserved','Customer','upgrade-notes-membership')",
      ),
    ]);
    const before = await db
      .prepare("SELECT * FROM customers WHERE id='upgrade-notes-customer'")
      .first();
    await apply('0021_customer_notes.sql');
    expect(
      await db.prepare("SELECT * FROM customers WHERE id='upgrade-notes-customer'").first(),
    ).toEqual(before);
    expect(await db.prepare('SELECT count(*) AS count FROM customer_notes').first()).toEqual({
      count: 0,
    });
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(
      (
        await db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='customer_notes' ORDER BY name",
          )
          .all<{ name: string }>()
      ).results.map((row) => row.name),
    ).toEqual([
      'customer_notes_immutable_delete',
      'customer_notes_immutable_update',
      'customer_notes_no_replacement',
      'customer_notes_validate_insert',
    ]);
  } finally {
    await mf.dispose();
  }
});
