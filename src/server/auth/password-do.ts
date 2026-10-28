import { DurableObject } from 'cloudflare:workers';
import { PasswordKdfService } from './password-kdf-service';
/** Private RPC only. No fetch endpoint and no storage/alarms/password/auth state. */
export class PasswordKdfDurableObject extends DurableObject {
  #service = new PasswordKdfService();
  hash(password: string) {
    return this.#service.hash(password);
  }
  verify(password: string, verifier: string) {
    return this.#service.verify(password, verifier);
  }
}
