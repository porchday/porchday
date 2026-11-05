import {describe,it,expect} from 'vitest';
import {parityCapabilities,validateNativeParity,validateNativeRun,validateNativeJobs} from './release-native-parity.ts';
const matrix=()=>({version:1,capabilities:parityCapabilities.map(id=>({id,ios:'verified',macos:'verified',evidence:['docs/native-parity.md#'+id]}))});
describe('production native parity gate',()=>{
 it('requires every reviewed capability on both platforms',()=>{expect(validateNativeParity(matrix())).toBeTruthy();for(const platform of ['ios','macos'] as const)for(const status of ['pending','deferred','build-only']){const m=matrix();m.capabilities[0][platform]=status;expect(()=>validateNativeParity(m)).toThrow(/NATIVE_PARITY_(PENDING|STATUS_INVALID)/);}});
 it('allows tracked hosted/device checks to remain pending without claiming verification',()=>{
  const m={...matrix(),version:2,capabilities:matrix().capabilities.map(row=>({...row,ios:'pending',macos:'pending',implementation:{ios:'implemented',macos:'implemented'},followUpIssues:['https://github.com/porchday/porchday/issues/49']}))};
  expect(validateNativeParity(m)).toBe(m);expect(m.capabilities[0].ios).toBe('pending');
  m.capabilities[0].implementation.ios='pending';expect(()=>validateNativeParity(m)).toThrow('NATIVE_PARITY_IMPLEMENTATION_PENDING');
  m.capabilities[0].implementation.ios='implemented';m.capabilities[0].followUpIssues=[];expect(()=>validateNativeParity(m)).toThrow('NATIVE_PARITY_FOLLOW_UP_MISSING');
  m.capabilities[0].followUpIssues=['not-an-issue'];expect(()=>validateNativeParity(m)).toThrow('NATIVE_PARITY_FOLLOW_UP_MISSING');
 });
 it('fails closed on missing duplicate or empty evidence',()=>{const m=matrix();m.capabilities.pop();expect(()=>validateNativeParity(m)).toThrow();const duplicate=matrix();duplicate.capabilities[1]=duplicate.capabilities[0];expect(()=>validateNativeParity(duplicate)).toThrow();const empty=matrix();empty.capabilities[1].evidence=[];expect(()=>validateNativeParity(empty)).toThrow();});
 it('requires exact-source successful native push CI from the same repository',()=>{const source='a'.repeat(40),path='.github/workflows/ios.yml',run={id:1,run_attempt:1,head_sha:source,path,event:'push',repository:{full_name:'porchday/porchday'},head_repository:{full_name:'porchday/porchday'},status:'completed',conclusion:'success'};expect(()=>validateNativeRun(run,source,path)).not.toThrow();for(const changes of [{head_sha:'b'.repeat(40)},{event:'pull_request'},{conclusion:'failure'},{status:'in_progress'},{path:'.github/workflows/ci.yml'},{head_repository:{full_name:'fork/repo'}}])expect(()=>validateNativeRun({...run,...changes},source,path)).toThrow();});
 it('rejects a green job whose required native checks were skipped',()=>{
  const source='a'.repeat(40),run={id:1,run_attempt:2};
  const steps=['Compile shared native Mac app','Run shared calendar, tag and media contract tests','Package verification artifact'].map(name=>({name,status:'completed',conclusion:'success'}));
  const job={name:'build',head_sha:source,run_id:1,run_attempt:2,status:'completed',conclusion:'success',steps};
  const result={total_count:1,jobs:[job]};expect(()=>validateNativeJobs(result,run,source,'macos.yml','build')).not.toThrow();
  steps[1].conclusion='skipped';expect(()=>validateNativeJobs(result,run,source,'macos.yml','build')).toThrow('NATIVE_PARITY_CI_STEP_NOT_VERIFIED');
  job.run_attempt=1;expect(()=>validateNativeJobs(result,run,source,'macos.yml','build')).toThrow('NATIVE_PARITY_CI_JOB_NOT_VERIFIED');
 });

});
