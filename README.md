# appstore-tools

TypeScript CLI and library for App Store Connect. Authenticate with JWT, list apps, generate IPAs, and upload builds — all from your terminal.

## Installation

### From npm

```bash
npx appstore-tools --help
```

Or install globally:

```bash
npm install -g appstore-tools
appstore-tools --help
```

### From source

```bash
git clone https://github.com/alesanabriav7/appstore-tools.git
cd appstore-tools
pnpm install
npm link
appstore-tools --help
```

## Setup

Requires Node.js 20+ and an [App Store Connect API key](https://developer.apple.com/documentation/appstoreconnectapi/creating_api_keys_for_app_store_connect_api).

Set these environment variables (via `.env`, shell, or CI secrets):

```env
ASC_ISSUER_ID=your-issuer-id
ASC_KEY_ID=your-key-id
```

`ASC_KEY_ID` is auto-inferred when the key file name matches `AuthKey_<KEY_ID>.p8` (for example via `ASC_PRIVATE_KEY_PATH` or `ASC_KEY_PATH`).

For API commands (`apps list`, App Store Connect requests in `builds upload`), provide JWT private key:

```env
ASC_PRIVATE_KEY_PATH=./AuthKey_XXXXXX.p8
```

Or pass the key inline:

```env
ASC_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

Note: `ASC_PRIVATE_KEY_PATH` is recommended. For `builds upload`, inline `ASC_PRIVATE_KEY` is written to a temporary `.p8` file for `xcrun altool` and deleted after the command completes.

For xcodebuild archive/generate signing (`ipa generate` and xcodebuild-backed generation):

```env
ASC_KEY_PATH=./AuthKey_XXXXXX.p8
# or base64-encoded .p8 contents:
ASC_KEY_CONTENT=base64-encoded-p8
```

Optional:

```env
ASC_TEAM_ID=ABCDE12345
```

`ASC_BASE_URL` is optional and defaults to `https://api.appstoreconnect.apple.com/`.

Note: creating certificates requires an App Store Connect API key with `Admin` permissions.

## Usage

Run commands from your iOS app folder (the folder that contains your app files).

Example:

```bash
cd /path/to/YourApp
```

If you use Tuist and only have `Project.swift`, generate the workspace/project first:

```bash
tuist generate
```

Recommended daily flow (inside the app folder):

```bash
npx appstore-tools ipa export-options --team-id ABCDE12345
npx appstore-tools ipa generate
npx appstore-tools builds upload --apply
```

### List apps

```bash
npx appstore-tools apps list
```

JSON output:

```bash
npx appstore-tools apps list --json
```

### Generate IPA

Default (no flags):

```bash
npx appstore-tools ipa generate
```

This works when the current folder has an iOS project context (`.xcworkspace` or `.xcodeproj`).
If `ExportOptions.plist` is not found, the CLI generates one automatically.

Optional override (only if needed):

```bash
npx appstore-tools ipa generate --output-ipa ./dist/MyApp.ipa
```

If auto-detection is ambiguous, use explicit xcodebuild flags:

```bash
npx appstore-tools ipa generate \
  --output-ipa ./dist/MyApp.ipa \
  --scheme MyApp \
  --workspace-path ./MyApp.xcworkspace
```

If your project uses a custom build script, use custom mode:

```bash
npx appstore-tools ipa generate \
  --output-ipa ./dist/MyApp.ipa \
  --build-command "make build-ipa" \
  --generated-ipa-path ./build/MyApp.ipa
```

Auto mode for `ipa generate` infers:

1. workspace/project from local `.xcworkspace` / `.xcodeproj` (including Tuist-generated projects)
2. `ExportOptions.plist` from local files when available, otherwise generates one dynamically
3. scheme from `xcodebuild -list -json`
4. output path as `./dist/<scheme>.ipa` when omitted

### Generate ExportOptions.plist

Create a minimal production-ready template for TestFlight/App Store:

```bash
npx appstore-tools ipa export-options --team-id ABCDE12345
```

Defaults:

- output path: `./ExportOptions.plist`
- method: `app-store`
- signing style: `automatic`

Optional flags:

```bash
npx appstore-tools ipa export-options \
  --output-plist ./config/ExportOptions.plist \
  --signing-style manual \
  --force
```

### Create ASC signing certificate

Create a certificate in App Store Connect and install it into your login keychain:

```bash
npx appstore-tools certificates create
```

Defaults:

- certificate type: `IOS_DISTRIBUTION`
- common name: `CLI Certificate`
- output directory: `./dist/certificates`
- installation target: `~/Library/Keychains/login.keychain-db`
- keychain import access: `security import ... -A` to avoid interactive prompts in CI/CD

Optional flags:

```bash
npx appstore-tools certificates create \
  --type IOS_DEVELOPMENT \
  --common-name "CI Signing Certificate" \
  --output-dir ./certs \
  --keychain ~/Library/Keychains/login.keychain-db \
  --skip-install \
  --json
```

### Update metadata

Update App Store listing text and screenshots from a JSON manifest.

Dry-run by default (no mutations):

```bash
npx appstore-tools apps update-metadata --app com.example.myapp --metadata ./metadata.json
```

Apply changes:

```bash
npx appstore-tools apps update-metadata --app com.example.myapp --metadata ./metadata.json --apply
```

Optional flags:

```bash
npx appstore-tools apps update-metadata \
  --app com.example.myapp \
  --metadata ./metadata.json \
  --version 2.0.0 \
  --platform IOS \
  --text-only \
  --json \
  --apply
```

- `--text-only` — skip screenshot uploads, only update text fields
- `--screenshots-only` — skip text updates, only upload screenshots
- `--version` — target a specific version (defaults to the latest editable version)
- `--platform` — `IOS` (default) or `MAC_OS`

#### Manifest format

The manifest is a JSON object keyed by locale. Each locale can contain text fields and/or a `screenshots` object:

```json
{
  "en-US": {
    "description": "The best app for doing things.",
    "keywords": "productivity, tools, utilities",
    "promotionalText": "Now with dark mode!",
    "supportUrl": "https://example.com/support",
    "marketingUrl": "https://example.com",
    "screenshots": {
      "APP_IPHONE_67": [
        "./screenshots/en-US/iphone67/01_home.png",
        "./screenshots/en-US/iphone67/02_detail.png"
      ],
      "APP_IPAD_PRO_129": [
        "./screenshots/en-US/ipad/01_home.png"
      ]
    }
  },
  "es-MX": {
    "description": "La mejor app para hacer cosas.",
    "keywords": "productividad, herramientas"
  }
}
```

All text fields are optional. Screenshot keys are App Store Connect display types (e.g., `APP_IPHONE_67`, `APP_IPAD_PRO_129`). File paths are resolved relative to the manifest file location.

### Upload build

Dry-run by default (no mutations):

```bash
npx appstore-tools builds upload
```

Upload (real apply):

```bash
npx appstore-tools builds upload --apply
```

Wait until processing finishes:

```bash
npx appstore-tools builds upload --apply --wait-processing
```

Auto mode resolves:

- app from `CFBundleIdentifier`
- version from `CFBundleShortVersionString`
- build number from `CFBundleVersion`
- IPA source from newest local `.ipa`, or from project build context (`.xcworkspace` / `.xcodeproj` + scheme)

Optional overrides (only if needed):

```bash
npx appstore-tools builds upload \
  --app com.example.myapp \
  --version 1.2.3 \
  --build-number 45 \
  --ipa ./dist/MyApp.ipa
```

Explicit xcodebuild mode (if auto-detection is ambiguous):

```bash
npx appstore-tools builds upload \
  --app com.example.myapp \
  --version 1.2.3 \
  --build-number 45 \
  --scheme MyApp \
  --workspace-path ./MyApp.xcworkspace \
  --apply
```

#### Preflight checks

Every upload runs these checks before touching App Store Connect:

- File exists, is readable, has `.ipa` extension
- Archive contains `Payload/*.app/Info.plist`
- Bundle ID, version, and build number match expectations
- Code signing is valid (`codesign --verify --strict --deep`)
- SHA-256 and MD5 checksums computed

The CLI now attempts upload with `xcrun altool` first. If that primary upload fails (for example, missing local Xcode tooling/credentials), it automatically falls back to the App Store Connect upload API flow (`buildUploads` + `buildUploadFiles` + checksum marking/polling).

### Help

```bash
npx appstore-tools --help
```

## Library usage

```typescript
import { AppStoreConnectClient, listApps } from "appstore-tools";

const client = new AppStoreConnectClient({
  issuerId: process.env.ASC_ISSUER_ID!,
  keyId: process.env.ASC_KEY_ID!,
  privateKey: process.env.ASC_PRIVATE_KEY!
});

const apps = await listApps(client);
console.log(apps);
```

## Development

```bash
pnpm install
pnpm verify          # typecheck + test + build + help
```

Individual commands:

```bash
pnpm typecheck       # type check
pnpm test            # run tests
pnpm build           # compile to dist/
pnpm cli -- --help   # run built CLI
pnpm cli:dev -- --help  # run from source (no build needed)
```

## Project structure

```
src/
  api/
    client.ts        # HTTP client with JWT auth
    types.ts         # Shared upload operation types
  commands/
    apps-list.ts     # apps list command
    apps-update-metadata.ts # apps update-metadata command
    builds-upload.ts # builds upload command
    certificates-create.ts # certificate create command
    ipa-generate.ts  # ipa generate command
  ipa/
    artifact.ts      # IPA resolution (prebuilt/xcodebuild/custom)
    preflight.ts     # IPA verification
  cli.ts             # CLI entry point
  index.ts           # Public API exports
```
