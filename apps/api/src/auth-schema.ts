import type {Env} from './types';
/** Only completed metadata verdicts cross requests: never a socket, auth
 * instance, pending promise, session, permission, or member data. */
export class AuthSchemaGate {
 private verdicts=new Map<string,'valid'|'failed'>();
 key(env:Env):string|undefined {
  const version=env.CF_VERSION_METADATA?.id;
  // Local/unversioned runtimes always validate. A deployment or binding change
  // requires a new verdict. Auth schema migrations must roll a new deployment.
  return version?JSON.stringify([version,env.APP_URL,env.HYPERDRIVE_AUTH.connectionString]):undefined;
 }
 needsValidation(key:string|undefined):boolean {
  if(key===undefined)return true;
  if(this.verdicts.get(key)==='failed')throw Error('AUTH_SCHEMA_UNAVAILABLE');
  return this.verdicts.get(key)!=='valid';
 }
 succeeded(key:string|undefined):void {
  if(key===undefined)return;
  // A concurrent failure wins over a successful validation for this version.
  if(this.verdicts.get(key)==='failed')throw Error('AUTH_SCHEMA_UNAVAILABLE');
  this.verdicts.set(key,'valid');
 }
 failed(key:string|undefined):void {if(key!==undefined)this.verdicts.set(key,'failed');}
}
export const authSchemaGate=new AuthSchemaGate();
