-- Normalize pre-existing dotted capital I values to the canonical policy-number form.
-- The UPDATE is atomic and the existing candidate unique index rejects any collapsed collision.
UPDATE policies
SET normalized_policy_number = replace(normalized_policy_number, 'İ', 'I')
WHERE instr(normalized_policy_number, 'İ') > 0;
