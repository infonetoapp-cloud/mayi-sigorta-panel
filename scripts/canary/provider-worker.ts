import { z } from 'zod';
import canonical from './document-worker';
import {
  assertClosedCanaryEnvironment,
  type ClosedCanaryEnv,
} from '../../src/server/documents/closed-canary';
import { readProviderInventory, type ProviderInventory } from './provider-inventory';
import { emitCanaryMarker } from './attribution';
export { DocumentCanaryControl } from './document-worker';
interface InventoryEnv extends ClosedCanaryEnv {
  CANARY_LOGS_ENABLED?: string;
  CANARY_NEGATIVE_RUN_ID?: string;
  DOCS_QUARANTINE: R2Bucket;
  CANARY_LEAF: { inventory(): Promise<ProviderInventory> };
}
const request = z.strictObject({
  kind: z.literal('P4_PROVIDER_INVENTORY'),
  runId: z.string().uuid(),
  nonce: z.string().uuid(),
});
/** Read-only storage observation outside the normal P0 copy measurement window.
 * No public issuer, generic storage proxy, production binding or feature activation. */
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
  async queue(batch: MessageBatch<unknown>, env: InventoryEnv, ctx: ExecutionContext) {
    const input = batch.messages[0]?.body;
    if (
      input &&
      typeof input === 'object' &&
      'kind' in input &&
      input.kind === 'P4_NEGATIVE_CONTROL'
    ) {
      assertClosedCanaryEnvironment(env);
      const control = z
        .strictObject({ kind: z.literal('P4_NEGATIVE_CONTROL'), runId: z.string().uuid() })
        .parse(input);
      if (
        control.runId !== env.CANARY_NEGATIVE_RUN_ID ||
        control.runId === env.CANARY_RUN_ID ||
        batch.messages.length !== 1 ||
        batch.messages[0]?.attempts !== 1
      )
        throw new Error('CANARY_NEGATIVE_SCOPE');
      const logging = { ...env, CANARY_RUN_ID: control.runId };
      emitCanaryMarker(logging, 'queue_start', null, 'start');
      try {
        await canonical.queue(batch as never, env as never, ctx);
      } catch {
        emitCanaryMarker(logging, 'queue_complete', null, 'fail');
        throw new Error('CANARY_NEGATIVE_REJECTED');
      }
      throw new Error('CANARY_NEGATIVE_UNEXPECTED_ACCEPTANCE');
    }
    if (
      input &&
      typeof input === 'object' &&
      'kind' in input &&
      input.kind === 'P4_PROVIDER_INVENTORY'
    ) {
      assertClosedCanaryEnvironment(env);
      const control = request.parse(input);
      if (
        control.runId !== env.CANARY_RUN_ID ||
        batch.messages.length !== 1 ||
        batch.messages[0]?.attempts !== 1
      )
        throw new Error('CANARY_INVENTORY_SCOPE');
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS p4_provider_inventory(nonce TEXT PRIMARY KEY,run_id TEXT NOT NULL,result_json TEXT NOT NULL)',
      ).run();
      await env.DB.prepare(
        'INSERT INTO p4_provider_inventory(nonce,run_id,result_json) VALUES(?,?,?)',
      )
        .bind(control.nonce, control.runId, '{}')
        .run();
      const primary = await readProviderInventory(env.DOCS_QUARANTINE, 'primary');
      const recovery = await env.CANARY_LEAF.inventory();
      if (recovery.complete !== true) throw new Error('CANARY_INVENTORY_INCOMPLETE');
      await env.DB.prepare(
        'UPDATE p4_provider_inventory SET result_json=? WHERE nonce=? AND run_id=?',
      )
        .bind(JSON.stringify({ primary, recovery }), control.nonce, control.runId)
        .run();
      batch.messages[0]!.ack();
      return;
    }
    return canonical.queue(batch as never, env as never, ctx);
  },
};
