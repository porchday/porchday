-- Expose only the authenticated actor's existing builder access predicate.
-- No member argument, message access, or table privileges are added. Install
-- before the new bootstrap query; older application versions remain compatible.
GRANT EXECUTE ON FUNCTION app.builder_chat_allowed() TO porchday_social;
