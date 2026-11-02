#!/bin/bash
# Trusted manual CI only. Produces a signed native Mac package; never uploads.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
: "${APPLE_MAC_APP_P12:?Missing application certificate}"
: "${APPLE_MAC_INSTALLER_P12:?Missing installer certificate}"
: "${APPLE_MAC_PASSWORD:?Missing certificate password}"
: "${APPLE_MAC_PROFILE:?Missing native profile}"
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
for env,name in [('APPLE_MAC_APP_P12','app.p12'),('APPLE_MAC_INSTALLER_P12','installer.p12'),('APPLE_MAC_PROFILE','profile.provisionprofile')]:
 (p/name).write_bytes(base64.b64decode(os.environ[env],validate=True))
(p/'password').write_text(secrets.token_hex(32))
PY
password="$(cat "$private/password")"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
for identity in app installer; do
 security import "$private/$identity.p12" -P "$APPLE_MAC_PASSWORD" -k "$keychain" -T /usr/bin/codesign -T /usr/bin/productbuild -T /usr/bin/security >/dev/null
done
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
# Pin actual identities rather than relying on Xcode's certificate-name aliases.
for identity in app installer; do
 openssl pkcs12 -in "$private/$identity.p12" -passin env:APPLE_MAC_PASSWORD -clcerts -nokeys 2>/dev/null | \
  openssl x509 -noout -fingerprint -sha1 | cut -d= -f2 | tr -d ':\r\n' > "$private/$identity-sha1"
done
security cms -D -i "$private/profile.provisionprofile" > "$private/profile.plist"
python3 - <<'PY'
import os,pathlib,plistlib,datetime,re
p=pathlib.Path(os.environ['PORCHDAY_SIGNING_DIR']);profile=plistlib.loads((p/'profile.plist').read_bytes());team=profile['TeamIdentifier'][0]
assert profile['Platform']==['OSX']
assert profile['Entitlements']['com.apple.application-identifier']==team+'.org.porchday.app'
assert not profile['Entitlements'].get('get-task-allow',False)
assert not profile['Entitlements'].get('com.apple.security.get-task-allow',False)
assert profile['ExpirationDate']>datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
(p/'team').write_text(team);(p/'uuid').write_text(profile['UUID'])
app_cert=(p/'app-sha1').read_text();installer_cert=(p/'installer-sha1').read_text()
assert re.fullmatch(r'[0-9A-F]{40}',app_cert) and re.fullmatch(r'[0-9A-F]{40}',installer_cert)
(p/'export.plist').write_bytes(plistlib.dumps({'method':'app-store-connect','destination':'export','teamID':team,'signingStyle':'manual','signingCertificate':app_cert,'installerSigningCertificate':installer_cert,'provisioningProfiles':{'org.porchday.app':profile['UUID']},'manageAppVersionAndBuildNumber':False,'uploadSymbols':True}))
PY
team="$(cat "$private/team")"; uuid="$(cat "$private/uuid")"
profiles="$HOME/Library/MobileDevice/Provisioning Profiles"
mkdir -p "$profiles"
cp "$private/profile.provisionprofile" "$profiles/$uuid.provisionprofile"
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
xcodebuild -project apps/ios/Porchday.xcodeproj -scheme PorchdayMac -configuration Release \
 -destination 'generic/platform=macOS' -archivePath apps/ios/build/PorchdayMac.xcarchive \
 archive CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY='3rd Party Mac Developer Application' \
 DEVELOPMENT_TEAM="$team" PORCHDAY_MAC_PROFILE="$uuid" \
 OTHER_CODE_SIGN_FLAGS="--keychain $keychain" CURRENT_PROJECT_VERSION="$PORCHDAY_BUILD_NUMBER" PORCHDAY_PUSH_ENABLED=NO
xcodebuild -exportArchive -archivePath apps/ios/build/PorchdayMac.xcarchive \
 -exportPath apps/ios/build/MacTestFlight -exportOptionsPlist "$private/export.plist"
python3 - <<'PY'
import pathlib,hashlib,json,subprocess,plistlib
p=pathlib.Path('apps/ios/build/MacTestFlight');pkg=list(p.glob('*.pkg'));assert len(pkg)==1
app=pathlib.Path('apps/ios/build/PorchdayMac.xcarchive/Products/Applications/Porchday.app')
info=plistlib.loads((app/'Contents/Info.plist').read_bytes());assert info['CFBundleIdentifier']=='org.porchday.app'
assert (app/'Contents/Resources/PrivacyInfo.xcprivacy').is_file()
subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
entitlements=plistlib.loads(subprocess.check_output(['codesign','-d','--entitlements',':-',str(app)],stderr=subprocess.DEVNULL))
assert entitlements.get('com.apple.security.app-sandbox') is True
assert not entitlements.get('com.apple.security.get-task-allow',False)
assert not any(k.startswith('com.apple.security.temporary-exception') for k in entitlements)
subprocess.run(['pkgutil','--check-signature',str(pkg[0])],check=True)
architectures=subprocess.check_output(['lipo','-archs',str(app/'Contents/MacOS/Porchday')],text=True).split();assert set(architectures)=={'arm64','x86_64'}
(p/'evidence.json').write_text(json.dumps({'source':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'bundleId':info['CFBundleIdentifier'],'version':info['CFBundleShortVersionString'],'build':info['CFBundleVersion'],'pkgSha256':hashlib.sha256(pkg[0].read_bytes()).hexdigest(),'architectures':architectures,'uploaded':False},indent=2))
PY
