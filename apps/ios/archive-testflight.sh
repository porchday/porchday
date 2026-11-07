#!/bin/bash
# Run only on a trusted, manually dispatched CI revision after native tests.
set -euo pipefail
umask 077
sdk_version="$(xcrun --sdk iphoneos --show-sdk-version)"
[[ "${sdk_version%%.*}" -ge 26 ]] || { echo 'App Store upload requires iOS SDK 26 or newer.' >&2; exit 1; }
cd "$(dirname "$0")/../.."
: "${APPLE_DISTRIBUTION_P12:?Missing distribution certificate}"
: "${APPLE_DISTRIBUTION_PASSWORD:?Missing certificate password}"
: "${APPLE_IOS_PROFILE:?Missing provisioning profile}"
: "${PORCHDAY_BUILD_NUMBER:?Missing unique build number}"
[[ "$PORCHDAY_BUILD_NUMBER" =~ ^[0-9]+$ ]] || exit 1
private="$(mktemp -d)"
keychain="$private/signing.keychain-db"
cleanup() { security delete-keychain "$keychain" >/dev/null 2>&1 || true; rm -rf "$private"; }
trap cleanup EXIT
export PORCHDAY_SIGNING_DIR="$private"
python3 - <<'PY'
import base64,os,pathlib,secrets
p=pathlib.Path(os.environ['PORCHDAY_SIGNING_DIR'])
for env,name in [('APPLE_DISTRIBUTION_P12','distribution.p12'),('APPLE_IOS_PROFILE','profile.mobileprovision')]:
 (p/name).write_bytes(base64.b64decode(os.environ[env],validate=True))
(p/'keychain-password').write_text(secrets.token_hex(32))
PY
password="$(cat "$private/keychain-password")"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$private/distribution.p12" -P "$APPLE_DISTRIBUTION_PASSWORD" -k "$keychain" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
security cms -D -i "$private/profile.mobileprovision" > "$private/profile.plist"
python3 - <<'PY'
import os,plistlib,pathlib,datetime
p=pathlib.Path(os.environ['PORCHDAY_SIGNING_DIR']); profile=plistlib.loads((p/'profile.plist').read_bytes())
team=profile['TeamIdentifier'][0]
assert profile['Entitlements']['application-identifier']==team+'.org.porchday.app'
assert profile['Entitlements']['aps-environment']=='production'
assert not profile['Entitlements'].get('get-task-allow',False)
assert profile['ExpirationDate']>datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
(p/'team').write_text(team);(p/'uuid').write_text(profile['UUID'])
(p/'export.plist').write_bytes(plistlib.dumps({'method':'app-store-connect','destination':'export','teamID':team,'signingStyle':'manual','signingCertificate':'Apple Distribution','provisioningProfiles':{'org.porchday.app':profile['UUID']},'manageAppVersionAndBuildNumber':False,'uploadSymbols':True}))
PY
team="$(cat "$private/team")"
uuid="$(cat "$private/uuid")"
profiles="$HOME/Library/MobileDevice/Provisioning Profiles"
mkdir -p "$profiles"
cp "$private/profile.mobileprovision" "$profiles/$uuid.mobileprovision"
# This runner is ephemeral; keys remain confined to its temporary keychain.
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
xcodebuild -project apps/ios/Porchday.xcodeproj -scheme Porchday -configuration Release \
  -destination 'generic/platform=iOS' -archivePath apps/ios/build/Porchday.xcarchive \
  archive CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY='Apple Distribution' \
  DEVELOPMENT_TEAM="$team" PORCHDAY_PROFILE="$uuid" \
  OTHER_CODE_SIGN_FLAGS="--keychain $keychain" \
  CURRENT_PROJECT_VERSION="$PORCHDAY_BUILD_NUMBER" PORCHDAY_APNS_ENVIRONMENT=production PORCHDAY_PUSH_ENABLED=YES
xcodebuild -exportArchive -archivePath apps/ios/build/Porchday.xcarchive \
  -exportPath apps/ios/build/TestFlight -exportOptionsPlist "$private/export.plist"
python3 - <<'PY'
import pathlib,hashlib,json,subprocess,plistlib
p=pathlib.Path('apps/ios/build/TestFlight');ipa=list(p.glob('*.ipa'));assert len(ipa)==1
app=pathlib.Path('apps/ios/build/Porchday.xcarchive/Products/Applications/Porchday.app')
info=plistlib.loads((app/'Info.plist').read_bytes());assert info['CFBundleIdentifier']=='org.porchday.app'
assert (app/'PrivacyInfo.xcprivacy').is_file()
subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
(p/'evidence.json').write_text(json.dumps({'source':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'bundleId':info['CFBundleIdentifier'],'version':info['CFBundleShortVersionString'],'build':info['CFBundleVersion'],'ipaSha256':hashlib.sha256(ipa[0].read_bytes()).hexdigest(),'uploaded':False},indent=2))
PY
