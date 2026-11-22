export const followupReasons = {
  DOCUMENTS_PENDING: 'Evrak / bilgi bekleniyor',
  CUSTOMER_RESPONSE_PENDING: 'Müşteri dönüşü bekleniyor',
  PRICE_REVISION_PENDING: 'Fiyat revizyonu bekleniyor',
  CALL_AGAIN: 'Müşteri tekrar aranacak',
} as const;
export type FollowupReason = keyof typeof followupReasons;
