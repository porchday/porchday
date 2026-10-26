#!/usr/bin/env python3
"""Provision dedicated Porchday staff Access apps. Never enroll users or grant DB roles.

Run through with-secrets.py. --check is read-only. --update-roster staging permits
one reviewed owner-only to owner-plus-reviewer change. --migrate-production-domain
adds the canonical .org staff paths while retaining the legacy .com paths.
--enable-launcher adds
the separate OTP enrollment entry point. Output contains public
resource IDs only; merge it into infra/resources.json separately after verification.
"""
import argparse
import copy
import json
import os
import re
import sys
import urllib.error
import urllib.request

HOSTS = {'staging': 'staging.porchday.com', 'production': 'porchday.org'}
LEGACY_PRODUCTION_HOST = 'porchday.com'
AUTHENTICATORS = ['security_key', 'biometrics']
MFA = {'allowed_authenticators': AUTHENTICATORS, 'session_duration': '1h', 'mfa_disabled': False}
POLICY_WRITABLE = {'name', 'decision', 'include', 'require', 'exclude', 'session_duration',
    'mfa_config', 'approval_groups', 'approval_required', 'connection_rules',
    'isolation_required', 'purpose_justification_prompt', 'purpose_justification_required'}
LAUNCHER_POLICY_NAME = 'Porchday staff launcher'
POLICY_READONLY = {'id', 'uid', 'account_id', 'app_count', 'created_at', 'updated_at', 'reusable'}


class AccessError(RuntimeError):
    pass


class Cloudflare:
    def __init__(self, account, token):
        if not re.fullmatch(r'[a-f0-9]{32}', account) or not token:
            raise AccessError('Missing valid Cloudflare account/token configuration.')
        self.base = 'https://api.cloudflare.com/client/v4/accounts/' + account
        self.token = token

    def __call__(self, path, method='GET', body=None):
        request = urllib.request.Request(self.base + path, method=method,
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'},
            data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
        except urllib.error.HTTPError as error:
            # Provider messages can contain the submitted owner email. Never print them.
            raise AccessError('Cloudflare ' + method + ' ' + path + ' returned HTTP ' + str(error.code)) from None
        except (urllib.error.URLError, TimeoutError):
            raise AccessError('Cloudflare request failed; re-run to inspect/reconcile existing resources.') from None
        if len(raw) > 2 * 1024 * 1024:
            raise AccessError('Cloudflare response exceeded the bounded response limit.')
        data = json.loads(raw)
        if data.get('success') is not True:
            raise AccessError('Cloudflare returned an unsuccessful response.')
        info = data.get('result_info', {})
        result = data.get('result')
        if isinstance(result, list) and (info.get('total_pages', 1) > 1 or info.get('total_count', len(result)) > len(result)):
            raise AccessError('Access inventory is paginated; manual review required before provisioning.')
        return result


def unique_named(items, name):
    matches = [item for item in items if item.get('name') == name]
    if len(matches) > 1:
        raise AccessError('Ambiguous duplicate Porchday resource names; manual review required.')
    return matches[0] if matches else None


def mfa_matches(value):
    return isinstance(value, dict) and value.get('mfa_disabled') is False and \
        value.get('session_duration') == '1h' and sorted(value.get('allowed_authenticators', [])) == sorted(AUTHENTICATORS)


def private_email(value, label):
    email = value.strip().lower()
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email) or len(email) > 254:
        raise AccessError('A valid private ' + label + ' email must be configured.')
    return email


def reviewer_roster(owner_email, reviewers):
    email = private_email(owner_email, 'owner (cloudflare_username)')
    reviewers = reviewers or {}
    if set(reviewers) - set(HOSTS):
        raise AccessError('Unknown staff roster environment.')
    roster = {}
    for env in HOSTS:
        reviewer = reviewers.get(env, '')
        if reviewer:
            reviewer = private_email(reviewer, env + ' recovery reviewer')
            if reviewer == email:
                raise AccessError('Recovery reviewer must have a distinct configured email.')
        roster[env] = reviewer
    return email, roster


def policy_body(environment, email, idp_id, reviewer=''):
    return {'name': 'Porchday staff owner ' + environment, 'decision': 'allow',
        'include': [{'email': {'email': value}} for value in [email, reviewer] if value],
        'require': [{'login_method': {'id': idp_id}}],
        'exclude': [], 'session_duration': '1h', 'mfa_config': copy.deepcopy(MFA)}


