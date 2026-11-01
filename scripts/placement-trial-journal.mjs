import {constants,openSync,closeSync,fsyncSync,fstatSync,lstatSync,mkdirSync,readdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {startTrial,advanceTrial,validateTrialHistory} from './placement-trial.mjs';

/** Append-only decisions; the external deployment lease supplies exclusion.
 * The baseline and operation identity are pinned by the reviewed trial plan.
 * A partial write is an unresolved trial, never an invitation to start again.
 */
export class FilePlacementTrialJournal {
  constructor({directory,operationId,startedAt,baseline,assertLease}) {
    this.baseline=structuredClone(baseline);
    this.initial=startTrial(operationId,startedAt,this.baseline);
    this.assertLease=assertLease;
    this.directory=directory;
    assertLease();
    if(!isAbsolute(directory))throw Error('TRIAL_JOURNAL_PATH_INVALID');
    mkdirSync(directory,{recursive:true,mode:0o700});
    const s=lstatSync(directory);
    if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(directory)!==directory||s.uid!==process.getuid()||(s.mode&0o077)!==0)
      throw Error('TRIAL_JOURNAL_PERMISSIONS');
  }
  read() {
    this.assertLease();
    const records=readdirSync(this.directory).sort().map((name,i)=>{
      if(name!==String(i+1).padStart(5,'0')+'.json')throw Error('TRIAL_JOURNAL_SEQUENCE_INVALID');
      const fd=openSync(join(this.directory,name),constants.O_RDONLY|constants.O_NOFOLLOW);
      try {
        const s=fstatSync(fd);
        if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)!==0||s.size<1||s.size>256*1024)
          throw Error('TRIAL_JOURNAL_PERMISSIONS');
        return JSON.parse(readFileSync(fd,'utf8'));
      } finally {closeSync(fd);}
    });
    if(!records.length)return null;
    if(!isDeepStrictEqual(records[0],this.initial))throw Error('TRIAL_JOURNAL_SCOPE_CHANGED');
    const result=validateTrialHistory(records,this.baseline);
    this.assertLease();
    return result;
  }
  start() {
    if(this.read())throw Error('TRIAL_ALREADY_STARTED');
    return this.append(null,this.initial);
  }
  sample(expected,sample) {
    return this.append(expected,advanceTrial(expected,sample,this.baseline));
  }
  append(expected,next) {
    if(!isDeepStrictEqual(this.read(),expected))throw Error('TRIAL_JOURNAL_CONFLICT');
    // Also validate externally supplied records; append is not an escape hatch.
    const computed=expected?advanceTrial(expected,next.sample,this.baseline):this.initial;
    if(!isDeepStrictEqual(computed,next))throw Error('TRIAL_JOURNAL_RECORD_INVALID');
    this.assertLease();
    const fd=openSync(join(this.directory,String(next.revision).padStart(5,'0')+'.json'),
      constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{writeFileSync(fd,JSON.stringify(next)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
    const parent=openSync(this.directory,constants.O_RDONLY);
    try{fsyncSync(parent);}finally{closeSync(parent);}
    this.assertLease();
    return this.read();
  }
}
