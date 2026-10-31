// Finite aggregate dimensions; never operation, member or request identifiers.
export const JOURNAL_PHASES=['read_guard','read_guard_close','rate_limit','initial_authorization','guard','registration','work','work_pool_acquire','work_begin','work_identity_lock','work_reauthorization','work_handler','work_commit','work_rollback','checkpoint','receipt','retirement','close','r2_read','r2_write','database_status','database_page'] as const;
export type JournalPhase=typeof JOURNAL_PHASES[number];
