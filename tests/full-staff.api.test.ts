// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDemo, DEMO_ORIGIN, DEMO_USERS } from '../scripts/demo/application';
import { PERMISSION_CATALOG } from '../src/shared/permissions';
let d: Awaited<ReturnType<typeof openDemo>>;
const passwords = DEMO_USERS.map(() => randomUUID() + randomUUID());
const cookies: string[] = [];
async function req(
  path: string,
  actor = 0,
  method = 'GET',
  body?: unknown,
  key: string = randomUUID(),
): Promise<Response> {
  return d.fetch(
    new Request(DEMO_ORIGIN + path, {
      method,
      headers: {
        cookie: cookies[actor]!,
        origin: DEMO_ORIGIN,
        'content-type': 'application/json',
        ...(method === 'GET'
          ? {}
          : {
              'x-csrf-token': (
                (await (await req('/api/auth/csrf-token', actor)).json()) as {
                  data: { token: string };
                }
              ).data.token,
              'idempotency-key': key,
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function login(i: number) {
  const r = await d.fetch(
    new Request(DEMO_ORIGIN + '/api/auth/login', {
      method: 'POST',
      headers: { origin: DEMO_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEMO_USERS[i]!.email, password: passwords[i] }),
    }),
  );
  expect(r.status).toBe(200);
  cookies[i] = r.headers.get('set-cookie')!.split(';')[0]!;
}
beforeAll(async () => {
  d = await openDemo(passwords);
  for (let i = 0; i < 3; i++) await login(i);
}, 120000);
afterAll(async () => {
  passwords.fill('');
  await d?.dispose();
});
it('ordinary MEMBER still cannot read another employees task even with its legacy agency scopes', async () => {
  const r = await req('/api/tasks/today?limit=50');
  const b = (await r.json()) as { data: { items: { taskId: string; policyId: string }[] } };
  const t = b.data.items.find((t) => t.policyId === 'demo-policy-1')!;
  expect((await req('/api/tasks/' + t.taskId + '/context', 1)).status).toBe(404);
});
it('saves real maximum MEMBER permissions with an empty reason and retains a blank audit justification', async () => {
  const rows = (await (await req('/api/personnel')).json()) as {
    data: { personnel: { id: string; version: number }[] };
  };
  const p = rows.data.personnel.find((p) => p.id === 'demo-member-ahmet')!;
  const reauth = await req('/api/auth/reauth', 0, 'POST', { password: passwords[0] });
  expect(reauth.status).toBe(200);
  cookies[0] = reauth.headers.get('set-cookie')!.split(';')[0]!;
  const command = {
    kind: 'permissions',
    targetId: p.id,
    expectedVersion: p.version,
    reason: '',
    grants: PERMISSION_CATALOG.filter((p) => p.code !== 'report.management').map((p) => ({
      permission_code: p.code,
      scope: p.scopeKind === 'UNSCOPED' ? 'UNSCOPED' : 'AGENCY',
    })),
  };
  const grant = await req('/secure/api/personnel/grants', 0, 'POST', command);
  expect(grant.status).toBe(200);
  const g = (await grant.json()) as { data: { grantEvidenceToken: string } };
  const saved = await req('/secure/api/personnel/commands', 0, 'POST', {
    command,
    grantEvidenceToken: g.data.grantEvidenceToken,
  });
  expect(saved.status).toBe(200);
  const m = await d.db
    .prepare("SELECT type FROM agency_memberships WHERE id='demo-member-ahmet'")
    .first('type');
  expect(m).toBe('MEMBER');
  const audits = await d.db
    .prepare(
      "SELECT metadata_json FROM audit_events WHERE action='personnel.permissions' AND outcome='SUCCESS'",
    )
    .all<{ metadata_json: string }>();
  expect(audits.results.some((a) => JSON.parse(a.metadata_json).justification === '')).toBe(true);
  await login(1);
  const queue = await req('/api/tasks/today?limit=50', 1);
  expect(queue.status).toBe(200);
  const q = (await queue.json()) as { data: { items: { policyId: string }[]; canAssign: boolean } };
  expect(q.data.items.some((t) => t.policyId === 'demo-policy-1')).toBe(true);
  expect(q.data.canAssign).toBe(true);
  expect((await req('/api/personnel', 1)).status).toBe(403);
});

type Task = {
  taskId: string;
  renewalId: string;
  policyId: string;
  taskVersion: number;
  renewalVersion: number;
};
async function tasks(actor: number) {
  return (
    (await (await req('/api/tasks/today?limit=50', actor)).json()) as {
      data: { items: Task[]; canAssign: boolean };
    }
  ).data;
}
let assignment: { path: string; body: unknown; key: string };
it('full MEMBER can read, assign and exactly replay another employees task while an ordinary MEMBER cannot manage it', async () => {
  const t = (await tasks(1)).items.find((t) => t.policyId === 'demo-policy-1')!;
  const path = `/api/renewals/${t.renewalId}/tasks/${t.taskId}`;
  expect((await req('/api/tasks/' + t.taskId + '/context', 1)).status).toBe(200);
  expect([403, 404]).toContain((await req(path + '/assignment-options', 2)).status);
  expect((await req(path + '/assignment-options', 1)).status).toBe(200);
  const body = {
    expectedRenewalVersion: t.renewalVersion,
    expectedTaskVersion: t.taskVersion,
    assigneeMembershipId: 'demo-member-ahmet',
  };
  const key = randomUUID();
  assignment = { path: path + '/assign', body, key };
  expect((await req(assignment.path, 1, 'POST', body, key)).status).toBe(200);
  expect((await req(assignment.path, 1, 'POST', body, key)).status).toBe(200);
  expect(
    await d.db
      .prepare('SELECT assignee_membership_id FROM tasks WHERE id=?')
      .bind(t.taskId)
      .first('assignee_membership_id'),
  ).toBe('demo-member-ahmet');
  expect(
    await d.db
      .prepare(
        "SELECT count(*) n FROM audit_events WHERE action='renewal.task.assigned' AND idempotency_key=? AND outcome='SUCCESS'",
      )
      .bind(key)
      .first('n'),
  ).toBe(1);
});
it('full MEMBER completes another employees followup with an immutable same-key replacement replay', async () => {
  const t = (await tasks(1)).items.find((t) => t.policyId === 'demo-policy-3')!;
  const path = `/api/renewals/${t.renewalId}/tasks/${t.taskId}/complete`;
  const body = {
    expectedRenewalVersion: t.renewalVersion,
    expectedTaskVersion: t.taskVersion,
    replacementDueAt: new Date(Date.now() + 172800000).toISOString(),
  };
  const key = randomUUID();
  expect((await req(path, 1, 'POST', body, key)).status).toBe(200);
  expect((await req(path, 1, 'POST', body, key)).status).toBe(200);
  expect(
    await d.db.prepare('SELECT status FROM tasks WHERE id=?').bind(t.taskId).first('status'),
  ).toBe('COMPLETED');
});
it('critical credential recovery still requires a reason and full MEMBER cannot issue personnel grants', async () => {
  const recent = await req('/api/auth/reauth', 1, 'POST', { password: passwords[1] });
  expect(recent.status).toBe(200);
  cookies[1] = recent.headers.get('set-cookie')!.split(';')[0]!;
  const rows = (await (await req('/api/personnel')).json()) as {
    data: { personnel: { id: string; version: number }[] };
  };
  const p = rows.data.personnel.find((p) => p.id === 'demo-member-ahmet')!;
  expect(
    (
      await req('/secure/api/personnel/grants', 0, 'POST', {
        kind: 'reset',
        targetId: p.id,
        expectedVersion: p.version,
        reason: '',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await req('/secure/api/personnel/grants', 1, 'POST', {
        kind: 'permissions',
        targetId: p.id,
        expectedVersion: p.version,
        reason: '',
        grants: [],
      })
    ).status,
  ).toBe(403);
});
it('withdrawing only the explicit team capability restores privacy, removes management and denies cached assignment replay', async () => {
  const rows = (await (await req('/api/personnel')).json()) as {
    data: {
      personnel: {
        id: string;
        version: number;
        grants: { permission_code: string; scope: string }[];
      }[];
    };
  };
  const p = rows.data.personnel.find((p) => p.id === 'demo-member-ahmet')!;
  const command = {
    kind: 'permissions',
    targetId: p.id,
    expectedVersion: p.version,
    grants: p.grants.filter((g) => g.permission_code !== 'task.team'),
  };
  const grant = await req('/secure/api/personnel/grants', 0, 'POST', command);
  expect(grant.status).toBe(200);
  const g = (await grant.json()) as { data: { grantEvidenceToken: string } };
  expect(
    (
      await req('/secure/api/personnel/commands', 0, 'POST', {
        command,
        grantEvidenceToken: g.data.grantEvidenceToken,
      })
    ).status,
  ).toBe(200);
  expect((await req('/api/tasks/today', 1)).status).toBe(401);
  await login(1);
  const q = await tasks(1);
  expect(q.canAssign).toBe(false);
  expect(q.items.some((t) => t.policyId === 'demo-policy-3')).toBe(false);
  expect([403, 404]).toContain(
    (await req(assignment.path, 1, 'POST', assignment.body, assignment.key)).status,
  );
});
