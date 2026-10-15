// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createDocumentUpload } from '../src/server/documents/service';
import { createSyntheticJpeg } from './fixtures/documents';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
beforeAll(async () => {
  f = await localAuthFixture();
}, 90000);
afterAll(async () => {
  await f?.mf.dispose();
});

async function fixture() {
  const actor = await f.seed(crypto.randomUUID(), 'OWNER');
  const customer = crypto.randomUUID();
  await f.db
    .prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES(?,?,'INDIVIDUAL','Synthetic','Synthetic','Only',?)",
    )
    .bind(customer, actor.agencyId, actor.membershipId)
    .run();
  const version = await f.db
    .prepare('SELECT permission_version FROM agency_memberships WHERE id=?')
    .bind(actor.membershipId)
    .first<number>('permission_version');
  const context: AuthenticatedUserContext = {
    userId: actor.id,
    identityId: actor.identityId,
    assurance: 'NORMAL',
    memberships: [
      {
        id: actor.membershipId,
        agencyId: actor.agencyId,
        type: 'OWNER',
        status: 'ACTIVE',
        permissionVersion: version!,
      },
    ],
  };
  const input = {
    ownerType: 'CUSTOMER' as const,
    ownerId: customer,
    classification: 'GENERAL' as const,
    fileName: 'synthetic.jpeg',
    declaredContentType: 'image/jpeg',
    file: new Blob([createSyntheticJpeg(64, 64)], { type: 'image/jpeg' }),
  };
  return { context, input, key: crypto.randomUUID(), agency: actor.agencyId };
}
it('distinguishes acknowledged R2 from failed D1 finalization and retains pending canonical state', async () => {
  const x = await fixture(),
    log = vi.spyOn(console, 'info').mockImplementation(() => {});
  let batches = 0;
  const db = {
    prepare: f.db.prepare.bind(f.db),
    batch: (stmts: D1PreparedStatement[]) => {
      if (++batches === 2)
        return Promise.reject(
          new Error('D1_ERROR', { cause: new Error('CHECK constraint failed: private') }),
        );
      return f.db.batch(stmts);
    },
  } as D1Database;
  const put = vi.fn(async () => ({}));
  try {
    await expect(
      createDocumentUpload(db, { put } as unknown as R2Bucket, x.context, x.input, {
        correlationId: crypto.randomUUID(),
        idempotencyKey: x.key,
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_RETRYABLE', status: 503 });
    expect(put).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map(([r]) => r)).toContainEqual({
      kind: 'document_upload_phase_v1',
      phase: 'FINALIZE_BATCH',
      event: 'FAIL',
      code: 'SQLITE_CHECK',
    });
    expect(log.mock.calls.map(([r]) => r)).toContainEqual({
      kind: 'document_upload_phase_v1',
      phase: 'R2_PUT',
      event: 'OK',
      code: 'NONE',
    });
    expect(
      await f.db
        .prepare('SELECT status,validation_version FROM document_versions WHERE agency_id=?')
        .bind(x.agency)
        .first(),
    ).toEqual({ status: 'PENDING_UPLOAD', validation_version: null });
    expect(
      await f.db
        .prepare('SELECT status FROM operation_receipts WHERE idempotency_key=?')
        .bind(x.key)
        .first('status'),
    ).toBe('IN_PROGRESS');
    expect(
      await f.db
        .prepare('SELECT count(*) n FROM background_jobs WHERE agency_id=?')
        .bind(x.agency)
        .first('n'),
    ).toBe(0);
  } finally {
    log.mockRestore();
  }
}, 60000);
it('distinguishes R2 acknowledgement failure without starting finalization', async () => {
  const x = await fixture(),
    log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    await expect(
      createDocumentUpload(
        f.db,
        {
          put: async () => {
            throw new Error('private storage failure');
          },
        } as unknown as R2Bucket,
        x.context,
        x.input,
        { correlationId: crypto.randomUUID(), idempotencyKey: x.key },
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(log.mock.calls.map(([r]) => r)).toContainEqual({
      kind: 'document_upload_phase_v1',
      phase: 'R2_PUT',
      event: 'FAIL',
      code: 'UNKNOWN',
    });
    expect(log.mock.calls.some(([r]) => r.phase === 'FINALIZE_BATCH')).toBe(false);
  } finally {
    log.mockRestore();
  }
}, 60000);
