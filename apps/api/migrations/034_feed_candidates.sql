-- Match the membership probe in can_post without scanning every recipient
-- device of a post. This is an access-path change; the existing RLS policies
-- remain the final authority for reads, including expiry and historical grants.
CREATE INDEX post_recipients_member ON app.post_recipients(post_id,member_id);
