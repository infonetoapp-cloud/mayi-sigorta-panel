import type { Context, Hono } from 'hono';
import type { AuthenticatedUserContext } from '../auth/identity';
import { createSecurityBoundaryMiddleware } from '../security/boundary';
import {
  executeProtectedPermissionMutation,
  type PermissionMutationOperation,
} from './internal/protected-permission-executor';

export type { PermissionMutationOperation } from './internal/protected-permission-executor';

export interface ProtectedPermissionRouteAuthentication {
  readonly context: AuthenticatedUserContext;
  readonly subject: string;
}

export interface ProtectedPermissionRouteRequest {
  readonly agencyId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly grantEvidenceToken: string;
  readonly operation: PermissionMutationOperation;
}

export interface ProtectedPermissionMutationBindings {
  readonly DB: D1Database;
  readonly [key: string]: unknown;
}

type ProtectedPermissionMutationEnv = { Bindings: ProtectedPermissionMutationBindings };

export interface ProtectedPermissionMutationRouteConfig {
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly authenticate: (
    context: Context<ProtectedPermissionMutationEnv>,
  ) => Promise<ProtectedPermissionRouteAuthentication>;
  readonly resolveCsrfSecret: (context: Context<ProtectedPermissionMutationEnv>) => string;
  readonly parseRequest: (
    context: Context<ProtectedPermissionMutationEnv>,
  ) => Promise<ProtectedPermissionRouteRequest>;
}

/**
 * Phase-1 permission mutations için tek desteklenen route bileşimi.
 * Request boundary ve CSRF bu kayıt fonksiyonunun içinde zorunludur; route yazarı
 * bu katmanları atlayıp yalnız executor çağıran bir handler kaydedemez.
 */
export function registerProtectedPermissionMutationRoute(
  app: Hono<ProtectedPermissionMutationEnv>,
  config: ProtectedPermissionMutationRouteConfig,
): void {
  app.on(config.method, config.path, createSecurityBoundaryMiddleware(), async (context) => {
    try {
      const authentication = await config.authenticate(context);
      const result = await executeProtectedPermissionMutation(context.env.DB, {
        request: context.req.raw,
        csrfSecret: config.resolveCsrfSecret(context),
        authenticatedSubject: authentication.subject,
        context: authentication.context,
        resolveMutation: () => config.parseRequest(context),
      });
      return context.json(
        {
          success: true,
          data: result.body,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch {
      return context.json(
        {
          success: false,
          error: { code: 'FORBIDDEN', message: 'Erişim reddedildi.' },
          timestamp: new Date().toISOString(),
        },
        403,
      );
    }
  });
}
