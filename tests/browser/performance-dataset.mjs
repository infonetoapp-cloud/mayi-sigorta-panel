// Synthetic local fixture only; never imported by application or production code.
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
export async function seedPerformanceDataset(db, policyCount) {
  if (![10, 1500, 15000].includes(policyCount)) throw new Error('PERFORMANCE_DATASET_DENIED');
  if (policyCount > 10) {
    const customers = Math.floor(policyCount / 3);
    await db
      .prepare(
        `WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<?)
   INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
   SELECT 'perf-customer-'||x,'demo-agency','INDIVIDUAL','Performans Müşterisi '||printf('%06d',x),'Performans','Müşterisi '||x,CASE WHEN x%2=0 THEN 'demo-member-ahmet' ELSE 'demo-member-ayse' END FROM n`,
      )
      .bind(customers - 1)
      .run();
    await db
      .prepare(
        `WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<?)
   INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency)
   SELECT 'perf-policy-'||x,'demo-agency',CASE WHEN x<100 THEN 'demo-customer-0' ELSE 'perf-customer-'||CAST(x%? AS INTEGER) END,'demo-insurer','demo-product','demo-branch','demo-payment',CASE WHEN x%2=0 THEN 'demo-member-ahmet' ELSE 'demo-member-ayse' END,'PERF-'||printf('%06d',x),'PERF'||printf('%06d',x),'2026-01-01','2026-12-31',1250050,'TRY' FROM n`,
      )
      .bind(policyCount - 11, customers)
      .run();
    if (process.env.MAYI_PERF_GROW_WORK === 'true') {
      const directory = await mkdtemp(resolve('node_modules/.cache/performance-fixture-'));
      try {
        const output = join(directory, 'generation.mjs');
        await build({
          entryPoints: ['src/server/renewals/generation.ts'],
          outfile: output,
          bundle: true,
          platform: 'node',
          format: 'esm',
          packages: 'external',
          logLevel: 'silent',
        });
        const { ensureRenewalForPolicy } = await import(pathToFileURL(output).href);
        const end = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
        for (let i = 0; i < 120; i++) {
          const id = 'perf-policy-' + i;
          await db
            .prepare('UPDATE policies SET end_date=?,version=version+1 WHERE id=?')
            .bind(end, id)
            .run();
          await ensureRenewalForPolicy(db, 'demo-agency', id);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
  const counts = {};
  for (const table of ['customers', 'policies', 'renewal_opportunities', 'tasks', 'renewal_quotes'])
    counts[table] = await db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n');
  return counts;
}
