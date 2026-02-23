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

For the private key, point to your `.p8` file (recommended):

```env
ASC_PRIVATE_KEY_PATH=./AuthKey_XXXXXX.p8
```

Or pass the key inline:

```env
ASC_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

`ASC_PRIVATE_KEY_PATH` takes priority when both are set. `ASC_BASE_URL` is optional and defaults to `https://api.appstoreconnect.apple.com/`.

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

No credentials required.

Default (no flags):

```bash
npx appstore-tools ipa generate
```

This works when the current folder has an iOS project context (`.xcworkspace` or `.xcodeproj`) and an `ExportOptions.plist`.

Optional override (only if needed):

```bash
npx appstore-tools ipa generate --output-ipa ./dist/MyApp.ipa
```

If auto-detection is ambiguous, use explicit xcodebuild flags:

```bash
npx appstore-tools ipa generate \
  --output-ipa ./dist/MyApp.ipa \
  --scheme MyApp \
  --workspace-path ./MyApp.xcworkspace \
  --export-options-plist ./ExportOptions.plist
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
2. `ExportOptions.plist` from local files
3. scheme from `xcodebuild -list -json`
4. output path as `./dist/<scheme>.ipa` when omitted

### Generate ExportOptions.plist

Create a minimal production-ready template for TestFlight/App Store:

```bash
npx appstore-tools ipa export-options --team-id ABCDE12345
```

Defaults:

- output path: `./ExportOptions.plist`
- method: `app-store-connect`
- signing style: `automatic`

Optional flags:

```bash
npx appstore-tools ipa export-options \
  --output-plist ./config/ExportOptions.plist \
  --signing-style manual \
  --force
```

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
- IPA source from newest local `.ipa`, or from project build context (`.xcworkspace` / `.xcodeproj` + `ExportOptions.plist` + scheme)

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
  --export-options-plist ./ExportOptions.plist \
  --apply
```

#### Preflight checks

Every upload runs these checks before touching App Store Connect:

- File exists, is readable, has `.ipa` extension
- Archive contains `Payload/*.app/Info.plist`
- Bundle ID, version, and build number match expectations
- Code signing is valid (`codesign --verify --strict --deep`)
- SHA-256 and MD5 checksums computed

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
    builds-upload.ts # builds upload command
    ipa-generate.ts  # ipa generate command
  ipa/
    artifact.ts      # IPA resolution (prebuilt/xcodebuild/custom)
    preflight.ts     # IPA verification
  cli.ts             # CLI entry point
  index.ts           # Public API exports
```