def verify_policy_id_alias(policy):
    # Cloudflare GET currently includes uid as a read-only alias of id. Keep it
    # in snapshots, but never send it to PUT or accept a conflicting identity.
    if 'uid' in policy and (not isinstance(policy['uid'], str) or not policy['uid'] or policy['uid'] != policy.get('id')):
        raise AccessError('Staff policy identity alias differs from its ID; manual review required.')


def verify_policy(actual, desired):
    verify_policy_id_alias(actual)
    for key in ['name', 'decision', 'include', 'require', 'exclude', 'session_duration']:
        if actual.get(key, [] if key in ['require', 'exclude'] else None) != desired[key]:
            raise AccessError('Staff policy differs from the exact owner/reviewer/OTP allow policy; manual review required.')
    if not mfa_matches(actual.get('mfa_config')):
        raise AccessError('Staff policy independent MFA is missing or differs from the required settings.')


def staff_hosts(environment, legacy_production=False):
    if environment not in HOSTS:
        raise AccessError('Unknown staff application environment.')
    if environment == 'production':
        return [LEGACY_PRODUCTION_HOST] if legacy_production else [HOSTS[environment], LEGACY_PRODUCTION_HOST]
    return [HOSTS[environment]]


def app_body(environment, idp_id, policy_id, legacy_production=False):
    hosts = staff_hosts(environment, legacy_production)
    host = hosts[0]
    return {'name': 'Porchday staff ' + environment, 'type': 'self_hosted', 'domain': host + '/staff',
        'destinations': [{'type': 'public', 'uri': hostname + path} for hostname in hosts for path in ['/staff', '/api/staff']],
        'allowed_idps': [idp_id], 'policies': [{'id': policy_id, 'precedence': 1}],
        'session_duration': '1h', 'mfa_config': copy.deepcopy(MFA),
        'app_launcher_visible': True, 'auto_redirect_to_identity': False,
        'allow_authenticate_via_warp': False, 'allow_iframe': False,
        'enable_binding_cookie': True, 'http_only_cookie_attribute': True,
        'same_site_cookie_attribute': 'lax', 'path_cookie_attribute': False,
        'options_preflight_bypass': False, 'skip_interstitial': False}


def verify_app(actual, desired):
    if 'uid' in actual and actual['uid'] != actual.get('id'):
        raise AccessError('Staff application identity alias differs from its ID; manual review required.')
    for key in ['name', 'type', 'domain', 'allowed_idps', 'session_duration',
                'allow_authenticate_via_warp', 'enable_binding_cookie', 'http_only_cookie_attribute',
                'same_site_cookie_attribute', 'path_cookie_attribute', 'options_preflight_bypass',
                'allow_iframe', 'skip_interstitial']:
        # These optional false defaults are omitted by Cloudflare GET responses.
        default = False if key in ['path_cookie_attribute', 'allow_iframe', 'skip_interstitial'] else None
        if actual.get(key, default) != desired[key]:
            raise AccessError('Staff application setting differs from required configuration: ' + key)
    destinations = actual.get('destinations', [])
    if len(destinations) != len(desired['destinations']) or any(d.get('type') != 'public' or d.get('overrides') for d in destinations) or \
            sorted(d.get('uri', '') for d in destinations) != sorted(d['uri'] for d in desired['destinations']):
        raise AccessError('Staff application paths or bypass overrides differ from required protection.')
    if 'self_hosted_domains' in actual:
        aliases = actual['self_hosted_domains']
        if not isinstance(aliases, list) or not all(isinstance(value, str) for value in aliases) or \
                sorted(aliases) != sorted(d['uri'] for d in destinations):
            raise AccessError('Staff application legacy domain representation differs from its destinations.')
    policy_ids = [p if isinstance(p, str) else p.get('id') for p in actual.get('policies', [])]
    if policy_ids != [desired['policies'][0]['id']] or not mfa_matches(actual.get('mfa_config')):
        raise AccessError('Staff application policy/MFA mismatch; manual review required.')
    if not re.fullmatch(r'[a-f0-9]{64}', actual.get('aud', '')):
        raise AccessError('Staff application audience is missing or invalid.')


