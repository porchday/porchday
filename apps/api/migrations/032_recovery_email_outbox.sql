-- A verified safe contact is not an account owner. Recovery email must also work
-- before an account is identified and while that account is on security hold.
ALTER TABLE public.auth_email_outbox ALTER COLUMN member_id DROP NOT NULL;
ALTER TABLE public.auth_email_outbox ADD COLUMN recovery_case_id uuid REFERENCES public.recovery_cases(id) ON DELETE CASCADE;
ALTER TABLE public.auth_email_outbox ADD COLUMN purpose text NOT NULL DEFAULT 'account'
 CHECK(purpose IN ('account','case_contact','case_restore','case_security'));
ALTER TABLE public.auth_email_outbox ADD CONSTRAINT email_principal CHECK(
 (purpose='account' AND member_id IS NOT NULL AND recovery_case_id IS NULL)
 OR (purpose<>'account' AND recovery_case_id IS NOT NULL AND member_id IS NULL)
);
CREATE INDEX email_case_pending ON public.auth_email_outbox(recovery_case_id,purpose) WHERE delivered_at IS NULL;
