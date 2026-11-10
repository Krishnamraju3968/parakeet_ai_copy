# Veilpad

## Build installers

Install dependencies with `npm ci`, then build on the target operating system:

- macOS: `npm run dist:mac` creates a `.dmg` installer and a `.zip` app archive in `dist/`.
- Windows: `npm run dist:win` creates an NSIS `.exe` installer in `dist/`.

The macOS build uses the architecture of the Mac running the build. The Windows
build is intended to run on Windows. The **Build installers** GitHub Actions
workflow builds both platforms on their respective runners and uploads each
installer as a workflow artifact.

These builds are unsigned. Signing and notarization require the publisher's
Apple Developer and Windows code-signing credentials.

`.env` files are deliberately excluded from installers. For an installed app,
create a `.env` file in Veilpad's user data folder and add `EXA_API_KEY=your-key`
there, then restart the app. The app displays the exact path if the key is
missing. In development, put `.env` in the project root.
