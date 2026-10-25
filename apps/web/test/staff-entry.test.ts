import {test,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {StaffEntry,StaffConsole} from '../src/Staff';

test('staff entry and recovery render without a social member or unlocked vault',()=>{
 const entry=renderToStaticMarkup(createElement(StaffEntry));
 expect(entry).toContain('Porchday staff');
 expect(entry).toContain('Cloudflare Access');
 const recovery=renderToStaticMarkup(createElement(StaffConsole,{roles:['recovery']}));
 expect(recovery).toContain('Recovery cases');
 expect(recovery).not.toContain('Community reports');
 expect(recovery).not.toContain('Register this device');
});

test('moderation without a vault offers an explicit trusted-device entry',()=>{
 const html=renderToStaticMarkup(createElement(StaffConsole,{roles:['moderation']}));
 expect(html).toContain('Community reports');
 expect(html).toContain('href="/staff/moderation"');
 expect(html).not.toContain('Register this device');
 expect(html).not.toContain('Account recovery</button>');
});
