import { monitorStatus, OPERATIONAL_FRESHNESS_MS, type Decision } from './evidence';
import { observeBackup, type BackupReader } from './observer';

interface NotificationChannels {
  /** The state store must reject superseded or uncommitted observations. */
  record: (decision: Decision) => Promise<void>;
  alive: () => Promise<void>;
  freshness: (result: 'SUCCESS' | 'FAIL') => Promise<void>;
}

const pingAddress = /^https:\/\/hc-ping\.com\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function healthchecksChannels(
  config: { aliveUrl: string; freshnessUrl: string },
  record: NotificationChannels['record'],
  send: typeof fetch = (input, init) => globalThis.fetch(input, init),
): NotificationChannels {
  const { aliveUrl, freshnessUrl } = config;
  if (
    !pingAddress.test(aliveUrl) ||
    !pingAddress.test(freshnessUrl) ||
    aliveUrl.toLowerCase() === freshnessUrl.toLowerCase()
  )
    throw new Error('HEALTHCHECKS_CONFIGURATION_INVALID');

  const ping = async (url: string) => {
    try {
      const response = await send(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 200 && (await response.text()).trim() === 'OK') return;
    } catch {
      // Provider transport errors can include the secret URL.
    }
    throw new Error('HEALTHCHECKS_PING_REJECTED');
  };

  return {
    record,
    alive: () => ping(aliveUrl),
    freshness: (result) => ping(result === 'SUCCESS' ? freshnessUrl : `${freshnessUrl}/fail`),
  };
}

export async function executeBackupObservation(
  reader: BackupReader,
  channels: NotificationChannels,
  now: () => number = Date.now,
) {
  const decision = await observeBackup(reader, now(), OPERATIONAL_FRESHNESS_MS);
  await channels.record(decision);
  const status = monitorStatus(decision, now(), OPERATIONAL_FRESHNESS_MS);
  const deliveries = await Promise.allSettled([
    Promise.resolve().then(() => channels.alive()),
    Promise.resolve().then(() => channels.freshness(status === 'HEALTHY' ? 'SUCCESS' : 'FAIL')),
  ]);
  return {
    decision,
    status,
    aliveDelivered: deliveries[0].status === 'fulfilled',
    freshnessDelivered: deliveries[1].status === 'fulfilled',
  };
}
