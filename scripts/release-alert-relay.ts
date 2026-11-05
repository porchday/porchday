import {deliverReleaseAlert,validateReleaseAlert} from './release-alerts.ts';
try{
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!=='porchday/porchday'||process.env.GITHUB_REF!=='refs/heads/main'||!['andyk','bobbyhwilder'].includes(process.env.GITHUB_ACTOR??''))throw Error('RELEASE_ALERT_RELAY_SCOPE');
 const text=process.env.PORCHDAY_RELEASE_ALERT_PAYLOAD??'';if(text.length>4096)throw Error('RELEASE_ALERT_TOO_LARGE');
 const event=JSON.parse(text);validateReleaseAlert(event);if(event.operationId!==process.env.PORCHDAY_RELEASE_OPERATION_ID)throw Error('RELEASE_ALERT_ID_CHANGED');
 if(await deliverReleaseAlert(event,{bot:true})!=='delivered')throw Error('RELEASE_ALERT_NOT_CONFIRMED');
 console.log('RELEASE_ALERT_DELIVERED');
}catch{console.error('RELEASE_ALERT_DELIVERY_UNCONFIRMED');process.exitCode=1;}
