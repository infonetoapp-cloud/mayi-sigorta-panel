import { createScryptPasswordHasher } from './password-scrypt';
/** Controlled Node administration only. Never the default HTTP Worker composition. */
export const localAdminPasswordHasher = createScryptPasswordHasher();
