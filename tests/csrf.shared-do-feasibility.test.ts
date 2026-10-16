// @vitest-environment node
import { expect, it } from 'vitest';
import {
  createDocumentAdmission,
  trackedDocumentDatabase,
} from '../src/server/documents/resource-admission';
import { createUploadRuntime } from '../src/server/documents/upload-runtime';
import { inspectDocumentContent } from '../src/server/documents/content-inspection';
import { createSyntheticJpeg } from './fixtures/documents';
import type { Env } from '../src/server/index';

it('rejects auth delegation through the current upload runtime with documents disabled', async () => {
  let canonicalCalls = 0;
  const runtime = createUploadRuntime(async () => {
    canonicalCalls++;
    return new Response(null, { status: 200 });
  });
  const response = await runtime.fetch(
    new Request('https://panel.mayisigorta.com/api/auth/csrf-token'),
    {
      APP_ENV: 'test',
      PANEL_ORIGIN: 'https://panel.mayisigorta.com',
      DOCUMENTS_ENABLED: 'false',
      DB: {} as D1Database,
    } as Env,
  );
  expect(response.status).toBe(404);
  expect(canonicalCalls).toBe(0);
});

it('demonstrates actual synchronous JPEG inspection cannot be preempted by an independent auth permit or abort', async () => {
  // Same-event-loop characterization, NOT provider latency or a deployed DO implementation.
  const bytes = createSyntheticJpeg(1024, 768);
  const upload = createDocumentAdmission().acquire()!;
  const auth = createDocumentAdmission().acquire()!;
  const controller = new AbortController();
  const events: string[] = [];
  const authPending = Promise.resolve().then(() => {
    events.push('auth');
  });
  const abortPending = Promise.resolve().then(() => {
    controller.abort();
    events.push('abort');
  });
  const timer = new Promise<void>((resolve) =>
    setTimeout(() => {
      events.push('deadline');
      resolve();
    }, 0),
  );
  const parsed = inspectDocumentContent('JPEG', bytes, controller.signal);
  events.push('parser-returned');
  expect(events).toEqual(['parser-returned']);
  const result = await parsed;
  await Promise.all([authPending, abortPending, timer]);
  expect(result.valid).toBe(true);
  expect(controller.signal.aborted).toBe(true);
  expect(events.indexOf('auth')).toBeGreaterThan(events.indexOf('parser-returned'));
  expect(events.indexOf('deadline')).toBeGreaterThan(events.indexOf('parser-returned'));
  upload.release();
  auth.release();
});

it('retains raw late D1 custody after logical cancellation and refuses admission until settlement', async () => {
  const admission = createDocumentAdmission();
  const permit = admission.acquire()!;
  let finish!: (value: null) => void;
  const pending = new Promise<null>((resolve) => {
    finish = resolve;
  });
  const raw = { prepare: () => ({ first: () => pending }) } as unknown as D1Database;
  const db = trackedDocumentDatabase(raw, permit);
  const operation = db.prepare('SELECT 1').first();
  permit.release();
  expect(admission.acquire()).toBeNull();
  await expect(db.prepare('SELECT 1').first()).rejects.toThrow('DOCUMENT_ADMISSION_CLOSED');
  finish(null);
  await operation;
  const next = admission.acquire();
  expect(next).not.toBeNull();
  next!.release();
});