def launcher_policy_body(email, idp_id, roster):
    # The Launcher is Cloudflare's MFA-enrollment bootstrap, explicitly exempt
    # from organization MFA. Its separate OTP policy grants no staff app access.
    members = list(dict.fromkeys(value for value in [email, roster['staging'], roster['production']] if value))
    return {'name': LAUNCHER_POLICY_NAME, 'decision': 'allow',
        'include': [{'email': {'email': value}} for value in members],
        'require': [{'login_method': {'id': idp_id}}], 'exclude': [], 'session_duration': '1h'}


def verify_launcher_policy(actual, desired):
    verify_policy_id_alias(actual)
    for key, value in desired.items():
        if actual.get(key, [] if key in ['require', 'exclude'] else None) != value:
            raise AccessError('Launcher policy differs from the exact approved OTP roster.')
    if actual.get('mfa_config') not in [None, {}, {'mfa_disabled': True}]:
        raise AccessError('Launcher bootstrap policy has unexpected independent MFA settings.')
    if actual.get('app_count', 1) not in [0, 1]:
        raise AccessError('Launcher policy is shared with another application.')


def launcher_body(idp_id, policy_id):
    # The documented app_launcher create shape omits name/domain: Cloudflare
    # assigns the organization's Launcher. Link the closed policy at creation.
    return {'type': 'app_launcher', 'allowed_idps': [idp_id],
        'policies': [{'id': policy_id, 'precedence': 1}], 'session_duration': '1h',
        'auto_redirect_to_identity': False, 'skip_app_launcher_login_page': False}


def verify_launcher(actual, desired, domain):
    for key in ['type', 'allowed_idps', 'session_duration', 'auto_redirect_to_identity', 'skip_app_launcher_login_page']:
        default = False if key in ['auto_redirect_to_identity', 'skip_app_launcher_login_page'] else None
        if actual.get(key, default) != desired[key]:
            raise AccessError('Launcher application differs from the approved configuration: ' + key)
    if actual.get('domain') not in [None, '', domain]:
        raise AccessError('Launcher domain differs from this Access organization.')
    links = actual.get('policies', [])
    if len(links) != 1 or not isinstance(links[0], dict) or links[0].get('id') != desired['policies'][0]['id'] or links[0].get('precedence', 1) != 1:
        raise AccessError('Launcher must have exactly its dedicated allow policy.')
    if actual.get('destinations') or actual.get('mfa_config') not in [None, {}, {'mfa_disabled': True}]:
        raise AccessError('Launcher has unexpected destinations or independent MFA settings.')
    if not re.fullmatch(r'[a-f0-9]{64}', actual.get('aud', '')):
        raise AccessError('Launcher audience is missing or invalid.')


