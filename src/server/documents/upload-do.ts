import { DurableObject } from 'cloudflare:workers';
import { app, type Env } from '../index';
import { createUploadRuntime } from './upload-runtime';

/** Private SQLite DO. No storage, alarms, sessions, passwords or document state. */
export class DocumentUploadDurableObject extends DurableObject<Env> {
  #runtime = createUploadRuntime((request, env) => Promise.resolve(app.fetch(request, env)));
  fetch(request: Request): Promise<Response> {
    return this.#runtime.fetch(request, this.env);
  }
}
