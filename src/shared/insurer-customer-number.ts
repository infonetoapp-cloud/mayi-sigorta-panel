/** Reserved local CRM reference namespace; no external system calls. */
export const insurerNumberNamespace = (insurerId: string) => `insurer:${insurerId}`;
export interface InsurerCustomerNumber {
  readonly insurerId: string;
  readonly insurerName: string;
  readonly customerNumber: string;
}
export interface InsurerNumberOptions {
  readonly items: readonly { id: string; name: string }[];
  readonly nextCursor: string | null;
}
