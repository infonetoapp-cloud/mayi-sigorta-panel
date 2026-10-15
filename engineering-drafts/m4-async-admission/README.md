# Preserved F-35 async admission experiment

These files are preserved, not accepted or applied migrations. The active architectural authority is MayiSigorta_CRM_Planning_Pack_v2/NIHAI_MIMARI_VE_UYGULAMA_PLANI.md §10.10/F-36.

The interrupted mission had a draft additive D1 migration and ten passing native schema tests, followed by a RED model-export test. Recovery retained that history. F-36 chooses a private SQLite Durable Object executing the existing canonical upload path rather than introducing asynchronous validation state and three D1 ledgers. Consequently these unpublished files are not in the active migration/test directories. The RED test has not been made GREEN or counted as a passing test.

Exact original paths and SHA256:

- db/migrations/0021_document_async_admission.sql → 0021_document_async_admission.sql.draft: b4045b5006882c68c5750756187ce26bfbedd80287970cbd353b4f903f79d5fe
- tests/documents.admission-attempt-schema.test.ts → documents.admission-attempt-schema.test.ts.draft: e3b9ef9f20f6db4fec766c3eb4d0cc1ac4781824fbcf3baf765546da0da57f33
- tests/documents.admission-model.test.ts → documents.admission-model.test.ts.draft: 08cdb4491d3e74389209719b55d89b25f1c45cfe373c768d88fd8cb829e9600b

Do not rename these into active migrations/tests without a new reviewed architectural decision, complete integration and migration registration. Historical applied migrations0000–0020 remain unchanged. Recovery evidence: MayiSigorta_CRM_Planning_Pack_v2/M4_HTTP_ADMISSION_INTERRUPT_RECOVERY.md. Original RED/GREEN logs and custody receipt remain under the operator's local Temp directory; do not substitute these drafts for a successful source/provider acceptance.
