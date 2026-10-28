/** Local-only keyboard/semantics journeys. Every API response is synthetic. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {chromium, type Locator, type Page} from 'playwright';
import {generateDeviceKeys, unlockPrivateKey, encryptObject, decryptObject, createReactionSecret, type EncryptedEnvelope} from '../packages/crypto/src/index.ts';

const target = new URL(process.argv[2] || 'http://127.0.0.1:5173');
if (process.argv.length > 3 || target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw Error('LOOPBACK_ORIGIN_REQUIRED');
const browser = await chromium.launch({headless: true});
async function focused(locator: Locator) {
  await locator.page().waitForFunction(element => document.activeElement === element, await locator.elementHandle());
}
async function reach(page: Page, locator: Locator) {
  await locator.waitFor({state: 'visible'});
  for (let i = 0; i < 100; i++) {
    if (await locator.evaluate(element => document.activeElement === element)) return;
    await page.keyboard.press('Tab');
  }
  throw Error('CONTROL_NOT_KEYBOARD_REACHABLE');
}
async function activate(page: Page, locator: Locator) {
  await reach(page, locator);
  await page.keyboard.press('Enter');
}
async function trapped(page: Page) {
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('dialog[open]')), true);
  }
}
try {
  // Signup error and success, without using email or any live account.
  const context = await browser.newContext({serviceWorkers: 'block'});
  const page = await context.newPage();
  let signups = 0;
  const unexpected: string[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== target.origin) { unexpected.push('EXTERNAL_REQUEST'); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname !== '/api/auth/sign-up/email') { unexpected.push('UNEXPECTED_SIGNUP_API'); return route.fulfill({status: 400, json: {}}); }
    const body = route.request().postDataJSON();
    assert.equal(body.adult, true); assert.equal(body.acceptedRules, true);
    signups++;
    return route.fulfill(signups === 1 ? {status: 400, json: {error: {code: 'INVITE_INVALID'}}} : {json: {ok: true}});
  });
  await page.goto(target.origin);
  await page.keyboard.press('Tab');
  await focused(page.getByRole('link', {name: 'Skip to content'}));
  await page.keyboard.press('Enter');
  await focused(page.locator('#main-content'));
  await activate(page, page.getByRole('link', {name: 'create account', exact: true}));
  await focused(page.getByRole('heading', {name: 'Create account'}));
  await activate(page, page.getByRole('button', {name: 'Create my account'}));
  await focused(page.getByRole('textbox', {name: 'Email address', exact: true}));
  await page.keyboard.type('keyboard@example.test');
  await reach(page, page.getByRole('textbox', {name: 'Your handle', exact: true}));
  const helpId = await page.getByRole('textbox', {name: 'Your handle', exact: true}).getAttribute('aria-describedby');
  assert.ok(helpId && await page.locator(`[id="${helpId}"]`).innerText());
  await page.keyboard.type('keyboard_member');
  await reach(page, page.getByRole('textbox', {name: 'Invitation code', exact: true}));
  await page.keyboard.type('synthetic-invitation-only');
  await reach(page, page.getByLabel('Password', {exact: true}));
  await page.keyboard.type('Synthetic local phrase 42!');
  for (const checkbox of await page.getByRole('checkbox').all()) { await reach(page, checkbox); await page.keyboard.press('Space'); }
  await activate(page, page.getByRole('button', {name: 'Create my account'}));
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('textbox', {name: 'Your handle', exact: true}).inputValue(), 'keyboard_member');
  await activate(page, page.getByRole('button', {name: 'Create my account'}));
  await focused(page.getByRole('heading', {name: 'Check your email.', exact: true}));
  assert.equal(signups, 2); assert.deepEqual(unexpected, []);
  await context.close();

  // Actual client vault/cryptography with locally generated keys and API fixtures.
  // This seeds only the synthetic remembered-device state, not an onboarding claim.
  const memberId = crypto.randomUUID(), deviceId = crypto.randomUUID();
  const keys = await generateDeviceKeys(memberId, deviceId);
  const key = await unlockPrivateKey(keys.encryptedPrivateKey, keys.recoverySecret);
  const device = {id: deviceId, member_id: memberId, public_key: keys.publicKey, fingerprint: keys.fingerprint};
  const profile = await encryptObject({context: {id: memberId, kind: 'profile', authorId: memberId, authorDeviceId: deviceId, audience: 'connections', parentId: null, groupId: null, epoch: 1, createdAt: new Date().toISOString(), expiresAt: null, revision: 1}, payload: {displayName: 'Keyboard member', theme: 'sage', wallpaper: 'none'}, signingKey: key, recipients: [{memberId, deviceId, publicKey: keys.publicKey}]});
  const incomingId = crypto.randomUUID(), outgoingId = crypto.randomUUID(), delayedId = crypto.randomUUID();
  const friendId = crypto.randomUUID(), outgoingMemberId = crypto.randomUUID(), delayedMemberId = crypto.randomUUID();
  let releaseConnection = () => {}, connectionStarted = () => {};
  const connectionGate = new Promise<void>(resolve => { releaseConnection = resolve; });
  let requests = [{id: incomingId, sender: friendId, recipient: memberId, kind: 'friend'}, {id: outgoingId, sender: memberId, recipient: outgoingMemberId, kind: 'friend'}, {id: delayedId, sender: delayedMemberId, recipient: memberId, kind: 'friend'}];
  let posts: any[] = [], reports: any[] = [], deletions = 0, session = true;
  let deferMember = false, releaseMember = () => {}, memberStarted = () => {};
  let memberGate = Promise.resolve();
  const invitationRequests: {email: string}[] = [];
  const builder = {paused: false, online: true, activity: 'request_file', disclosure: {version: 1, accepted: false}, ahead: 0, sent_today: 0, limits: {message_length: 2000, daily_messages: 100}, messages: [] as any[]};
  let builderPolls = 0;
  let invitationStarted!: () => void, releaseInvitation!: () => void;
  const invitationGate = new Promise<void>(resolve => { releaseInvitation = resolve; });
  const invitationPending = new Promise<void>(resolve => { invitationStarted = resolve; });
  const mutations: string[] = [];
  const memberContext = await browser.newContext({serviceWorkers: 'block'});
  const memberPage = await memberContext.newPage();
  await memberPage.route('**/*', async route => {
    const url = new URL(route.request().url()), method = route.request().method(), path = url.pathname.replace('/api/v1', '');
    if (url.origin !== target.origin) { unexpected.push('EXTERNAL_REQUEST'); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const reply = (json: unknown, status = 200) => route.fulfill({status, json});
    if (method !== 'GET') mutations.push(method + ' ' + path);
    if (path === '/api/auth/sign-in/email') return reply({ok: true});
    if (path === '/me' && deferMember) { deferMember = false; memberStarted(); await memberGate; }
    if (path === '/me') return session ? reply({id: memberId, handle: 'keyboard_member', status: 'active', envelope: profile}) : reply({error: {code: 'AUTH_REQUIRED'}}, 401);
    if (path === '/devices') return reply({items: [device]});
    if (path === `/devices/${deviceId}`) return reply(device);
    if (path === '/audiences') return reply({epoch: 1, devices: [device]});
    if (path === `/profiles/member/${memberId}`) return reply({id: memberId, member_id: memberId, handle: 'keyboard_member', envelope: profile});
    if (path.startsWith('/profiles/member/') && method === 'GET') return reply({}); // Other members have no readable profile photo.
    if (path === '/platform-invitations' && method === 'GET') return reply({items: [], next_cursor: null});
    if (path === '/connections') return reply({items: [], requests, handles: [{id: friendId, handle: 'incoming_friend'}, {id: outgoingMemberId, handle: 'outgoing_friend'}, {id: delayedMemberId, handle: 'delayed_friend'}]});
    if (path === '/platform-invitations' && method === 'POST') {
      invitationRequests.push(route.request().postDataJSON());
      if (invitationRequests.length === 1) { invitationStarted(); await invitationGate; return reply({accepted: true}, 202); }
      if (invitationRequests.length === 2) return reply({error:{code:'INVITATION_LIMIT'}},429);
      return reply({}); // A malformed success response cannot acknowledge an invitation.
    }
    if (path === `/connections/requests/${delayedId}/accept` && method === 'POST') { connectionStarted(); await connectionGate; requests = requests.filter(r => r.id !== delayedId); return reply({ok: true}); }
    if (path === `/connections/requests/${incomingId}/accept` && method === 'POST') { requests = requests.filter(r => r.id !== incomingId); return reply({ok: true}); }
    if (path === `/connections/requests/${outgoingId}/decline` && method === 'POST') { requests = requests.filter(r => r.id !== outgoingId); return reply({ok: true}); }
    if (path === '/feed') return reply({items: posts, next_cursor: null});
    if (path === '/posts' && method === 'POST') {
      const {envelope} = route.request().postDataJSON() as {envelope: EncryptedEnvelope};
      posts = [{id: envelope.context.id, author_id: memberId, author_handle: 'keyboard_member', author_device_id: deviceId, envelope, audience: envelope.context.audience, created_at: envelope.context.createdAt, expires_at: envelope.context.expiresAt}];
      return reply({id: envelope.context.id});
    }
    if (posts[0] && path === `/posts/${posts[0].id}`) return reply({post: posts[0], comments: [], reactions: []});
    if (path === '/reports' && method === 'POST') { reports.push(route.request().postDataJSON()); return reply({ok: true}); }
    if (path === '/account' && method === 'DELETE') {
      assert.equal(route.request().postDataJSON().confirm, 'DELETE');
      deletions++;
      if (deletions === 1) return reply({error: {code: 'RECENT_AUTH_REQUIRED'}}, 409);
      session = false; return reply({ok: true});
    }
    if (path === '/api/auth/sign-out') { session = false; return reply({ok: true}); }
    if (path === '/builder-chat') {
      // The first poll after sending still shows the queued message; the next one carries the reply.
      const pending = builder.messages.find(m => m.status === 'queued');
      if (pending && builderPolls++ > 0) Object.assign(pending, {status: 'answered', reply: 'Synthetic reply from Codex.', completed_at: new Date().toISOString()});
      return reply(builder);
    }
    if (path === '/builder-chat/disclosure' && method === 'POST') { assert.equal(route.request().postDataJSON().version, 1); builder.disclosure.accepted = true; return reply({ok: true}); }
    if (path === '/builder-chat/messages' && method === 'POST') {
      builder.messages.push({id: crypto.randomUUID(), body: route.request().postDataJSON().message, status: 'queued', progress: null, reply: '', commits: [], created_at: new Date().toISOString(), completed_at: null});
      builder.sent_today++; return reply({ok: true});
    }
    if (path === '/integrations') return reply({clients: [], grants: [{id: 'synthetic-grant', name: 'Photo archive', purpose: 'Save a local copy of my own photos', scopes: ['media:read', 'export:read'], last_used_at: '2026-10-25T12:00:00.000Z'}]});
    if (['/notifications', '/mutes', '/owned-groups', '/push/subscriptions', '/posts/audience-refresh'].includes(path)) return reply({items: []});
    unexpected.push('UNEXPECTED_MEMBER_API:' + method + ' ' + path);
    return reply({error: {code: 'UNEXPECTED_TEST_API'}}, 400);
  });
  await memberPage.goto(target.origin);
  await memberPage.evaluate(async data => {
    const cryptoPath = data.cryptoPath, browserPath = data.browserPath;
    const {unlockPrivateKey} = await import(/* @vite-ignore */ cryptoPath);
    const {rememberDevice} = await import(/* @vite-ignore */ browserPath);
    const unlocked = await unlockPrivateKey(data.encryptedKey, data.secret);
    await rememberDevice(data.meta, unlocked);
    localStorage.setItem(`porchday-device:${data.meta.memberId}`, data.meta.deviceId);
  }, {cryptoPath: '/@fs/' + resolve('packages/crypto/src/index.ts'), browserPath: '/@fs/' + resolve('packages/crypto/src/browser.ts'), encryptedKey: keys.encryptedPrivateKey, secret: keys.recoverySecret, meta: {memberId, deviceId, fingerprint: keys.fingerprint}});
  async function delayedLogin(cancelFocus: boolean) {
    await memberPage.goto(target.origin);
    await activate(memberPage, memberPage.getByRole('navigation', {name: 'Main navigation'}).getByRole('link', {name: 'Log in'}));
    await focused(memberPage.getByRole('heading', {name: 'Log in', exact: true}));
    await memberPage.getByRole('textbox', {name: 'Email address', exact: true}).fill('keyboard@example.test');
    await memberPage.getByLabel('Password', {exact: true}).fill('Synthetic local phrase 42!');
    memberGate = new Promise<void>(resolve => { releaseMember = resolve; });
    const started = new Promise<void>(resolve => { memberStarted = resolve; });
    deferMember = true;
    await activate(memberPage, memberPage.getByRole('button', {name: 'Log in', exact: true}));
    await started;
    await memberPage.getByRole('status').waitFor();
    // Flush the route's scheduled setup, then either let it wait or begin navigating.
    await memberPage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    if (cancelFocus) await reach(memberPage, memberPage.getByRole('link', {name: 'Skip to content'}));
    releaseMember();
    await memberPage.getByRole('textbox', {name: 'Write a post'}).waitFor();
    if (cancelFocus) await focused(memberPage.getByRole('link', {name: 'Skip to content'}));
    else await focused(memberPage.locator('#main-content h1'));
  }
  await delayedLogin(false);
  await delayedLogin(true);
  await memberPage.goto(target.origin + '/app/connections');
  await memberPage.getByRole('button', {name: 'Accept connection request from @incoming_friend', exact: true}).waitFor();
  await activate(memberPage, memberPage.getByRole('button', {name: 'Accept connection request from @incoming_friend', exact: true}));
  await focused(memberPage.getByRole('heading', {name: 'Your connections', exact: true}));
  await memberPage.getByRole('status').filter({hasText: 'Connected with @incoming_friend.'}).waitFor();
  const connectionPending = new Promise<void>(resolve => { connectionStarted = resolve; });
  await activate(memberPage, memberPage.getByRole('button', {name: 'Accept connection request from @delayed_friend', exact: true}));
  await connectionPending;
  const searchField = memberPage.getByRole('textbox', {name: 'Their exact handle', exact: true});
  await reach(memberPage, searchField);
  await memberPage.keyboard.type('draft_handle');
  releaseConnection();
  await memberPage.getByRole('status').filter({hasText: 'Connected with @delayed_friend.'}).waitFor();
  await focused(searchField);
  assert.equal(await searchField.inputValue(), 'draft_handle');
  await activate(memberPage, memberPage.getByRole('button', {name: 'Cancel connection request to @outgoing_friend', exact: true}));
  await focused(memberPage.getByRole('heading', {name: 'Your connections', exact: true}));
  await memberPage.getByRole('status').filter({hasText: 'Canceled the request to @outgoing_friend.'}).waitFor();
  const invitationEmail = memberPage.getByRole('textbox', {name: 'Their email address', exact: true});
  const invitationButton = memberPage.getByRole('button', {name: 'Send invitation', exact: true});
  await reach(memberPage, invitationEmail);
  await memberPage.keyboard.type('invitee@example.test');
  await activate(memberPage, invitationButton);
  await invitationPending;
  assert.equal(await invitationEmail.isDisabled(), true);
  await invitationEmail.evaluate(element => (element.closest('form') as HTMLFormElement).requestSubmit());
  await memberPage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  assert.equal(invitationRequests.length, 1);
  releaseInvitation();
  await memberPage.getByRole('status').filter({hasText:'Invitation requested.'}).waitFor();
  assert.equal(await invitationEmail.inputValue(), '');
  assert.deepEqual(invitationRequests[0], {email:'invitee@example.test'});
  await invitationEmail.fill('limited@example.test');
  await activate(memberPage, invitationButton);
  await memberPage.getByRole('alert').filter({hasText:'limit of 10 invitations'}).waitFor();
  assert.equal(await invitationEmail.inputValue(), 'limited@example.test');
  await invitationEmail.fill('unconfirmed@example.test');
  await activate(memberPage, invitationButton);
  await memberPage.getByRole('alert').filter({hasText:'could not confirm the request'}).waitFor();
  assert.equal(await invitationEmail.inputValue(), 'unconfirmed@example.test');
  assert.equal(invitationRequests.length, 3);
  await activate(memberPage, memberPage.locator('.sidebar').getByRole('link', {name: 'Home', exact: true}));
  await focused(memberPage.locator('#main-content h1'));
  await reach(memberPage, memberPage.getByRole('textbox', {name: 'Write a post'}));
  await memberPage.keyboard.type('A synthetic keyboard post.');
  await reach(memberPage, memberPage.getByRole('combobox', {name: 'Post audience'}));
  assert.deepEqual(await memberPage.getByRole('combobox', {name: 'Post audience'}).locator('option').allTextContents(), ['Friends & family','Friends only','Family only','Only me']);
  await memberPage.getByRole('combobox', {name: 'Post audience'}).selectOption('friends');
  await memberPage.keyboard.press('Tab');
  assert.equal(await memberPage.getByRole('combobox', {name: 'Post audience'}).inputValue(), 'friends');
  await activate(memberPage, memberPage.getByRole('button', {name: 'Share', exact: true}));
  await memberPage.getByRole('status').filter({hasText: 'Post shared.'}).waitFor();
  await memberPage.getByText('A synthetic keyboard post.', {exact: true}).waitFor();
  const plaintext = await decryptObject<any>({envelope: posts[0].envelope, expectedContext: posts[0].envelope.context, privateKey: key, authorPublicKey: keys.publicKey});
  assert.equal(plaintext.text, 'A synthetic keyboard post.'); assert.equal(posts[0].audience, 'friends');
  const options = memberPage.getByRole('button', {name: 'Post options', exact: true});
  await activate(memberPage, options);
  await activate(memberPage, memberPage.getByRole('button', {name: 'Report a concern', exact: true}));
  await memberPage.getByRole('dialog', {name: 'Tell us what’s wrong'}).waitFor();
  await trapped(memberPage);
  await memberPage.keyboard.press('Escape');
  await focused(options);
  await memberPage.keyboard.press('Enter');
  await activate(memberPage, memberPage.getByRole('button', {name: 'Report a concern', exact: true}));
  await activate(memberPage, memberPage.getByRole('button', {name: 'Send report', exact: true}));
  await focused(memberPage.getByRole('button', {name: 'Done', exact: true}));
  assert.equal(reports.length, 1); assert.equal(reports[0].evidence_disclosed, false); assert.equal(reports[0].evidence_envelope, null);
  await memberPage.keyboard.press('Enter'); await focused(options);
  // Builder chat: the disclosure gates the form, and the reply is announced in the polite live region.
  await activate(memberPage, memberPage.locator('.sidebar').getByRole('link', {name: 'Builder chat', exact: true}));
  await focused(memberPage.locator('#main-content h1'));
  const builderContinue = memberPage.getByRole('button', {name: 'Continue', exact: true});
  await builderContinue.waitFor(); assert.equal(await builderContinue.isDisabled(), true);
  await reach(memberPage, memberPage.getByRole('checkbox', {name: 'I understand how builder chat works.', exact: true}));
  await memberPage.keyboard.press('Space');
  await activate(memberPage, builderContinue);
  const builderMessage = memberPage.getByRole('textbox', {name: 'Message to Codex', exact: true});
  await reach(memberPage, builderMessage);
  assert.match(await builderMessage.getAttribute('aria-describedby') || '', /builder-message-help/);
  await memberPage.keyboard.type('Synthetic builder chat question');
  await activate(memberPage, memberPage.getByRole('button', {name: 'Send to Codex', exact: true}));
  await memberPage.getByText('Codex is handling a request-file task. Your message is queued.', {exact: true}).waitFor();
  await memberPage.getByText(/Position 1 in the chat queue/).waitFor();
  await memberPage.locator('.builder-announcement').filter({hasText: 'Codex replied: Synthetic reply from Codex.'}).waitFor({state: 'attached', timeout: 10000});
  assert.equal(await memberPage.locator('.builder-announcement').getAttribute('aria-live'), 'polite');
  assert.equal(builder.messages[0].body, 'Synthetic builder chat question');
  await activate(memberPage, memberPage.locator('.sidebar').getByRole('link', {name: 'Settings', exact: true}));
  await activate(memberPage, memberPage.getByRole('link', {name: 'My data', exact: true}));
  await memberPage.getByText('Save a local copy of my own photos', {exact: true}).waitFor();
  assert.match(await memberPage.locator('.member-info').filter({hasText: 'Photo archive'}).innerText(), /media:read, export:read/);
  const deleteAccount = memberPage.getByRole('button', {name: 'Delete my account', exact: true});
  await activate(memberPage, deleteAccount);
  const permanentDelete = memberPage.getByRole('button', {name: 'Permanently delete my account', exact: true});
  await permanentDelete.waitFor(); assert.equal(await permanentDelete.isDisabled(), true);
  await trapped(memberPage);
  await memberPage.keyboard.press('Escape'); await focused(deleteAccount);
  await memberPage.keyboard.press('Enter');
  await reach(memberPage, memberPage.getByRole('textbox', {name: 'Type DELETE to confirm', exact: true}));
  await memberPage.keyboard.type('DELETE');
  await activate(memberPage, permanentDelete);
  await memberPage.getByRole('dialog').getByRole('alert').waitFor();
  assert.equal(await memberPage.getByRole('textbox', {name: 'Type DELETE to confirm', exact: true}).inputValue(), 'DELETE');
  assert.equal(await memberPage.evaluate(() => !!document.activeElement?.closest('dialog[open]')), true);
  await activate(memberPage, permanentDelete);
  await memberPage.waitForURL(target.origin + '/account-deletion');
  await focused(memberPage.locator('#main-content h1'));
  await memberPage.getByRole('heading', {name: 'Account deletion accepted', exact: true}).waitFor();
  assert.match(await memberPage.locator('#main-content').innerText(), /Completion has not been verified/);
  assert.match(await memberPage.locator('#main-content').innerText(), /within seven days/);
  await memberPage.reload();
  await memberPage.getByRole('heading', {name: 'No deletion confirmation', exact: true}).waitFor();
  assert.equal(deletions, 2); assert.deepEqual(unexpected, []);
  assert.equal(mutations.length, 15);
  await memberContext.close();
  console.log(JSON.stringify({local_accessibility: 'passed', synthetic_api_only: true, keyboard_signup_errors_and_success: true, described_help: true, targeted_connections: true, pending_connection_preserves_typing_focus: true, invitation_pending_duplicate_guard: true, invitation_accepted_limit_and_unknown_responses: true, encrypted_friends_only_keyboard_post: true, reporting_focus_and_consent: true, guarded_deletion: true, route_and_skip_focus: true, delayed_navigation_focus_and_cancellation: true, builder_chat_disclosure_and_announced_reply: true, real_screen_reader_test: false}));
} finally {
  await browser.close();
}
