// OFFLINE fake Cloudflare provider process. No HTTP client or credential access.
import { DatabaseSync, constants } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';
import process from 'node:process';
const directory = process.argv[2],
  path = join(directory, 'fake-state.json'),
  request = JSON.parse(readFileSync(0, 'utf8'));
const config = JSON.parse(readFileSync(join(directory, 'fake-config.json'), 'utf8'));
const state = existsSync(path)
  ? JSON.parse(readFileSync(path, 'utf8'))
  : { resources: [], imports: {}, calls: [], create: 0, ingest: 0, reconcile: 0, delete: 0 };
const url = new URL(request.url),
  segments = url.pathname.split('/'),
  account = 'af9fc98cb8d5f5508d58057bc794d863',
  uuid = '82967c6d-8aac-4323-9b3b-6e9bcb45f016';

const envelope = (result) => ({ success: true, errors: [], messages: [], result });
const save = () => writeFileSync(path, JSON.stringify(state));
const reply = (status, body, etag) => {
  save();
  process.stdout.write(
    JSON.stringify({ status, body: JSON.stringify(body), ...(etag ? { etag } : {}) }),
  );
};
const lost = () => {
  save();
  process.exit(7);
};
const terminal = (item) => ({
  success: item.error ? false : true,
  status: item.error ? 'error' : 'complete',
  messages: [],
  ...(item.error
    ? { error: 'FOREIGN KEY constraint failed' }
    : {
        result: {
          num_queries: 10,
          final_bookmark: 'bookmark_final',
          meta: { duration: 1, rows_read: 114, rows_written: 114, size_after: 1048576 },
        },
      }),
});
state.calls.push({
  method: request.method,
  kind: request.upload
    ? 'upload'
    : segments.at(-1) === 'query'
      ? 'query'
      : segments.at(-1) === 'import'
        ? 'import'
        : segments.at(-1) === 'database'
          ? 'collection'
          : 'identity',
});
if (request.upload) {
  const etag = url.pathname.slice(1);
  const item = state.imports[etag];
  if (!item) {
    reply(404, { error: 'missing' });
  } else {
    item.uploaded = true;
    item.sql = request.body;
    if (config.fault === 'uploadPartial') {
      item.uploaded = false;
      item.sql = request.body.slice(0, 5);
      lost();
    } else if (config.fault === 'uploadBadEtag')
      reply(200, {}, '"00000000000000000000000000000000"');
    else if (config.fault === 'uploadResponseLost') lost();
    else reply(200, {}, `"${etag}"`);
  }
} else if (url.pathname === `/client/v4/accounts/${account}`) {
  reply(200, envelope({ id: config.fault === 'wrongAccount' ? '0'.repeat(32) : account }));
} else if (
  url.pathname === `/client/v4/accounts/${account}/d1/database` &&
  request.method === 'GET'
) {
  if (config.fault === 'collision' && state.resources.length === 0 && state.create === 0)
    state.resources.push({
      uuid: '12967c6d-8aac-4323-9b3b-6e9bcb45f016',
      name: 'mayisigorta-ops001-restore-gatec-44c314b-03',
      created_at: new Date().toISOString(),
      jurisdiction: 'eu',
    });
  reply(200, {
    ...envelope(state.resources),
    result_info: {
      page: 1,
      per_page: 100,
      count: state.resources.length,
      total_count: state.resources.length,
    },
  });
} else if (
  url.pathname === `/client/v4/accounts/${account}/d1/database` &&
  request.method === 'POST'
) {
  state.create++;
  const body = JSON.parse(request.body);
  const identity = {
    uuid,
    name: body.name,
    jurisdiction: config.fault === 'wrongJurisdiction' ? 'us' : body.jurisdiction,
    created_at: new Date().toISOString(),
    read_replication: { mode: 'disabled' },
  };
  state.resources.push(identity);
  if (config.fault === 'createLost') lost();
  else reply(200, envelope(identity));
} else if (segments.at(-1) === 'import') {
  const body = JSON.parse(request.body);
  if (body.action === 'init') {
    const item = state.imports[body.etag];
    if (item?.active)
      reply(
        200,
        envelope({ success: true, status: 'active', at_bookmark: 'bookmark_active', messages: [] }),
      );
    else if (item?.ingested) reply(200, envelope(terminal(item)));
    else {
      state.imports[body.etag] ??= { uploaded: false, ingested: false };
      reply(
        200,
        envelope({
          success: true,
          filename: `synthetic/${body.etag}.sql`,
          upload_url: `https://synthetic.r2.cloudflarestorage.com/${body.etag}?signature=synthetic-only`,
        }),
      );
    }
  } else if (body.action === 'ingest') {
    const item = state.imports[body.etag];
    if (!item?.uploaded) {
      reply(400, {
        success: false,
        errors: [{ code: 1000, message: 'missing upload' }],
        result: null,
      });
    } else {
      const reconcile = item.sql.startsWith('UPDATE agency_memberships');
      if (reconcile) state.reconcile++;
      else state.ingest++;
      if (
        (config.fault === 'importUnknown' && !reconcile) ||
        (config.fault === 'reconcileUnknown' && reconcile)
      ) {
        save();
        lost();
      } else {
        const db = new DatabaseSync(join(directory, 'target.sqlite'), { allowExtension: false });
        try {
          db.exec('BEGIN');
          if (config.fault === 'partialImport' && !reconcile)
            db.exec('CREATE TABLE partial(id INTEGER PRIMARY KEY)');
          else if (config.fault === 'reconcileFailure' && reconcile)
            throw Error('synthetic failed reconciliation');
          else db.exec(item.sql);
          db.exec('COMMIT');
          if (config.fault === 'fingerprintMismatch' && !reconcile)
            db.exec(
              "UPDATE policies SET gross_premium_minor=gross_premium_minor+1,version=version+1 WHERE id='synthetic-policy-00'",
            );
        } catch {
          if (db.isTransaction) db.exec('ROLLBACK');
          item.error = true;
        } finally {
          db.close();
        }
        item.ingested = true;
        if (
          (config.fault === 'importResponseLost' && !reconcile) ||
          (config.fault === 'reconcileResponseLost' && reconcile)
        )
          lost();
        else if (['activeImport', 'endlessPoll'].includes(config.fault) && !reconcile) {
          item.active = true;
          reply(
            200,
            envelope({
              success: true,
              status: 'active',
              at_bookmark: 'bookmark_active',
              messages: [],
            }),
          );
        } else reply(200, envelope(terminal(item)));
      }
    }
  } else if (body.action === 'poll') {
    const item = Object.values(state.imports).find((item) => item.active);
    if (item) {
      if (config.fault === 'endlessPoll')
        reply(
          200,
          envelope({
            success: true,
            status: 'active',
            at_bookmark: 'bookmark_active',
            messages: [],
          }),
        );
      else {
        delete item.active;
        reply(200, envelope(terminal(item)));
      }
    } else
      reply(400, {
        success: false,
        result: null,
        errors: [{ code: 1000, message: 'invalid bookmark' }],
      });
  } else reply(400, { success: false, result: null, errors: [] });
} else if (segments.at(-1) === 'query' && Array.isArray(JSON.parse(request.body).batch)) {
  const batch = JSON.parse(request.body).batch;
  const kind = batch[0].sql.startsWith('UPDATE local_sessions')
    ? 'authority'
    : batch[0].sql.startsWith('PRAGMA')
      ? 'data'
      : batch[0].sql.startsWith('CREATE TRIGGER')
        ? 'guards'
        : 'schema';
  state.queryBatches ??= [];
  state.queryBatches.push(kind);
  if (kind === 'data' && config.fault === 'queryNoEffect') lost();
  else {
    const db = new DatabaseSync(join(directory, 'target.sqlite'), { allowExtension: false });
    let ok = false;
    try {
      db.exec('BEGIN;');
      for (const row of batch) db.exec(row.sql);
      db.exec('COMMIT;');
      ok = true;
      if (kind === 'data' && config.fault === 'queryCorrupt')
        db.exec(
          "UPDATE policies SET gross_premium_minor=gross_premium_minor+1 WHERE id='synthetic-policy-00'",
        );
    } catch {
      if (db.isTransaction) db.exec('ROLLBACK;');
    } finally {
      db.close();
    }
    if (kind === 'data' && config.fault === 'queryResponseLost') lost();
    else
      reply(
        ok ? 200 : 400,
        ok
          ? envelope([
              {
                success: true,
                results: [],
                meta: { rows_read: 0, rows_written: 114, size_after: 1048576 },
              },
            ])
          : {
              success: false,
              result: null,
              errors: [{ code: 7500, message: 'synthetic batch failure' }],
            },
      );
  }
} else if (segments.at(-1) === 'query') {
  const dbPath = join(directory, 'target.sqlite'),
    db = new DatabaseSync(existsSync(dbPath) ? dbPath : ':memory:', { allowExtension: false });
  try {
    db.setAuthorizer((action) =>
      [
        constants.SQLITE_ATTACH,
        constants.SQLITE_DETACH,
        constants.SQLITE_INSERT,
        constants.SQLITE_UPDATE,
        constants.SQLITE_DELETE,
      ].includes(action)
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    const rows = db.prepare(JSON.parse(request.body).sql).all();
    reply(
      200,
      envelope([
        {
          success: true,
          results: rows,
          meta: { duration: 1, rows_read: rows.length, rows_written: 0, size_after: 1048576 },
        },
      ]),
    );
  } catch {
    reply(400, {
      success: false,
      result: null,
      errors: [{ code: 7500, message: 'synthetic query error' }],
    });
  } finally {
    db.close();
  }
} else if (request.method === 'DELETE') {
  state.delete++;
  if (config.fault === 'deleteFailure')
    reply(500, {
      success: false,
      result: null,
      errors: [{ code: 7500, message: 'synthetic failure' }],
    });
  else {
    state.resources = state.resources.filter((resource) => resource.uuid !== segments.at(-1));
    if (existsSync(join(directory, 'target.sqlite'))) unlinkSync(join(directory, 'target.sqlite'));
    if (config.fault === 'deleteResponseLost') lost();
    else reply(200, envelope(null));
  }
} else {
  let identity = state.resources.find((resource) => resource.uuid === segments.at(-1));
  if (identity && config.fault === 'wrongUuid')
    identity = { ...identity, uuid: '92967c6d-8aac-4323-9b3b-6e9bcb45f016' };
  if (identity) reply(200, envelope(identity));
  else
    reply(404, {
      success: false,
      result: null,
      errors: [
        {
          code: config.fault === 'maskedAuth404' ? 10000 : 7404,
          message:
            config.fault === 'maskedAuth404' ? 'authentication error' : 'D1 resource missing',
        },
      ],
    });
}
