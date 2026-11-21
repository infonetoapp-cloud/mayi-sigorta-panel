import { useEffect, useState } from 'react';
import { z } from 'zod';
import { PageHeader } from '../components/layout/PageContainer';
import { Button } from '../components/ui/button';

const responseSchema = z.object({
  data: z.object({
    database: z.enum(['OK', 'UNKNOWN']),
    schema: z.enum(['OK', 'MISMATCH', 'UNKNOWN']),
    renewals: z.enum(['PENDING', 'IDLE', 'UNKNOWN']),
    backup: z.enum(['OK', 'STALE', 'UNKNOWN']),
    backupAgeMinutes: z.number().int().nonnegative().nullable(),
    documentJobs: z.enum(['INACTIVE', 'UNKNOWN']),
    documentAccessEnabled: z.boolean(),
    documentWorkerEnabled: z.boolean(),
    documentScheduleEnabled: z.boolean(),
    documentLastSuccessAt: z.iso.datetime().nullable(),
    checkedAt: z.iso.datetime(),
  }),
});
const labels = {
  OK: 'Doğrulandı',
  UNKNOWN: 'Doğrulanamadı',
  MISMATCH: 'Beklenen sürümle eşleşmiyor',
  PENDING: 'Devamı bekleyen tarama var',
  IDLE: 'Bekleyen tarama yok',
  STALE: 'Yedek 45 dakikadan eski',
  INACTIVE: 'Kapalı',
} as const;
type Status = z.infer<typeof responseSchema>['data'];

export default function OperationsReadinessPage() {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ revision: number; value: Status | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const check = async () => {
      try {
        const response = await fetch('/api/ops/readiness', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok && response.status !== 503)
          throw new Error('Unexpected readiness response');
        const { data } = responseSchema.parse(await response.json());
        if (!controller.signal.aborted) setState({ revision, value: data });
      } catch {
        if (!controller.signal.aborted) setState({ revision, value: null });
      }
    };
    void check();
    return () => controller.abort();
  }, [revision]);
  const current = state?.revision === revision ? state : null;
  const data = current?.value;
  return (
    <>
      <PageHeader
        title="İşletim durumu"
        action={
          <Button variant="outline" disabled={!current} onClick={() => setRevision(revision + 1)}>
            Yenile
          </Button>
        }
      />
      {!current ? (
        <p role="status">Kontroller yapılıyor…</p>
      ) : !data ? (
        <p role="alert">İşletim durumu alınamadı.</p>
      ) : (
        <section className="overview-panel" aria-label="İşletim kontrolleri">
          <dl className="overview-priorities">
            <div>
              <dt>D1 erişimi</dt>
              <dd>{labels[data.database]}</dd>
            </div>
            <div>
              <dt>Veritabanı şeması</dt>
              <dd>{labels[data.schema]}</dd>
            </div>
            <div>
              <dt>Otomatik yedek</dt>
              <dd>
                {labels[data.backup]}
                {data.backupAgeMinutes !== null && ` · ${data.backupAgeMinutes} dk önce`}
              </dd>
            </div>
            <div>
              <dt>Yenileme taraması</dt>
              <dd>{labels[data.renewals]}</dd>
            </div>
            <div>
              <dt>Belge işleri</dt>
              <dd>{labels[data.documentJobs]}</dd>
            </div>
            <div>
              <dt>Çalışan belge erişimi</dt>
              <dd>{data.documentAccessEnabled ? 'Açık' : 'Kapalı'}</dd>
            </div>
            <div>
              <dt>Belge işleyicisi</dt>
              <dd>{data.documentWorkerEnabled ? 'Açık' : 'Kapalı'}</dd>
            </div>
            <div>
              <dt>Belge zamanlayıcısı</dt>
              <dd>{data.documentScheduleEnabled ? 'Açık' : 'Kapalı'}</dd>
            </div>
            <div>
              <dt>Son tamamlanan belge işi</dt>
              <dd>
                {data.documentLastSuccessAt ? (
                  <time dateTime={data.documentLastSuccessAt}>
                    {new Intl.DateTimeFormat('tr-TR', {
                      timeZone: 'Europe/Istanbul',
                      dateStyle: 'short',
                      timeStyle: 'short',
                    }).format(new Date(data.documentLastSuccessAt))}
                  </time>
                ) : (
                  'Doğrulanamadı'
                )}
              </dd>
            </div>
          </dl>
          <p className="overview-feedback">
            Son kontrol{' '}
            <time dateTime={data.checkedAt}>
              {new Intl.DateTimeFormat('tr-TR', {
                timeZone: 'Europe/Istanbul',
                hour: '2-digit',
                minute: '2-digit',
              }).format(new Date(data.checkedAt))}
            </time>
          </p>
        </section>
      )}
    </>
  );
}
