/** Internal proof carried only after an acknowledged pre-COMMIT ROLLBACK.
 * A later ROLLBACK cannot prove the outcome of an attempted COMMIT. */
export class ConfirmedTransactionRollback extends Error {
  constructor(readonly originalError: unknown) {
    super('TRANSACTION_ROLLBACK_CONFIRMED');
  }
}