def provision(api, owner_email, team='porchday-staff', check=False, reviewers=None, legacy_production=False):
    email, roster = reviewer_roster(owner_email, reviewers)
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', team) or len(team) > 63:
        raise AccessError('Invalid Access team name.')
    organization = api('/access/organizations')
    apps = api('/access/apps')
    users = api('/access/users')
    idps = api('/access/identity_providers')
    policies = api('/access/policies')
    # This tool manages a dedicated account setup, not unrelated existing apps.
    expected_names = {'Porchday staff ' + env for env in HOSTS}
    launchers = [app for app in apps if app.get('type') == 'app_launcher']
    if len(launchers) > 1:
        raise AccessError('Multiple Launcher applications exist; manual review required.')
    if any(app.get('name') not in expected_names and app.get('type') != 'app_launcher' for app in apps):
        raise AccessError('Unrelated Access applications exist; refuse global changes without manual review.')
    for name in expected_names:
        unique_named(apps, name)
    otp = [idp for idp in idps if idp.get('type') == 'onetimepin']
    if len(otp) > 1:
        raise AccessError('Multiple OTP identity providers exist; manual review required.')
    # Validate every existing policy/application before the first possible write,
    # including production when a staging change is requested. No drift repair.
    if not otp and (apps or policies):
        raise AccessError('Existing staff resources have no unambiguous OTP provider.')
    if otp and api('/access/identity_providers/' + otp[0]['id']).get('type') != 'onetimepin':
        raise AccessError('Staff OTP provider verification failed.')
    for env in HOSTS:
        policy = unique_named(policies, 'Porchday staff owner ' + env)
        app = unique_named(apps, 'Porchday staff ' + env)
        if not policy and roster[env]:
            raise AccessError('Reviewer configuration requires an existing reviewed policy; provision owner-only first.')
        if policy:
            policy = api('/access/policies/' + policy['id'])
            verify_policy(policy, policy_body(env, email, otp[0]['id'], roster[env]))
        if app:
            if not policy:
                raise AccessError('Existing staff application has no expected policy.')
            verify_app(api('/access/apps/' + app['id']), app_body(env, otp[0]['id'], policy['id'], legacy_production))
    domain = team + '.cloudflareaccess.com'
    launcher_policy = unique_named(policies, LAUNCHER_POLICY_NAME)
    if launcher_policy:
        if not otp:
            raise AccessError('Launcher has no verified OTP identity provider.')
        verify_launcher_policy(api('/access/policies/' + launcher_policy['id']), launcher_policy_body(email, otp[0]['id'], roster))
    if launchers:
        if not launcher_policy:
            raise AccessError('Launcher has no expected dedicated policy.')
        verify_launcher(api('/access/apps/' + launchers[0]['id']), launcher_body(otp[0]['id'], launcher_policy['id']), domain)
    if organization.get('auth_domain') != domain and (apps or users):
        raise AccessError('Refusing to rename an Access team with existing applications or users.')
    current_org = copy.deepcopy(organization)
    # Fresh organizations GET a disabled placeholder which PUT rejects (12062):
    # its threshold/action are null. Omit only this exact unset value; preserve
    # any configured token-inactivity controls and all other organization fields.
    if current_org.get('service_token_inactivity') == {'enabled': False, 'inactivity_threshold_days': None, 'action': None}:
        del current_org['service_token_inactivity']
    # Cloudflare omits false AMR matching from its GET representation. The feature
    # is opt-in; normalize only that documented default when comparing settings.
    if isinstance(current_org.get('mfa_config'), dict):
        current_org['mfa_config'].setdefault('amr_matching_enabled', False)
    desired_org = copy.deepcopy(current_org)  # Preserve the existing writable configuration.
    desired_org.update(name='Porchday', auth_domain=domain, mfa_required_for_all_apps=True)
    desired_org['mfa_config'] = {**(organization.get('mfa_config') or {}),
        'allowed_authenticators': AUTHENTICATORS, 'session_duration': '1h', 'amr_matching_enabled': False}
    if current_org != desired_org:
        if check or apps or policies or users:
            raise AccessError('Organization/team/independent MFA configuration is not ready.')
        api('/access/organizations', 'PUT', desired_org)
    verified_org = api('/access/organizations')
    if verified_org.get('auth_domain') != domain or verified_org.get('name') != 'Porchday' or \
            verified_org.get('mfa_required_for_all_apps') is not True or \
            verified_org.get('mfa_config', {}).get('amr_matching_enabled', False) is not False or \
            sorted(verified_org.get('mfa_config', {}).get('allowed_authenticators', [])) != sorted(AUTHENTICATORS) or \
            verified_org.get('mfa_config', {}).get('session_duration') != '1h':
        raise AccessError('Organization independent MFA verification failed.')
    if not otp:
        if check:
            raise AccessError('Staff email OTP provider is not ready.')
        otp = [api('/access/identity_providers', 'POST', {'name': 'Porchday staff email', 'type': 'onetimepin', 'config': {}})]
    idp_id = otp[0]['id']
    if api('/access/identity_providers/' + idp_id).get('type') != 'onetimepin':
        raise AccessError('Staff OTP provider verification failed.')
    output = {'staff_access_issuer': 'https://' + domain, 'staff_access_identity_provider_id': idp_id, 'environments': {}}
    for env in HOSTS:
        desired_policy = policy_body(env, email, idp_id, roster[env])
        policy = unique_named(policies, desired_policy['name'])
        if not policy:
            if check:
                raise AccessError('Staff allow policy is not ready for ' + env)
            policy = api('/access/policies', 'POST', desired_policy)
        policy = api('/access/policies/' + policy['id'])
        verify_policy(policy, desired_policy)
        desired_app = app_body(env, idp_id, policy['id'], legacy_production)
        app = unique_named(apps, desired_app['name'])
        if not app:
            if check:
                raise AccessError('Staff application is not ready for ' + env)
            # Policy and MFA are attached in the same creation request. No open app interval.
            app = api('/access/apps', 'POST', desired_app)
        app = api('/access/apps/' + app['id'])
        verify_app(app, desired_app)
        output['environments'][env] = {'staff_access_issuer': output['staff_access_issuer'],
            'staff_access_audience': app['aud'], 'staff_access_application_id': app['id'],
            'staff_access_policy_id': policy['id']}
    if len({v['staff_access_audience'] for v in output['environments'].values()}) != 2:
        raise AccessError('Environments must have distinct Access audiences.')
    if len({v['staff_access_policy_id'] for v in output['environments'].values()}) != 2:
        raise AccessError('Environments must have distinct staff policies.')
    if launchers:
        output['launcher'] = {'application_id': launchers[0]['id'], 'policy_id': launcher_policy['id']}
    return output


