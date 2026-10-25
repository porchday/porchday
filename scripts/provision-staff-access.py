#!/usr/bin/env python3
"""Provision dedicated Porchday staff Access apps. Never enroll users or grant DB roles.

Run through with-secrets.py. --check is read-only. Output contains public resource
IDs only; merge it into infra/resources.json separately after verification.
"""
import argparse
import copy
import json
import os
import re
import sys
import urllib.error
import urllib.request

HOSTS = {'staging': 'staging.porchday.com', 'production': 'porchday.com'}
AUTHENTICATORS = ['security_key', 'biometrics']
MFA = {'allowed_authenticators': AUTHENTICATORS, 'session_duration': '1h', 'mfa_disabled': False}


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


def policy_body(environment, email, idp_id):
    return {'name': 'Porchday staff owner ' + environment, 'decision': 'allow',
        'include': [{'email': {'email': email}}], 'require': [{'login_method': {'id': idp_id}}],
        'exclude': [], 'session_duration': '1h', 'mfa_config': copy.deepcopy(MFA)}


def verify_policy(actual, desired):
    for key in ['name', 'decision', 'include', 'require', 'exclude', 'session_duration']:
        if actual.get(key, [] if key in ['require', 'exclude'] else None) != desired[key]:
            raise AccessError('Staff policy differs from the exact owner/OTP allow policy; manual review required.')
    if not mfa_matches(actual.get('mfa_config')):
        raise AccessError('Staff policy independent MFA is missing or differs from the required settings.')


def app_body(environment, idp_id, policy_id):
    host = HOSTS[environment]
    return {'name': 'Porchday staff ' + environment, 'type': 'self_hosted', 'domain': host + '/staff',
        'destinations': [{'type': 'public', 'uri': host + path} for path in ['/staff', '/api/staff']],
        'allowed_idps': [idp_id], 'policies': [{'id': policy_id, 'precedence': 1}],
        'session_duration': '1h', 'mfa_config': copy.deepcopy(MFA),
        'app_launcher_visible': True, 'auto_redirect_to_identity': False,
        'allow_authenticate_via_warp': False, 'allow_iframe': False,
        'enable_binding_cookie': True, 'http_only_cookie_attribute': True,
        'same_site_cookie_attribute': 'lax', 'path_cookie_attribute': False,
        'options_preflight_bypass': False, 'skip_interstitial': False}


def verify_app(actual, desired):
    for key in ['name', 'type', 'domain', 'allowed_idps', 'session_duration',
                'allow_authenticate_via_warp', 'enable_binding_cookie', 'http_only_cookie_attribute',
                'same_site_cookie_attribute', 'path_cookie_attribute', 'options_preflight_bypass',
                'allow_iframe', 'skip_interstitial']:
        # These optional false defaults are omitted by Cloudflare GET responses.
        default = False if key in ['path_cookie_attribute', 'allow_iframe', 'skip_interstitial'] else None
        if actual.get(key, default) != desired[key]:
            raise AccessError('Staff application setting differs from required configuration: ' + key)
    destinations = actual.get('destinations', [])
    if len(destinations) != 2 or any(d.get('type') != 'public' or d.get('overrides') for d in destinations) or \
            sorted(d.get('uri', '') for d in destinations) != sorted(d['uri'] for d in desired['destinations']):
        raise AccessError('Staff application paths or bypass overrides differ from required protection.')
    policy_ids = [p if isinstance(p, str) else p.get('id') for p in actual.get('policies', [])]
    if policy_ids != [desired['policies'][0]['id']] or not mfa_matches(actual.get('mfa_config')):
        raise AccessError('Staff application policy/MFA mismatch; manual review required.')
    if not re.fullmatch(r'[a-f0-9]{64}', actual.get('aud', '')):
        raise AccessError('Staff application audience is missing or invalid.')


def provision(api, owner_email, team='porchday-staff', check=False):
    email = owner_email.strip().lower()
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email) or len(email) > 254:
        raise AccessError('A valid private owner email must be configured as cloudflare_username.')
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', team) or len(team) > 63:
        raise AccessError('Invalid Access team name.')
    organization = api('/access/organizations')
    apps = api('/access/apps')
    users = api('/access/users')
    idps = api('/access/identity_providers')
    policies = api('/access/policies')
    # This tool manages a dedicated account setup, not unrelated existing apps.
    expected_names = {'Porchday staff ' + env for env in HOSTS}
    if any(app.get('name') not in expected_names for app in apps):
        raise AccessError('Unrelated Access applications exist; refuse global changes without manual review.')
    for name in expected_names:
        unique_named(apps, name)
    domain = team + '.cloudflareaccess.com'
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
        if check:
            raise AccessError('Organization/team/independent MFA configuration is not ready.')
        api('/access/organizations', 'PUT', desired_org)
    verified_org = api('/access/organizations')
    if verified_org.get('auth_domain') != domain or verified_org.get('name') != 'Porchday' or \
            verified_org.get('mfa_required_for_all_apps') is not True or \
            verified_org.get('mfa_config', {}).get('amr_matching_enabled', False) is not False or \
            sorted(verified_org.get('mfa_config', {}).get('allowed_authenticators', [])) != sorted(AUTHENTICATORS) or \
            verified_org.get('mfa_config', {}).get('session_duration') != '1h':
        raise AccessError('Organization independent MFA verification failed.')
    otp = [idp for idp in idps if idp.get('type') == 'onetimepin']
    if len(otp) > 1:
        raise AccessError('Multiple OTP identity providers exist; manual review required.')
    if not otp:
        if check:
            raise AccessError('Staff email OTP provider is not ready.')
        otp = [api('/access/identity_providers', 'POST', {'name': 'Porchday staff email', 'type': 'onetimepin', 'config': {}})]
    idp_id = otp[0]['id']
    if api('/access/identity_providers/' + idp_id).get('type') != 'onetimepin':
        raise AccessError('Staff OTP provider verification failed.')
    output = {'staff_access_issuer': 'https://' + domain, 'staff_access_identity_provider_id': idp_id, 'environments': {}}
    for env in HOSTS:
        desired_policy = policy_body(env, email, idp_id)
        policy = unique_named(policies, desired_policy['name'])
        if not policy:
            if check:
                raise AccessError('Staff allow policy is not ready for ' + env)
            policy = api('/access/policies', 'POST', desired_policy)
        policy = api('/access/policies/' + policy['id'])
        verify_policy(policy, desired_policy)
        desired_app = app_body(env, idp_id, policy['id'])
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
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Read-only verification; do not create or change resources.')
    parser.add_argument('--team', default='porchday-staff', help='Access team name; existing populated teams cannot be renamed.')
    args = parser.parse_args()
    try:
        result = provision(Cloudflare(os.environ.get('CLOUDFLARE_ACCOUNT_ID', ''), os.environ.get('CLOUDFLARE_API_TOKEN', '')),
            os.environ.get('cloudflare_username', ''), args.team, args.check)
        print(json.dumps(result, indent=2))
    except (AccessError, KeyError, ValueError, TypeError) as error:
        # AccessError contains only fixed messages/paths. Parsing/provider shape failures
        # must not leak provider response data or credentials through tracebacks.
        print(str(error) if isinstance(error, AccessError) else 'Unexpected provider response shape; provisioning stopped safely.', file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
