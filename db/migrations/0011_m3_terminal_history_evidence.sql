ALTER TABLE `renewal_state_history` ADD `loss_reason_id` text;--> statement-breakpoint
ALTER TABLE `renewal_state_history` ADD `loss_reason_notes` text;--> statement-breakpoint
ALTER TABLE `renewal_state_history` ADD `void_reason_code` text;
--> statement-breakpoint
CREATE TRIGGER renewal_state_history_terminal_evidence_validate
BEFORE INSERT ON renewal_state_history
WHEN
  (NEW.to_state='LOST' AND (
    NEW.reason_code<>'LOST'
    OR NEW.loss_reason_id IS NULL
    OR NEW.void_reason_code IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM loss_reasons lr
      WHERE lr.agency_id=NEW.agency_id AND lr.id=NEW.loss_reason_id AND lr.status='ACTIVE'
    )
    OR NOT EXISTS (
      SELECT 1 FROM loss_reasons lr
      WHERE lr.agency_id=NEW.agency_id AND lr.id=NEW.loss_reason_id
        AND ((lr.code='OTHER' AND NEW.loss_reason_notes IS NOT NULL
              AND length(trim(NEW.loss_reason_notes)) BETWEEN 1 AND 500)
          OR (lr.code<>'OTHER' AND NEW.loss_reason_notes IS NULL))
    )
  ))
  OR (NEW.to_state='VOIDED' AND (
    NEW.reason_code<>NEW.void_reason_code
    OR NEW.void_reason_code IS NULL
    OR NEW.void_reason_code NOT IN (
      'TECHNICAL_ERROR','DUPLICATE','NOT_ELIGIBLE_AFTER_CANCELLATION_OR_RESTRUCTURE'
    )
    OR NEW.loss_reason_id IS NOT NULL
    OR NEW.loss_reason_notes IS NOT NULL
  ))
  OR (NEW.to_state NOT IN ('LOST','VOIDED') AND (
    NEW.loss_reason_id IS NOT NULL
    OR NEW.loss_reason_notes IS NOT NULL
    OR NEW.void_reason_code IS NOT NULL
  ))
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_TERMINAL_EVIDENCE_INVALID');
END;
--> statement-breakpoint
CREATE TRIGGER loss_reasons_terminal_history_no_delete
BEFORE DELETE ON loss_reasons
WHEN EXISTS (
  SELECT 1 FROM renewal_state_history h
  WHERE h.agency_id=OLD.agency_id AND h.loss_reason_id=OLD.id
)
BEGIN
  SELECT RAISE(ABORT,'LOSS_REASON_HISTORY_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER loss_reasons_terminal_history_identity_immutable
BEFORE UPDATE OF id,agency_id,code ON loss_reasons
WHEN EXISTS (
  SELECT 1 FROM renewal_state_history h
  WHERE h.agency_id=OLD.agency_id AND h.loss_reason_id=OLD.id
)
BEGIN
  SELECT RAISE(ABORT,'LOSS_REASON_HISTORY_IMMUTABLE');
END;