def policy_update_body(policy):
    verify_policy_id_alias(policy)
    if set(policy) - POLICY_WRITABLE - POLICY_READONLY:
        raise AccessError('Unrecognized policy settings; manual review required before roster update.')
    if policy.get('app_count', 1) != 1:
        raise AccessError('Staff policy is shared with another application; roster update refused.')
    return {key: copy.deepcopy(value) for key, value in policy.items() if key in POLICY_WRITABLE}


def ready_snapshot(api, email, team, reviewers, legacy_production=False):
    snapshot = {}
    def read(path, method='GET', body=None):
        if method != 'GET':
            raise AccessError('Roster preflight must remain read-only.')
        value = api(path)
        if path in snapshot and snapshot[path] != value:
            raise AccessError('Staff configuration changed during preflight; no update attempted.')
        snapshot[path] = copy.deepcopy(value)
        return value
    output = provision(read, email, team, check=True, reviewers=reviewers, legacy_production=legacy_production)
    return snapshot, output


def policy_snapshot_views(snapshot, policy_id, app_id):
    """Known representations of this exact policy, including application embeds."""
    views = [snapshot['/access/policies/' + policy_id]]
    views.extend(policy for policy in snapshot['/access/policies'] if policy.get('id') == policy_id)
    apps = [snapshot['/access/apps/' + app_id]]
    apps.extend(app for app in snapshot['/access/apps'] if app.get('id') == app_id)
    for app in apps:
        views.extend(policy for policy in app.get('policies', [])
            if isinstance(policy, dict) and policy.get('id') == policy_id)
    return views


def application_snapshot_views(snapshot, app_id):
    return [snapshot['/access/apps/' + app_id],
            *[app for app in snapshot['/access/apps'] if app.get('id') == app_id]]


def app_update_body(app):
    # Only settings whose round-trip behavior is reviewed may be rewritten.
    # Unknown provider fields require inspection rather than silent deletion.
    writable = set(app_body('production', 'idp', 'policy')) | {'tags', 'eager_redirect_cookie_setting'}
    # Cloudflare still returns self_hosted_domains as a deprecated alias. Its
    # API ignores that field when destinations is supplied; validate it on reads
    # and omit it from PUT. Preserve the observed eager-cookie preference.
    readonly = {'id', 'uid', 'aud', 'created_at', 'updated_at', 'self_hosted_domains'}
    if set(app) - writable - readonly:
        raise AccessError('Unrecognized application settings; manual review required before domain update.')
    body = {key: copy.deepcopy(value) for key, value in app.items() if key in writable}
    links = body.get('policies', [])
    if len(links) != 1 or not isinstance(links[0], dict) or links[0].get('precedence', 1) != 1:
        raise AccessError('Staff application must retain its exact policy link before domain update.')
    # App reads can embed read-only policy objects; send only the existing link.
    body['policies'] = [{'id': links[0]['id'], 'precedence': 1}]
    return body


