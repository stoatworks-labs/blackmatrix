# Signing the mobile apps

Everything here needs a credential, which is why it is a document rather than a
script. **No password, key or certificate should be pasted into a repo file, a
commit, or a chat session.** The wiring is already done; what is missing is the
secret, and that is yours to create.

## Where this stands

| | State |
|---|---|
| Apple team | **3G7USP8N73** (ALLAN SARGEANT), already set in `mobile/src-tauri/tauri.conf.json` |
| Apple certificate | `Developer ID Application` exists — that is the **macOS** one. No iOS Development certificate yet. |
| Provisioning profiles | None installed (`~/Library/MobileDevice/Provisioning Profiles/` is empty) |
| Android keystore | None. Only `~/.android/debug.keystore`, which Google will not accept for a release. |
| Android wiring | Done — `gen/android/app/build.gradle.kts` reads a gitignored `keystore.properties`, and stays unsigned when it is absent |

A `Developer ID Application` certificate means the Apple Developer Program
membership is already paid for, so an iOS Development certificate is a few
clicks rather than a purchase.

---

## iOS: a development profile

This is only needed to run on a **physical iPhone or iPad**. The simulator needs
no signing at all, which is why the app has already been built and driven there.

### The short route — let Xcode do it

1. Open the generated project:

   ```bash
   open ~/projects/video/blackmatrix/mobile/src-tauri/gen/apple/blackmatrix-mobile.xcodeproj
   ```

2. **Xcode → Settings → Accounts**, sign in with the Apple ID that owns team
   `3G7USP8N73`. This is the step that needs your password; nothing else here
   does.
3. Select the **blackmatrix_mobile_iOS** target → **Signing & Capabilities**.
   Tick **Automatically manage signing** and choose the team. Xcode then issues
   an *Apple Development* certificate and a matching provisioning profile on its
   own.
4. Plug in the iPhone, pick it as the run destination, and press run once from
   Xcode. That registers the device with the team and installs the profile.
5. From then on the Tauri CLI works directly:

   ```bash
   cd ~/projects/video/blackmatrix/mobile
   npx tauri ios dev            # run on the connected device
   npx tauri ios build          # produce an .ipa
   ```

### Checking it worked

```bash
security find-identity -v -p codesigning        # expect an "Apple Development: …" line
ls ~/Library/MobileDevice/Provisioning\ Profiles/   # expect at least one .mobileprovision
```

### Worth knowing

- On first launch the phone will ask to trust the developer:
  **Settings → General → VPN & Device Management**.
- The app declares `NSLocalNetworkUsageDescription`, so iOS will also ask for
  local network access. **Say yes** — refuse it and the server sweep finds
  nothing, silently. That exact omission is what broke the desktop app's first
  release.
- Development profiles from a paid account last a year. A free Apple ID gets
  seven days, and the app stops opening after that.
- TestFlight is a separate step and needs App Store Connect. Not required for
  running on your own devices.

---

## Android: a release signing key

The key **is** the app's identity. Android refuses an update signed by a
different key, so losing it means shipping under a new package name and every
install becomes a separate app. Back it up somewhere that is not this laptop.

### Create it

You choose the passwords; do not write them anywhere in this repo.

```bash
mkdir -p ~/keys
keytool -genkeypair -v \
  -keystore ~/keys/blackmatrix-release.jks \
  -alias blackmatrix \
  -keyalg RSA -keysize 4096 \
  -validity 10000
```

`keytool` is in the JDK already installed at
`/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin`.

10000 days is deliberate: Google Play requires a key valid until at least 2033,
and a key that expires mid-life is the same disaster as a lost one.

### Point the build at it

Create `mobile/src-tauri/gen/android/keystore.properties` — **gitignored, and it
must stay that way**:

```properties
storeFile=/Users/allansargeant/keys/blackmatrix-release.jks
storePassword=<the store password you chose>
keyAlias=blackmatrix
keyPassword=<the key password you chose>
```

Use an absolute path. Gradle resolves a relative one against the `app/`
directory, which is rarely where anyone expects.

### Build and check

```bash
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export NDK_HOME=$ANDROID_HOME/ndk/28.2.13676358
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home

cd ~/projects/video/blackmatrix/mobile
npx tauri android build --target aarch64        # release, now signed

$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

If `apksigner` reports "DOES NOT VERIFY", the properties file was not found —
the build falls back to unsigned deliberately rather than failing, so that a
fresh clone still builds.

---

## Things already established, so nobody rediscovers them

- **Gradle cannot use JDK 25**, which is this machine's default. It fails with a
  bare `> 25.0.4` and no explanation. `JAVA_HOME` must point at openjdk@21.
- **`ANDROID_HOME` is not set in the shell.** The SDK is installed, at
  `/opt/homebrew/share/android-commandlinetools`, with NDK 28.2.13676358.
- **`gen/apple` and `gen/android` are committed and meant to be edited**, but
  `tauri ios init` / `tauri android init` regenerate them. The two local edits
  that matter are the Android `signingConfigs` block and
  `usesCleartextTraffic = "true"` for release; re-check both after any re-init.
- **`usesCleartextTraffic` must stay true.** A BlackMatrix server is plain http
  on a private address. With it false, a release APK reaches nothing while debug
  works perfectly.
- The Android **emulator is NAT'd alone on 10.0.2.x**, so the server sweep finds
  nothing there and the host is reachable as `10.0.2.2`. That is the emulator,
  not a bug. A real phone on the same Wi-Fi behaves like the iOS simulator did,
  where the sweep found the server by name.
