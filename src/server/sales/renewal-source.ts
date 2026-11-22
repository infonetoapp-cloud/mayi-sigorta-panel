/** Aliases s/c/m/r/p/pb belong to the sales query. No Task fields in shared summaries. */
export const renewalSourceJoins = `LEFT JOIN renewal_opportunities r ON r.agency_id=s.agency_id AND r.id=s.renewal_id LEFT JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id LEFT JOIN insurance_branches pb ON pb.agency_id=p.agency_id AND pb.id=p.branch_id`;
export const renewalSourceReadGate = `(s.context_kind='NEW_BUSINESS' OR (
 r.id=s.renewal_id AND p.id=s.source_policy_id AND p.customer_id=s.customer_id
 AND (m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions x WHERE x.membership_id=m.id AND x.permission_code='policy.read' AND (x.scope='AGENCY' OR (x.scope='ASSIGNED' AND (p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)))))
 AND (m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions x WHERE x.membership_id=m.id AND x.permission_code='renewal.read' AND (x.scope='AGENCY' OR (x.scope='ASSIGNED' AND (r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)))))
 AND (pb.data_classification<>'HEALTH' OR EXISTS(SELECT 1 FROM membership_permissions h WHERE h.membership_id=m.id AND h.permission_code='sensitive.health.read' AND h.scope='UNSCOPED'))
))`;
