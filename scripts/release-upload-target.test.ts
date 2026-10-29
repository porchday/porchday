import {expect,it} from 'vitest';
import {uploadTarget} from './release-upload-target';
import {deploymentTarget} from './deployment-recovery';
it.each(['staging','production'] as const)('allows inactive monitor uploads for %s without opening application activation',environment=>{
 expect(uploadTarget('porchday-monitor-'+environment)).toEqual({environment,frontend:false,application:'monitor',key:'monitor-'+environment});
 expect(()=>deploymentTarget('porchday-monitor-'+environment)).toThrow('DEPLOYMENT_TARGET_INVALID');
 expect(uploadTarget('porchday-'+environment)).toMatchObject({environment,frontend:false,application:'api',key:environment});
 expect(uploadTarget('porchday-'+environment+'-edge')).toMatchObject({environment,frontend:true,application:'api',key:environment+'-edge'});
});
it.each(['porchday-monitor-production-edge','porchday-monitor-preview','other-monitor-staging'])('rejects undeclared target %s',worker=>{expect(()=>uploadTarget(worker)).toThrow();});