def migrate_production_domain(api, owner_email, reviewers=None, team='porchday-staff'):
    email, roster = reviewer_roster(owner_email, reviewers)
    candidate = unique_named(api('/access/apps'), 'Porchday staff production')
    if not candidate:
        raise AccessError('An existing production staff application is required before domain migration.')
    candidate = api('/access/apps/' + candidate['id'])
    if candidate.get('domain') not in [LEGACY_PRODUCTION_HOST + '/staff', HOSTS['production'] + '/staff']:
        raise AccessError('Production staff application has an unreviewed primary domain.')
    legacy = candidate['domain'] == LEGACY_PRODUCTION_HOST + '/staff'
    before, output = ready_snapshot(api, email, team, roster, legacy_production=legacy)
    identity = output['environments']['production']
    app_id = identity['staff_access_application_id']
    path = '/access/apps/' + app_id
    if candidate != before[path]:
        raise AccessError('Staff configuration changed during preflight; no update attempted.')
    body = app_update_body(before[path])
    again, again_output = ready_snapshot(api, email, team, roster, legacy_production=legacy)
    if again != before or again_output != output:
        raise AccessError('Staff configuration changed before domain update; no update attempted.')
    if not legacy:
        return output
    desired = app_body('production', output['staff_access_identity_provider_id'], identity['staff_access_policy_id'])
    for key in ['domain', 'destinations']:
        body[key] = copy.deepcopy(desired[key])
    try:
        api(path, 'PUT', body)
        after, after_output = ready_snapshot(api, email, team, roster)
    except (AccessError, KeyError, ValueError, TypeError):
        raise AccessError('Domain write outcome requires manual review; verification did not complete. Do not retry automatically.') from None
    expected = copy.deepcopy(before)
    for app in application_snapshot_views(expected, app_id):
        for key in ['domain', 'destinations']:
            app[key] = copy.deepcopy(desired[key])
        if 'self_hosted_domains' in app:
            app['self_hosted_domains'] = [d['uri'] for d in desired['destinations']]
    for snapshot in [expected, after]:
        for app in application_snapshot_views(snapshot, app_id):
            app.pop('updated_at', None)
            # Order of these exact protected paths has no routing semantics.
            app['destinations'] = sorted(app['destinations'], key=lambda d: d['uri'])
            if 'self_hosted_domains' in app:
                app['self_hosted_domains'] = sorted(app['self_hosted_domains'])
    if after != expected or after_output != output:
        raise AccessError('Domain write outcome requires manual review; protected configuration changed. Do not retry automatically.')
    return after_output


def update_roster(api, owner_email, reviewers, environment, team='porchday-staff'):
    email, roster = reviewer_roster(owner_email, reviewers)
    if environment != 'staging' or not roster['staging'] or roster['production']:
        raise AccessError('Only staging expansion with one configured reviewer and owner-only production is supported.')
    policies = api('/access/policies')
    candidate = unique_named(policies, 'Porchday staff owner staging')
    if not candidate:
        raise AccessError('Existing staging owner policy is required before roster update.')
    candidate = api('/access/policies/' + candidate['id'])
    owner_include = [{'email': {'email': email}}]
    desired_include = owner_include + [{'email': {'email': roster['staging']}}]
    if candidate.get('include') not in [owner_include, desired_include]:
        raise AccessError('Staging roster is neither owner-only nor the exact configured roster; update refused.')
    current_roster = {'staging': roster['staging'] if candidate['include'] == desired_include else ''}
    before, output = ready_snapshot(api, email, team, current_roster)
    policy_id = output['environments']['staging']['staff_access_policy_id']
    policy_path = '/access/policies/' + policy_id
    if candidate != before[policy_path]:
        raise AccessError('Staff configuration changed during preflight; no update attempted.')
    body = policy_update_body(before[policy_path])
    # Re-read the full protected configuration immediately before the sole PUT.
    # Cloudflare does not document conditional policy writes: this detects observed
    # races, not a transaction with another administrator's simultaneous changes.
    again, again_output = ready_snapshot(api, email, team, current_roster)
    if again != before or again_output != output:
        raise AccessError('Staff configuration changed before update; no update attempted.')
    if body['include'] == desired_include:
        return output
    body['include'] = desired_include
    try:
        api(policy_path, 'PUT', body)
        after, after_output = ready_snapshot(api, email, team, roster)
    except (AccessError, KeyError, ValueError, TypeError):
        raise AccessError('Roster write outcome requires manual review; verification did not complete. Do not retry automatically.') from None
    expected = copy.deepcopy(before)
    app_id = output['environments']['staging']['staff_access_application_id']
    # Cloudflare app list/detail responses embed policy objects. They represent
    # the same single policy update, not separate application mutations. Change
    # only its include list and ignore only its server-updated timestamp; keep
    # every other field, policy, application and production value exact.
    for policy in policy_snapshot_views(expected, policy_id, app_id):
        if 'include' in policy:
            policy['include'] = desired_include
    for snapshot in [expected, after]:
        for policy in policy_snapshot_views(snapshot, policy_id, app_id):
            policy.pop('updated_at', None)
    if after != expected or after_output != output:
        raise AccessError('Roster write outcome requires manual review; configuration changed during verification. Do not retry automatically.')
    return after_output


