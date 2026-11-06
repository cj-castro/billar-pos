# iOS: install on your own iPhone (owner, free Apple ID)

No paid Apple Developer account needed. `scripts/mobile/ios-resign-install.sh` builds the app on this Mac,
signs it with your free **Personal Team**, installs it on a USB-connected iPhone and launches it.
For partners in other cities use the unsigned `.ipa` + Sideloadly instead (`INSTALL_IOS_PARTNER_ES.md`,
built by `scripts/mobile/ios-build-unsigned-ipa.sh`).

## One-time setup
1. **Developer Mode** on the iPhone: Settings > Privacy & Security > Developer Mode > on, then reboot and confirm.
   (The switch only appears after the iPhone has been connected to a Mac with Xcode once.)
2. **Trust the Mac**: plug the iPhone in by cable, unlock it, tap **Trust** and enter the passcode.
3. **Xcode > Settings > Accounts > +** : sign in with your (free) Apple ID. A **Personal Team** appears.
4. Find the **Team ID** (10 characters, e.g. `ABCDE12345`): select the Apple ID in Accounts, the Personal Team row shows it
   in the Team ID column, or run `security find-identity -v -p codesigning` and read the `(ABCDE12345)` at the end of the
   "Apple Development: you@example.com (…)" line.
5. Check the device is seen: `xcrun devicectl list devices`.

## Install / weekly refresh
```bash
DEVELOPMENT_TEAM=ABCDE12345 scripts/mobile/ios-resign-install.sh            # first connected iPhone
DEVELOPMENT_TEAM=ABCDE12345 scripts/mobile/ios-resign-install.sh <UDID>     # a specific device
IOS_BUNDLE_ID=com.bola8.staff.dev DEVELOPMENT_TEAM=ABCDE12345 scripts/mobile/ios-resign-install.sh
```
It runs `expo prebuild --clean`, `pod install`, `xcodebuild` (Release, automatic signing, `-allowProvisioningUpdates`) and then
`devicectl device install app` + `process launch`. Build output goes to `mobile/build/ios` (git-ignored).

**Rerun it every week**: the free certificate and provisioning profile expire after 7 days, after which the app will not launch
until it is re-signed. Reinstalling over the top keeps the app's data.

First launch on the phone: Settings > General > VPN & Device Management > trust your Apple ID, then open **Bola 8 Staff**
and allow **Local Network**.

## Free-account limits
- 7-day signing, 3 devices, 3 apps per device, 10 new App IDs per 7 days per Apple ID.
- If Xcode reports the bundle identifier `com.bola8.staff` as unavailable, use `IOS_BUNDLE_ID=com.bola8.staff.dev` from then on,
  always (switching again spends another App ID and installs a second copy of the app).

## Troubleshooting
- *No signing certificate / no account*: sign in at Xcode > Settings > Accounts first; `-allowProvisioningUpdates` then creates the certificate.
- *"Untrusted Developer" on the phone*: trust your Apple ID under VPN & Device Management.
- *`devicectl` finds no iPhone*: unlock it, re-plug, trust the Mac, enable Developer Mode, or pass the UDID explicitly.
- *Launch fails right after install*: the phone was locked or the profile is not trusted yet; open the app by hand.
- The updater (GitHub APK self-update) is Android-only; the iOS build never contains or uses the updater token.
