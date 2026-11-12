-- Additive, ciphertext-only recovery metadata. Existing members are grandfathered.
ALTER TABLE app.members ADD COLUMN recovery_setup_eligible boolean NOT NULL DEFAULT false;
ALTER TABLE app.members ALTER COLUMN recovery_setup_eligible SET DEFAULT true;
ALTER TABLE app.members ADD COLUMN recovery_setup_required boolean NOT NULL DEFAULT false;
-- Only a new enrollment using the recovery-aware client opts into the requirement.
CREATE TABLE app.key_recovery_methods (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('passkey','contacts')), record jsonb NOT NULL CHECK(octet_length(record::text)<200000),
 created_at timestamptz NOT NULL DEFAULT now(), disabled_at timestamptz,
 UNIQUE(id,owner_id)
);
CREATE TABLE app.key_recovery_contacts (
 method_id uuid NOT NULL, owner_id uuid NOT NULL, member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 device_id uuid NOT NULL REFERENCES app.device_keys ON DELETE CASCADE,
 accepted_at timestamptz, declined_at timestamptz, proof jsonb,
 PRIMARY KEY(method_id,member_id), FOREIGN KEY(method_id,owner_id) REFERENCES app.key_recovery_methods(id,owner_id) ON DELETE CASCADE,
 CHECK(owner_id<>member_id)
);
CREATE TABLE app.key_recovery_requests (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 method_id uuid, kind text NOT NULL CHECK(kind IN ('pair','contacts')),
 record jsonb NOT NULL CHECK(octet_length(record::text)<50000),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','consumed','cancelled')),
 approval jsonb CHECK(octet_length(approval::text)<2100000),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 CHECK((kind='pair')=(method_id IS NULL)),
 FOREIGN KEY(method_id,owner_id) REFERENCES app.key_recovery_methods(id,owner_id) ON DELETE CASCADE
);
CREATE TABLE app.key_recovery_responses (
 request_id uuid NOT NULL REFERENCES app.key_recovery_requests ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 record jsonb NOT NULL CHECK(octet_length(record::text)<50000), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(request_id,member_id)
);
CREATE TABLE app.key_recovery_checks (
 member_id uuid PRIMARY KEY REFERENCES app.members ON DELETE CASCADE,
 kit_checked_at timestamptz, prompt_dismissed_at timestamptz,
 proof jsonb CHECK(octet_length(proof::text)<20000)
);
ALTER TABLE app.key_recovery_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.key_recovery_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.key_recovery_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.key_recovery_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.key_recovery_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY recovery_contact_read ON app.key_recovery_contacts FOR SELECT USING(app.may_read() AND (owner_id=app.actor() OR member_id=app.actor()));
CREATE POLICY recovery_contact_insert ON app.key_recovery_contacts FOR INSERT WITH CHECK(app.may_write() AND owner_id=app.actor());
CREATE POLICY recovery_contact_update ON app.key_recovery_contacts FOR UPDATE USING(app.may_read() AND (owner_id=app.actor() OR member_id=app.actor())) WITH CHECK(app.may_read() AND (owner_id=app.actor() OR member_id=app.actor()));
CREATE POLICY recovery_method_read ON app.key_recovery_methods FOR SELECT USING(app.may_read() AND (owner_id=app.actor() OR EXISTS(SELECT FROM app.key_recovery_contacts c WHERE c.method_id=id AND c.member_id=app.actor())));
CREATE POLICY recovery_method_insert ON app.key_recovery_methods FOR INSERT WITH CHECK(app.may_write() AND owner_id=app.actor());
CREATE POLICY recovery_method_update ON app.key_recovery_methods FOR UPDATE USING(app.may_write() AND owner_id=app.actor()) WITH CHECK(app.may_write() AND owner_id=app.actor());
CREATE POLICY recovery_request_read ON app.key_recovery_requests FOR SELECT USING(app.may_read() AND (owner_id=app.actor() OR EXISTS(SELECT FROM app.key_recovery_contacts c WHERE c.method_id=key_recovery_requests.method_id AND c.member_id=app.actor() AND c.accepted_at IS NOT NULL AND c.declined_at IS NULL)));
CREATE POLICY recovery_request_write ON app.key_recovery_requests FOR ALL USING(app.may_read() AND owner_id=app.actor()) WITH CHECK(app.may_read() AND owner_id=app.actor());
CREATE POLICY recovery_response_read ON app.key_recovery_responses FOR SELECT USING(app.may_read() AND (owner_id=app.actor() OR member_id=app.actor()));
CREATE POLICY recovery_response_insert ON app.key_recovery_responses FOR INSERT WITH CHECK(app.may_read() AND member_id=app.actor() AND EXISTS(SELECT FROM app.key_recovery_requests r JOIN app.key_recovery_contacts c ON c.method_id=r.method_id WHERE r.id=request_id AND r.owner_id=key_recovery_responses.owner_id AND r.state='pending' AND r.expires_at>now() AND c.member_id=app.actor() AND c.accepted_at IS NOT NULL AND c.declined_at IS NULL));
CREATE POLICY recovery_check_owner ON app.key_recovery_checks FOR ALL USING(app.may_read() AND member_id=app.actor()) WITH CHECK(app.may_read() AND member_id=app.actor());
GRANT SELECT,INSERT,UPDATE ON app.key_recovery_methods,app.key_recovery_contacts,app.key_recovery_requests,app.key_recovery_checks TO porchday_social;
GRANT SELECT,INSERT ON app.key_recovery_responses TO porchday_social;
CREATE INDEX recovery_contact_inbox ON app.key_recovery_contacts(member_id);
CREATE INDEX recovery_request_owner ON app.key_recovery_requests(owner_id,created_at);
CREATE TABLE app.key_recovery_action_nonces (
 id uuid PRIMARY KEY, member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.key_recovery_action_nonces ENABLE ROW LEVEL SECURITY;
CREATE POLICY recovery_nonce_owner ON app.key_recovery_action_nonces FOR INSERT WITH CHECK(member_id=app.actor() AND app.may_read());
GRANT INSERT ON app.key_recovery_action_nonces TO porchday_social;
GRANT UPDATE(recovery_setup_required) ON app.members TO porchday_social;
CREATE TABLE app.key_pair_invitations (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 record jsonb NOT NULL CHECK(octet_length(record::text)<20000),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 request_id uuid UNIQUE REFERENCES app.key_recovery_requests ON DELETE CASCADE
);
ALTER TABLE app.key_pair_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY pair_invitation_owner ON app.key_pair_invitations FOR ALL USING(owner_id=app.actor() AND app.may_read()) WITH CHECK(owner_id=app.actor() AND app.may_read());
GRANT SELECT,INSERT,UPDATE ON app.key_pair_invitations TO porchday_social;
