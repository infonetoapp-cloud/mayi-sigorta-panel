import worker, { type Env } from './index';
import { dispatchDocumentUpload } from './documents/upload-dispatch';
export default {
  ...worker,
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/api/documents' &&
      env.DOCUMENTS_ENABLED === 'true'
    )
      return dispatchDocumentUpload(request, env);
    return worker.fetch(request, env, ctx);
  },
};
export { PasswordKdfDurableObject } from './auth/password-do';
export { DocumentUploadDurableObject } from './documents/upload-do';
