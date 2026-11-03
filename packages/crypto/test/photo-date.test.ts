import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContext, type ContentContext } from '../src/index.ts';
const id='4ca67d22-458c-4b4f-9fdc-a8d6cc36d94b';
const context:ContentContext={id,kind:'photo',authorId:id,authorDeviceId:id,audience:'only_me',parentId:id,groupId:null,epoch:1,revision:1,createdAt:new Date().toISOString(),expiresAt:null,photoDate:'2024-02-29'};
test('photo dates are valid date-only Gregorian values, including leap days and year boundaries',()=>{
 for(const photoDate of ['0001-01-01','9999-12-31','2024-02-29','2000-02-29'])assert.doesNotThrow(()=>validateContext({...context,photoDate}));
 for(const photoDate of [undefined,'0000-01-01','2026-02-29','1900-02-29','2026-04-31','2026-13-01','2026-11-02T00:00:00Z','2026-1-2'])assert.throws(()=>validateContext({...context,photoDate}));
});
test('a photo date cannot be attached to a post; historical post contexts remain valid',()=>{
 assert.throws(()=>validateContext({...context,kind:'post'}));
 const {photoDate:_,...post}=context;
 assert.doesNotThrow(()=>validateContext({...post,kind:'post',parentId:null}));
});
