# Contributing to FarSight

Thanks for helping out! FarSight is a cross-platform (macOS + Windows) eye-break app built
with Tauri: a Rust backend and a TypeScript/HTML UI.

## How changes get in

`master` is protected: nobody pushes to it directly. Every change goes through a pull
request that passes CI and is approved by a maintainer.

1. **Fork** this repository and clone your fork.
2. Create a branch: `git checkout -b fix/short-description`.
3. Make your change, then run:

   ```bash
   npm install
   npm run typecheck
   npm test         # Rust unit tests
   npm run dev      # try it for real
   ```

   You need Node.js 24+ and stable Rust (https://rustup.rs).

4. Push the branch to your fork and open a pull request against `master`.
5. CI runs on macOS and Windows. A maintainer reviews, and once approved the PR is merged.

## Guidelines

- Keep pull requests focused: one fix or feature per PR.
- Add or update unit tests when you change timer, scheduling, smart-pause or stats logic
  (`src-tauri/src/engine.rs`, `smartpause.rs`, `stats.rs` are pure Rust and easy to test).
- For UI changes, include screenshots. On macOS, a debug build run with `--self-test`
  saves snapshots of every window to `./screenshots`.
- Match the existing code style; keep platform-specific code in `src-tauri/src/activity/`
  and `src-tauri/src/platform.rs`.
- Don't add third-party artwork, sounds or fonts unless their license allows redistribution.

## Project layout

See the **Architecture** section of the [README](README.md).

## Reporting bugs and ideas

Open an issue using the bug report or feature request template.