def enable_launcher(api, owner_email, reviewers, team='porchday-staff'):
    email, roster = reviewer_roster(owner_email, reviewers)
    if not roster['staging'] or roster['production']:
        raise AccessError('Launcher setup requires the approved staging reviewer and owner-only production.')
    before, output = ready_snapshot(api, email, team, roster)
    again, again_output = ready_snapshot(api, email, team, roster)
    if again != before or again_output != output:
        raise AccessError('Staff configuration changed before Launcher setup; no update attempted.')
    if output.get('launcher'):
        return output
    idp = output['staff_access_identity_provider_id']
    policy = unique_named(before['/access/policies'], LAUNCHER_POLICY_NAME)
    try:
        if not policy:
            policy = api('/access/policies', 'POST', launcher_policy_body(email, idp, roster))
        verify_launcher_policy(api('/access/policies/' + policy['id']), launcher_policy_body(email, idp, roster))
        app = api('/access/apps', 'POST', launcher_body(idp, policy['id']))
        after, after_output = ready_snapshot(api, email, team, roster)
        if after_output.get('launcher') != {'application_id': app['id'], 'policy_id': policy['id']}:
            raise AccessError('Launcher identity verification failed.')
        # Only the new app and (when absent before) new policy may be added.
        # Keep organization, staff apps/policies, OTP and prior IDs byte-exact.
        expected = copy.deepcopy(before)
        normalized = copy.deepcopy(after)
        normalized.pop('/access/apps/' + app['id'], None)
        normalized['/access/apps'] = [item for item in normalized['/access/apps'] if item.get('id') != app['id']]
        if not unique_named(before['/access/policies'], LAUNCHER_POLICY_NAME):
            normalized.pop('/access/policies/' + policy['id'], None)
            normalized['/access/policies'] = [item for item in normalized['/access/policies'] if item.get('id') != policy['id']]
        else:
            # A previously unattached policy gains exactly one application.
            for snapshot in [expected, normalized]:
                for item in [snapshot['/access/policies/' + policy['id']], *snapshot['/access/policies']]:
                    if item.get('id') == policy['id']:
                        item.pop('app_count', None)
                        item.pop('updated_at', None)
        if normalized != expected or {k: v for k, v in after_output.items() if k != 'launcher'} != output:
            raise AccessError('Protected configuration changed during Launcher setup.')
        return after_output
    except (AccessError, KeyError, ValueError, TypeError):
        raise AccessError('Launcher write outcome requires manual review; verification did not complete. Do not retry automatically.') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='Read-only verification; do not create or change resources.')
    mode.add_argument('--update-roster', choices=['staging'], help='Explicitly add the one privately configured staging recovery reviewer.')
    mode.add_argument('--enable-launcher', action='store_true', help='Create the approved OTP-only MFA enrollment Launcher without changing staff access.')
    mode.add_argument('--migrate-production-domain', action='store_true', help='Add .org production staff paths while retaining .com and all existing security settings.')
    parser.add_argument('--team', default='porchday-staff', help='Access team name; existing populated teams cannot be renamed.')
    args = parser.parse_args()
    try:
        api = Cloudflare(os.environ.get('CLOUDFLARE_ACCOUNT_ID', ''), os.environ.get('CLOUDFLARE_API_TOKEN', ''))
        owner = os.environ.get('cloudflare_username', '')
        reviewers = {env: os.environ.get('STAFF_' + env.upper() + '_RECOVERY_REVIEWER_EMAIL', '') for env in HOSTS}
        result = migrate_production_domain(api, owner, reviewers, args.team) if args.migrate_production_domain else \
            enable_launcher(api, owner, reviewers, args.team) if args.enable_launcher else \
            update_roster(api, owner, reviewers, args.update_roster, args.team) if args.update_roster else \
            provision(api, owner, args.team, args.check, reviewers=reviewers)
        print(json.dumps(result, indent=2))
    except (AccessError, KeyError, ValueError, TypeError) as error:
        # AccessError contains only fixed messages/paths. Parsing/provider shape failures
        # must not leak provider response data or credentials through tracebacks.
        print(str(error) if isinstance(error, AccessError) else 'Unexpected provider response shape; provisioning stopped safely.', file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
