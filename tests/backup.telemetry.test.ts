// @vitest-environment node
import { expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));
vi.mock('../src/server/d1-backup/core', () => ({ runBackup: vi.fn() }));
import { runBackup } from '../src/server/d1-backup/core';
import { D1BackupWorkflow } from '../src/server/d1-backup/worker';
it('emits one allowlisted completion event only after full backup resolves verified COMPLETE', async () => {
  const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
  const calls: string[] = [];
  vi.mocked(runBackup).mockImplementation(async (_env, steps) => {
    expect(spy).not.toHaveBeenCalled();
    calls.push('verified-COMPLETE');
    return steps.do(
      'write-verify-COMPLETE-last',
      async () =>
        ({
          generation: 'd1-backup-slot-1',
          sqlSize: 123,
          totalMs: 42,
          secret: 'must-not-log',
          signedUrl: 'must-not-log',
        }) as never,
    );
  });
  try {
    const workflow = new D1BackupWorkflow(null as never, {} as never);
    await workflow.run(
      { payload: {}, instanceId: 'd1-backup-slot-1', timestamp: new Date() } as never,
      {
        do: async (_name: string, _options: unknown, callback: () => Promise<unknown>) =>
          callback(),
      } as never,
    );
    expect(calls).toEqual(['verified-COMPLETE']);
    expect(spy).toHaveBeenCalledOnce();
    const payload = spy.mock.calls[0]![0];
    expect(payload).toMatchObject({
      event: 'MAYI_D1_BACKUP_COMPLETE',
      generationId: 'd1-backup-slot-1',
      sqlBytes: 123,
      totalMs: 42,
    });
    expect(JSON.stringify(payload)).not.toContain('must-not-log');
  } finally {
    spy.mockRestore();
  }
});
it.each(['SQL', 'manifest', 'COMPLETE'])(
  '%s verification failure remains failure and no success telemetry',
  async (stage) => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.mocked(runBackup).mockRejectedValue(new Error('sanitized ' + stage));
    try {
      const w = new D1BackupWorkflow(null as never, {} as never);
      await expect(
        w.run(
          { payload: {}, instanceId: 'd1-backup-slot-1', timestamp: new Date() } as never,
          {} as never,
        ),
      ).rejects.toThrow(stage);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  },
);
