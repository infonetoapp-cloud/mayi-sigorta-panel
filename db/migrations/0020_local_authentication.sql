CREATE TABLE `credential_operation_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`agency_id` text NOT NULL,
	`operation_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`actor_membership_id` text,
	`safe_response_json` text,
	`effect_audit_id` text,
	`grant_id` text,
	`target_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_operation_receipts_key_uq` ON `credential_operation_receipts` (`actor_user_id`,`agency_id`,`operation_key`);--> statement-breakpoint
CREATE TABLE `local_credentials` (
	`user_id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`login_email` text NOT NULL,
	`verifier` text NOT NULL,
	`credential_version` integer DEFAULT 1 NOT NULL,
	`must_change_password` integer DEFAULT 1 NOT NULL,
	`temporary_expires_at` integer,
	`login_enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`identity_id`) REFERENCES `auth_identities`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "local_credentials_version_positive" CHECK("local_credentials"."credential_version" >= 1),
	CONSTRAINT "local_credentials_flags" CHECK("local_credentials"."must_change_password" IN (0,1) AND "local_credentials"."login_enabled" IN (0,1)),
	CONSTRAINT "local_credentials_temporary_state" CHECK(("local_credentials"."must_change_password"=1 AND "local_credentials"."temporary_expires_at" IS NOT NULL) OR ("local_credentials"."must_change_password"=0 AND "local_credentials"."temporary_expires_at" IS NULL)),
	CONSTRAINT "local_credentials_email_canonical" CHECK("local_credentials"."login_email"=lower(trim("local_credentials"."login_email")) AND length("local_credentials"."login_email") BETWEEN 5 AND 254 AND instr("local_credentials"."login_email",'@')>1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_credentials_email_uq` ON `local_credentials` (`login_email`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_credentials_identity_uq` ON `local_credentials` (`identity_id`);--> statement-breakpoint
CREATE TABLE `local_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`identity_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`credential_version` integer NOT NULL,
	`permission_version` integer NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`recent_password_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`identity_id`) REFERENCES `auth_identities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`membership_id`) REFERENCES `agency_memberships`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "local_sessions_hash_shape" CHECK(length("local_sessions"."token_hash")=64 AND "local_sessions"."token_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "local_sessions_kind" CHECK("local_sessions"."kind" IN ('ACTIVATION','NORMAL')),
	CONSTRAINT "local_sessions_versions" CHECK("local_sessions"."credential_version">0 AND "local_sessions"."permission_version">0),
	CONSTRAINT "local_sessions_lifetime" CHECK("local_sessions"."expires_at">"local_sessions"."created_at" AND "local_sessions"."expires_at"<="local_sessions"."created_at"+43200000 AND "local_sessions"."last_seen_at">="local_sessions"."created_at" AND "local_sessions"."last_seen_at"<"local_sessions"."expires_at"),
	CONSTRAINT "local_sessions_restricted" CHECK("local_sessions"."kind"='NORMAL' OR ("local_sessions"."recent_password_at" IS NULL AND "local_sessions"."expires_at"<="local_sessions"."created_at"+900000))
);
--> statement-breakpoint
CREATE INDEX `local_sessions_user_idx` ON `local_sessions` (`user_id`);--> statement-breakpoint
ALTER TABLE `auth_identities` ADD `email_provenance` text DEFAULT 'LEGACY_EXTERNAL' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `display_name` text;
--> statement-breakpoint
CREATE TRIGGER local_credentials_identity_guard BEFORE INSERT ON local_credentials
WHEN NOT EXISTS(SELECT 1 FROM auth_identities i WHERE i.id=NEW.identity_id AND i.user_id=NEW.user_id AND i.issuer='urn:mayisigorta:local-auth:v1' AND i.email_provenance='OWNER_PROVISIONED' AND lower(trim(i.verified_email))=NEW.login_email)
BEGIN SELECT RAISE(ABORT,'LOCAL_IDENTITY_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER local_credentials_login_immutable BEFORE UPDATE ON local_credentials
WHEN NEW.user_id<>OLD.user_id OR NEW.identity_id<>OLD.identity_id OR NEW.login_email<>OLD.login_email OR NEW.credential_version<OLD.credential_version
BEGIN SELECT RAISE(ABORT,'LOCAL_LOGIN_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER local_sessions_insert_guard BEFORE INSERT ON local_sessions
WHEN NOT EXISTS(SELECT 1 FROM local_credentials c JOIN auth_identities i ON i.id=c.identity_id AND i.user_id=c.user_id JOIN users u ON u.id=c.user_id JOIN agency_memberships m ON m.id=NEW.membership_id AND m.user_id=c.user_id JOIN agencies a ON a.id=m.agency_id
WHERE c.user_id=NEW.user_id AND c.identity_id=NEW.identity_id AND c.credential_version=NEW.credential_version AND c.login_enabled=1 AND i.status='ACTIVE' AND i.issuer='urn:mayisigorta:local-auth:v1' AND i.email_provenance='OWNER_PROVISIONED' AND u.status='ACTIVE' AND m.status='ACTIVE' AND a.status='ACTIVE' AND m.permission_version=NEW.permission_version AND ((NEW.kind='NORMAL' AND c.must_change_password=0) OR (NEW.kind='ACTIVATION' AND c.must_change_password=1 AND c.temporary_expires_at>NEW.created_at AND NEW.expires_at<=c.temporary_expires_at)))
BEGIN SELECT RAISE(ABORT,'LOCAL_SESSION_AUTHORITY_CHANGED'); END;
--> statement-breakpoint
CREATE TRIGGER local_sessions_no_upgrade BEFORE UPDATE ON local_sessions
WHEN NEW.token_hash<>OLD.token_hash OR NEW.user_id<>OLD.user_id OR NEW.identity_id<>OLD.identity_id OR NEW.membership_id<>OLD.membership_id OR NEW.kind<>OLD.kind OR NEW.credential_version<>OLD.credential_version OR NEW.permission_version<>OLD.permission_version OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at OR NEW.recent_password_at IS NOT OLD.recent_password_at OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at) OR NEW.last_seen_at<OLD.last_seen_at
BEGIN SELECT RAISE(ABORT,'LOCAL_SESSION_ROTATION_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER local_membership_session_revoke AFTER UPDATE OF status,type,permission_version ON agency_memberships
WHEN NEW.status<>OLD.status OR NEW.type<>OLD.type OR NEW.permission_version<>OLD.permission_version
BEGIN
 UPDATE local_sessions SET revoked_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE membership_id=NEW.id AND revoked_at IS NULL;
 UPDATE local_credentials SET login_enabled=0,credential_version=credential_version+1 WHERE user_id=NEW.user_id AND NEW.status IN ('SUSPENDED','INACTIVE');
END;
--> statement-breakpoint
CREATE TRIGGER local_user_session_revoke AFTER UPDATE OF status ON users WHEN NEW.status<>'ACTIVE'
BEGIN
 UPDATE local_sessions SET revoked_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE user_id=NEW.id AND revoked_at IS NULL;
 UPDATE local_credentials SET login_enabled=0,credential_version=credential_version+1 WHERE user_id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER local_identity_session_revoke AFTER UPDATE OF status,user_id,issuer,subject ON auth_identities
WHEN NEW.status<>'ACTIVE' OR NEW.user_id<>OLD.user_id OR NEW.issuer<>OLD.issuer OR NEW.subject<>OLD.subject
BEGIN
 UPDATE local_sessions SET revoked_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE identity_id=NEW.id AND revoked_at IS NULL;
 UPDATE local_credentials SET login_enabled=0,credential_version=credential_version+1 WHERE identity_id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER local_credential_session_revoke AFTER UPDATE OF credential_version ON local_credentials WHEN NEW.credential_version<>OLD.credential_version
BEGIN UPDATE local_sessions SET revoked_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE user_id=NEW.user_id AND revoked_at IS NULL; END;
--> statement-breakpoint
CREATE TRIGGER credential_receipt_no_update BEFORE UPDATE ON credential_operation_receipts BEGIN SELECT RAISE(ABORT,'CREDENTIAL_RECEIPT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER credential_receipt_no_delete BEFORE DELETE ON credential_operation_receipts BEGIN SELECT RAISE(ABORT,'CREDENTIAL_RECEIPT_IMMUTABLE'); END;
--> statement-breakpoint
-- F-27: preserve historical actors and login bindings; reset/offboard instead of deleting credentials.
CREATE TRIGGER local_credentials_no_delete BEFORE DELETE ON local_credentials
BEGIN SELECT RAISE(ABORT,'LOCAL_CREDENTIAL_DELETE_FORBIDDEN'); END;
--> statement-breakpoint
CREATE TRIGGER local_credentials_no_row_replacement BEFORE INSERT ON local_credentials
WHEN EXISTS(SELECT 1 FROM local_credentials c WHERE c.user_id=NEW.user_id OR c.identity_id=NEW.identity_id OR c.login_email=NEW.login_email)
BEGIN SELECT RAISE(ABORT,'LOCAL_CREDENTIAL_ROW_REPLACEMENT_FORBIDDEN'); END;
--> statement-breakpoint
CREATE TRIGGER local_identity_binding_immutable BEFORE UPDATE ON auth_identities
WHEN EXISTS(SELECT 1 FROM local_credentials c WHERE c.identity_id=OLD.id)
AND (NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.issuer<>OLD.issuer OR NEW.subject<>OLD.subject OR NEW.verified_email<>OLD.verified_email OR NEW.email_provenance<>OLD.email_provenance)
BEGIN SELECT RAISE(ABORT,'LOCAL_IDENTITY_BINDING_IMMUTABLE'); END;
--> statement-breakpoint
-- Once an ACTIVE agency has local credentials, only a matching enabled LOCAL owner counts.
-- Temp credentials remain technical owner recovery state; forced change is a separate session gate.
CREATE TRIGGER local_credentials_insert_owner_guard AFTER INSERT ON local_credentials
WHEN EXISTS(SELECT 1 FROM agencies a JOIN agency_memberships target ON target.agency_id=a.id
 WHERE a.status='ACTIVE' AND target.user_id=NEW.user_id
 AND NOT EXISTS(SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
 JOIN local_credentials c ON c.user_id=u.id JOIN auth_identities i ON i.id=c.identity_id AND i.user_id=u.id
 WHERE m.agency_id=a.id AND m.type='OWNER' AND m.status='ACTIVE' AND u.status='ACTIVE'
 AND c.login_enabled=1 AND i.status='ACTIVE' AND i.issuer='urn:mayisigorta:local-auth:v1'
 AND i.email_provenance='OWNER_PROVISIONED' AND lower(trim(i.verified_email))=c.login_email))
BEGIN SELECT RAISE(ABORT,'LAST_EFFECTIVE_LOCAL_OWNER_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER local_credentials_update_owner_guard AFTER UPDATE ON local_credentials
WHEN EXISTS(SELECT 1 FROM agencies a JOIN agency_memberships target ON target.agency_id=a.id
 WHERE a.status='ACTIVE' AND target.user_id IN (OLD.user_id,NEW.user_id)
 AND NOT EXISTS(SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
 JOIN local_credentials c ON c.user_id=u.id JOIN auth_identities i ON i.id=c.identity_id AND i.user_id=u.id
 WHERE m.agency_id=a.id AND m.type='OWNER' AND m.status='ACTIVE' AND u.status='ACTIVE'
 AND c.login_enabled=1 AND i.status='ACTIVE' AND i.issuer='urn:mayisigorta:local-auth:v1'
 AND i.email_provenance='OWNER_PROVISIONED' AND lower(trim(i.verified_email))=c.login_email))
BEGIN SELECT RAISE(ABORT,'LAST_EFFECTIVE_LOCAL_OWNER_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER local_membership_effective_owner_guard AFTER UPDATE ON agency_memberships
WHEN EXISTS(SELECT 1 FROM agencies a WHERE a.id IN (OLD.agency_id,NEW.agency_id) AND a.status='ACTIVE'
 AND EXISTS(SELECT 1 FROM agency_memberships bound JOIN local_credentials credential ON credential.user_id=bound.user_id WHERE bound.agency_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
 JOIN local_credentials c ON c.user_id=u.id JOIN auth_identities i ON i.id=c.identity_id AND i.user_id=u.id
 WHERE m.agency_id=a.id AND m.type='OWNER' AND m.status='ACTIVE' AND u.status='ACTIVE'
 AND c.login_enabled=1 AND i.status='ACTIVE' AND i.issuer='urn:mayisigorta:local-auth:v1'
 AND i.email_provenance='OWNER_PROVISIONED' AND lower(trim(i.verified_email))=c.login_email))
BEGIN SELECT RAISE(ABORT,'LAST_EFFECTIVE_LOCAL_OWNER_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER local_membership_insert_owner_guard AFTER INSERT ON agency_memberships
WHEN EXISTS(SELECT 1 FROM agencies a WHERE a.id=NEW.agency_id AND a.status='ACTIVE'
 AND EXISTS(SELECT 1 FROM agency_memberships bound JOIN local_credentials credential ON credential.user_id=bound.user_id WHERE bound.agency_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
 JOIN local_credentials c ON c.user_id=u.id JOIN auth_identities i ON i.id=c.identity_id AND i.user_id=u.id
 WHERE m.agency_id=a.id AND m.type='OWNER' AND m.status='ACTIVE' AND u.status='ACTIVE'
 AND c.login_enabled=1 AND i.status='ACTIVE' AND i.issuer='urn:mayisigorta:local-auth:v1'
 AND i.email_provenance='OWNER_PROVISIONED' AND lower(trim(i.verified_email))=c.login_email))
BEGIN SELECT RAISE(ABORT,'LAST_EFFECTIVE_LOCAL_OWNER_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER local_user_effective_owner_guard AFTER UPDATE ON users
WHEN EXISTS(SELECT 1 FROM agencies a JOIN agency_memberships target ON target.agency_id=a.id
 WHERE a.status='ACTIVE' AND target.user_id IN (OLD.id,NEW.id)
 AND EXISTS(SELECT 1 FROM agency_memberships bound JOIN local_credentials credential ON credential.user_id=bound.user_id WHERE bound.agency_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
 JOIN local_credentials c ON c.user_id=u.id JOIN auth_identities i ON i.id=c.identity_id AND i.user_id=u.id
 WHERE m.agency_id=a.id AND m.type='OWNER' AND m.status='ACTIVE' AND u.status='ACTIVE'
 AND c.login_enabled=1 AND i.status='ACTIVE' AND i.issuer='urn:mayisigorta:local-auth:v1'
 AND i.email_provenance='OWNER_PROVISIONED' AND lower(trim(i.verified_email))=c.login_email))
BEGIN SELECT RAISE(ABORT,'LAST_EFFECTIVE_LOCAL_OWNER_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER local_identity_effective_owner_guard AFTER UPDATE ON auth_identities
WHEN EXISTS(SELECT 1 FROM agencies a JOIN agency_memberships target ON target.agency_id=a.id
 WHERE a.status='ACTIVE' AND target.user_id IN (OLD.user_id,NEW.user_id)
 AND EXISTS(SELECT 1 FROM agency_memberships bound JOIN local_credentials credential ON credential.user_id=bound.user_id WHERE bound.agency_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
 JOIN local_credentials c ON c.user_id=u.id JOIN auth_identities i ON i.id=c.identity_id AND i.user_id=u.id
 WHERE m.agency_id=a.id AND m.type='OWNER' AND m.status='ACTIVE' AND u.status='ACTIVE'
 AND c.login_enabled=1 AND i.status='ACTIVE' AND i.issuer='urn:mayisigorta:local-auth:v1'
 AND i.email_provenance='OWNER_PROVISIONED' AND lower(trim(i.verified_email))=c.login_email))
BEGIN SELECT RAISE(ABORT,'LAST_EFFECTIVE_LOCAL_OWNER_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER local_agency_effective_owner_guard AFTER UPDATE ON agencies
WHEN NEW.status='ACTIVE'
 AND EXISTS(SELECT 1 FROM agency_memberships bound JOIN local_credentials credential ON credential.user_id=bound.user_id WHERE bound.agency_id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
 JOIN local_credentials c ON c.user_id=u.id JOIN auth_identities i ON i.id=c.identity_id AND i.user_id=u.id
 WHERE m.agency_id=NEW.id AND m.type='OWNER' AND m.status='ACTIVE' AND u.status='ACTIVE'
 AND c.login_enabled=1 AND i.status='ACTIVE' AND i.issuer='urn:mayisigorta:local-auth:v1'
 AND i.email_provenance='OWNER_PROVISIONED' AND lower(trim(i.verified_email))=c.login_email)
BEGIN SELECT RAISE(ABORT,'LAST_EFFECTIVE_LOCAL_OWNER_REQUIRED'); END;