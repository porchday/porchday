import {useRecoveryAction} from './RecoveryConfirmation';
import React, {useState} from 'react';
import {get} from './api';
import {ActionFeedback, Button, Field} from './ui';
import {verifyRecoveryBackup, type RecoveryBackup} from './recovery-check';

export function RecoverySettings({memberId=''}:{memberId?:string}={}) {
  const [secret, setSecret] = useState('');
  const action = useRecoveryAction(memberId);
  return <section className="panel form-stack" data-diagnostic-private>
    <h2>Check your recovery setup</h2>
    <p>Your recovery secret unlocks encrypted backups of your private keys. Those keys let you read your history and authorize a replacement device. This is separate from your login password and two-factor backup codes.</p>
    <p>Retrieve the secret you saved in your password manager or private printed note. This check runs on this device, without sending the secret to Porchday or changing your keys.</p>
    <form className="form-stack" onSubmit={event => {
      event.preventDefault();
      if (action.busy) return;
      void action.runRecovery('check',async () => {
        const input = secret;
        const result = await get('/keys/backup') as {envelope: RecoveryBackup};
        await verifyRecoveryBackup(result.envelope, input, memberId);setSecret('');
      }, 'Your saved secret unlocked all backed-up keys, including the key needed to authorize a replacement device. Keep that saved copy safe.');
    }}>
      <Field label="Saved encryption recovery secret" type="password" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} value={secret} onChange={event => setSecret(event.target.value)} required disabled={action.busy||action.confirming}/>
      <Button variant="outline" busy={action.busy} disabled={!secret.trim()}>Check saved secret</Button>
    </form>
    <ActionFeedback error={action.error} notice={action.notice}/>{action.confirmation('check')}
    <p className="small-copy">Keep a second private copy somewhere independent of this device. If you cannot find the secret, stay signed in: do not delete the account, reinstall the app or clear its storage. Support cannot reconstruct lost encryption keys.</p>
  </section>;
}
