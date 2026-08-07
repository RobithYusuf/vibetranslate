# Contributing to VibeTranslate

Thanks for being here. This project is maintained by one person, so the most useful
contributions are small, clearly scoped, and easy to review.

## Where to start

Issues labelled **`good first issue`** are chosen so you can finish them without
understanding the whole app. Perennially useful:

- **UI translations** into another language (`src/i18n/translations.ts`)
- **App/terminal detection patterns** for programs that need special handling when pasting
- **Bug fixes** with clear reproduction steps

## Setting up

```bash
pnpm install
pnpm tauri:dev
```

Requirements: Node 22.13+, pnpm 11, and the Rust toolchain (`rustup`). Windows also needs the
Visual Studio C++ Build Tools. On macOS the app will ask for **Accessibility** permission the
first time it copies or pastes.

Before opening a PR:

```bash
pnpm exec tsc --noEmit
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

To produce real installers locally use `pnpm build:local` — plain `pnpm tauri build` also
builds updater artifacts, which need the maintainer's signing key and will fail for you.

## Pull request flow

1. Fork, branch, and make your change
2. Open a PR describing **what problem it solves** and **why this approach**
3. CI runs automatically: typecheck, frontend build, and a Rust check on macOS and Windows
4. A human review follows, then merge

Please understand why review is strict: this app holds Accessibility permission, so it can
read your selected text and press keys on your behalf. **Every PR is read line by line**, and
anything that adds a dependency, sends data over the network, or touches the
clipboard/keyboard paths gets extra scrutiny. That isn't about trusting you personally — it's
an obligation to the people who install this.

## Contributor License Agreement

By opening a Pull Request you agree that your contribution may be used under this project's
license, and that the maintainer may also relicense it in the future (for example to offer a
commercially licensed edition). You keep the copyright to your own code.

An automated CLA check will be added later; until then, this section is the agreement.

## Code style

Match the file you're editing. One rule this codebase holds tightly:

> Comments explain **why**, not **what**. If a line looks strange but has a reason — say, the
> order of window-focus calls on macOS — write the reason down. That's what saves the next
> person.

## Out of scope

- Server/API and admin panel code (a closed service, not in this repository)
- Features that send user data anywhere other than the AI provider the user chose
- Branding or app-name changes

## Reporting security issues

Don't open a public issue — see [SECURITY.md](SECURITY.md). Anything touching the
Accessibility, clipboard, or auto-update paths is treated as high priority.
