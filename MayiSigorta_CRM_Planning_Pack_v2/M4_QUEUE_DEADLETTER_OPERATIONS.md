# M4 Queue dead-letter operations

Historical scanner runbook — F-26 (5 October 2026) supersedes this production requirement. Do NOT provision this scan/DLQ/hold chain or purchase 14-day retention. Active durable BACKUP/RECONCILE jobs use D1 as authority and Queue only as acceleration; see `M4_INTERNAL_DOCUMENT_SECURITY_DECISION.md` and the current final architecture plan. The procedure below records the previously accepted scanner design, not the active enablement gate.

This runbook covers the M4 document scan Queue chain only. It does not enable documents, provision infrastructure, or authorize production access.

## Queue path

`mayisigorta-document-scan` → `mayisigorta-document-scan-dead-letter` → `mayisigorta-document-scan-dead-letter-overflow` → `mayisigorta-document-scan-dead-letter-terminal` → `mayisigorta-document-scan-dead-letter-hold`.

The terminal consumer attempts immutable D1 event persistence and retries for up to 100 Queue retries. Messages that still cannot be persisted are sent to the hold queue. A replayed message must carry `deadLetterReplayId` set to the held Queue message ID; the consumer uses that stable ID instead of the new platform delivery ID, so repeated replay converges on the same D1 event. Malformed payload bytes are never copied to D1 or logs.

## Required external controls before enabling document operations

1. The hold queue has no consumer by design. Cloudflare Queue messages without an active consumer currently have a four-day default retention. Before enabling the document module in any real environment, provision 14-day retention for this queue, using the authorized infrastructure workflow (Cloudflare documents `wrangler queues update <queue> --message-retention-period-secs 1209600`). This repository does not apply that remote setting.
2. Configure an external alert on the hold queue metrics endpoint `GET /accounts/{account_id}/queues/{queue_id}/metrics`: alert when `backlog_count > 0`, and include `oldest_message_timestamp_ms` in the notification. The repository contains no live alert destination or credentials.
3. Exercise the replay procedure with a synthetic message and confirm the D1 event is visible before acknowledging the held message. Keep `DOCUMENTS_ENABLED=false` until this and the remaining M4 safety gates are accepted.

## Replay procedure

1. Confirm D1 is healthy and the terminal Queue consumer is active. Do not replay while D1 writes are failing.
2. Pull a small batch from the hold queue using the Cloudflare Queues Pull Messages API and retain each message's `id`, `lease_id`, and body. Never print a bearer token or paste one into a shell transcript.
3. For an object body, re-publish the same fields with `deadLetterReplayId` set to the held message ID. For a non-object poison body, re-publish a wrapper containing `deadLetterReplayId` and the original body; the consumer records only the invalid-message marker, not the body.
4. Send the replayed message to `mayisigorta-document-scan-dead-letter-terminal`. If the push fails, leave the held message unacknowledged. After a successful push, acknowledge the held lease; the terminal consumer will either persist the immutable D1 event or retry and route it back to the hold queue.
5. Verify the D1 row by `(queue_name, message_id)` and confirm the associated `job_id`, generation, DocumentVersion, and checksum where available. Re-check hold-queue metrics until its backlog is zero. A replay is not complete merely because the push succeeded.

Cloudflare Queue API pull/push/ack operations and retention/alert provisioning were not executed in this local-only checkpoint. No remote D1/R2/Queue/Container resource or production secret was accessed.