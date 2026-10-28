// @vitest-environment node
import { expect, it } from 'vitest';
import { request as httpsRequest } from 'node:https';

import { openDemo } from '../scripts/demo/application';

it('opens isolated real local D1 demo with real password login and shared CRM/private tasks', async () => {
  const password = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  const passwords = [password(), password(), password()];
  const demo = await openDemo(passwords);
  try {
    const request = (path: string, cookie?: string, body?: unknown) =>
      demo.fetch(
        new Request('https://localhost:8443' + path, {
          method: body ? 'POST' : 'GET',
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(body
              ? { origin: 'https://localhost:8443', 'content-type': 'application/json' }
              : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    expect((await request('/api/me')).status).toBe(401);
    const cookies: string[] = [];
    for (const [index, email] of [
      'sahip@demo.invalid',
      'ahmet@demo.invalid',
      'ayse@demo.invalid',
    ].entries()) {
      const login = await request('/api/auth/login', undefined, {
        email,
        password: passwords[index],
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')!;
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('HttpOnly');
      cookies.push(cookie.split(';')[0]!);
    }
    const assignees = new Set<string>();
    for (const cookie of cookies.slice(1)) {
      const customers = await request('/api/customers', cookie);
      expect(customers.status).toBe(200);
      expect(JSON.stringify(await customers.json())).toContain('Deniz Yılmaz');
      const notes = await request('/api/customers/demo-customer-0/notes', cookie);
      expect(notes.status).toBe(200);
      expect(await notes.json()).toMatchObject({
        data: {
          items: expect.arrayContaining([
            expect.objectContaining({ authorName: 'Ahmet' }),
            expect.objectContaining({ authorName: 'Ayşe' }),
          ]),
        },
      });
      const tasks = await request('/api/tasks/today', cookie);
      expect(tasks.status).toBe(200);
      const taskData = (await tasks.json()) as {
        data: { items: Array<{ assigneeMembershipId: string; renewalId: string }> };
      };
      expect(taskData.data.items).toHaveLength(5);
      expect(new Set(taskData.data.items.map((item) => item.assigneeMembershipId)).size).toBe(1);
      assignees.add(taskData.data.items[0]!.assigneeMembershipId);
      const quotes = await request(
        `/api/renewals/${taskData.data.items[0]!.renewalId}/quotes`,
        cookie,
      );
      expect(quotes.status).toBe(200);
      expect(await quotes.json()).toMatchObject({
        data: {
          quotes: [expect.objectContaining({ status: 'DRAFT', versions: expect.any(Array) })],
        },
      });
      const statistics = await request('/api/tasks/statistics', cookie);
      expect(statistics.status).toBe(200);
      expect(await statistics.json()).toMatchObject({
        data: {
          view: 'self',
          summary: { overdue: 2, dueToday: 2, upcoming: 1, completedLast30Days: 0 },
        },
      });
      expect((await request('/api/tasks/statistics?view=team', cookie)).status).toBe(403);
      expect(
        (await request('/api/tasks/statistics?membershipId=demo-member-owner', cookie)).status,
      ).toBe(403);
    }
    expect([...assignees].sort()).toEqual(['demo-member-ahmet', 'demo-member-ayse']);
    const ownerTasks = await request('/api/tasks/today', cookies[0]);
    expect(await ownerTasks.json()).toMatchObject({
      data: {
        canAssign: true,
        items: expect.arrayContaining([
          expect.objectContaining({ assigneeMembershipId: 'demo-member-ahmet' }),
          expect.objectContaining({ assigneeMembershipId: 'demo-member-ayse' }),
        ]),
      },
    });
    const summary = await request('/api/tasks/statistics?view=team', cookies[0]);
    expect(await summary.json()).toMatchObject({
      data: {
        employees: expect.arrayContaining([
          expect.objectContaining({ displayName: 'Ahmet' }),
          expect.objectContaining({ displayName: 'Ayşe' }),
        ]),
      },
    });
    expect((await demo.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(
      (
        await request('/api/auth/login', undefined, {
          email: 'ahmet@demo.invalid',
          password: password(),
        })
      ).status,
    ).toBe(401);
    const modulePath = '../scripts/demo/https-server.mjs';
    const serverModule = (await import(modulePath)) as {
      demoCertificate(): Promise<{ key: Uint8Array; cert: Uint8Array; dispose(): Promise<void> }>;
      serveDemo(
        app: typeof demo,
        tls: { key: Uint8Array; cert: Uint8Array },
      ): Promise<{ close(): Promise<void> }>;
    };
    const tls = await serverModule.demoCertificate();
    const server = await serverModule.serveDemo(demo, tls);
    try {
      const http = (
        path: string,
        method = 'GET',
        body?: unknown,
        cookie?: string,
        host = 'localhost:8443',
      ) =>
        new Promise<{ status: number; text: string; cookie?: string }>((yes, no) => {
          const req = httpsRequest(
            {
              hostname: '127.0.0.1',
              port: 8443,
              path,
              method,
              rejectUnauthorized: false,
              headers: {
                host,
                accept: path === '/' ? 'text/html' : 'application/json',
                ...(body
                  ? { origin: 'https://localhost:8443', 'content-type': 'application/json' }
                  : {}),
                ...(cookie ? { cookie } : {}),
              },
            },
            (response) => {
              const chunks: Uint8Array[] = [];
              response.on('data', (chunk) => chunks.push(chunk));
              response.on('end', () =>
                yes({
                  status: response.statusCode!,
                  text: Buffer.concat(chunks).toString(),
                  cookie: response.headers['set-cookie']?.[0]?.split(';')[0],
                }),
              );
            },
          );
          req.on('error', no);
          req.end(body ? JSON.stringify(body) : undefined);
        });
      expect((await http('/')).text).toContain('<div id="root">');
      expect((await http('/api/me')).status).toBe(401);
      const login = await http('/api/auth/login', 'POST', {
        email: 'ahmet@demo.invalid',
        password: passwords[1],
      });
      expect(login.status).toBe(200);
      expect((await http('/api/me', 'GET', undefined, login.cookie)).status).toBe(200);
      expect((await http('/api/health', 'GET', undefined, undefined, 'evil.invalid')).status).toBe(
        403,
      );
    } finally {
      await server.close();
      await tls.dispose();
    }
  } finally {
    await demo.dispose();
  }
}, 120000);
