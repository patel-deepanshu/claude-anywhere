# Contributing to Claude Anywhere

Thank you for helping improve Claude Anywhere. This guide explains how to report bugs, propose changes and get
them merged. Claude Anywhere was created by [Deepanshu Patel](https://github.com/patel-deepanshu), who maintains
it and reviews contributions.

- [Code of conduct](#code-of-conduct)
- [Reporting bugs](#reporting-bugs)
- [Reporting security issues](#reporting-security-issues)
- [Suggesting features](#suggesting-features)
- [Contributing code](#contributing-code)
- [Running the tests](#running-the-tests)
- [Coding guidelines](#coding-guidelines)
- [Pull request checklist](#pull-request-checklist)
- [How contributors are credited](#how-contributors-are-credited)
- [License of contributions](#license-of-contributions)

## Code of conduct

Be respectful and constructive. Assume good intent, keep discussions about the work, and help newcomers.
Harassment or personal attacks are not tolerated, and the maintainer may remove comments or block participants
who do not follow this.

## Reporting bugs

Open an issue at <https://github.com/patel-deepanshu/claude-anywhere/issues>. Search the existing issues first;
if one matches, add your details there instead of opening a new one.

A good bug report includes:

1. **What you did**: the command you ran (`/anywhere …`, `anywhere …`) or what you said or typed in the dialog.
2. **What you expected** and **what happened instead** (the exact error message, if any).
3. **Your environment**:
   - operating system and version (for Linux: the distribution, X11 or Wayland, and the desktop such as GNOME or KDE);
   - `node --version` and `claude --version`;
   - how you installed Claude Anywhere (plugin, personal skill + CLI, or the install script).
4. **Diagnostics**:
   - the output of `anywhere doctor` (or `/anywhere doctor` in Claude Code);
   - the last lines of the daemon log: `anywhere logs -n 80`.
5. Steps to reproduce, as short as possible. Screenshots or a short screen recording help for dialog issues.

**Before you paste logs or screenshots, remove anything private.** Claude Anywhere redacts secrets in its logs,
but check for tokens, API keys, file paths, project names, window titles, email addresses and on-screen content
you do not want to share. Never paste the contents of `~/.claude-anywhere/daemon.json`,
`~/.claude-anywhere/config.json` or the files in `~/.claude-anywhere/run/`: they hold access tokens.

## Reporting security issues

Do **not** open a public issue for a vulnerability (for example, a way for a web page, another program or Claude
itself to bypass an approval card or the dialog's protections). Report it privately to the maintainer through
GitHub's private vulnerability reporting (**Security → Report a vulnerability** on the repository page) when it
is enabled, or contact [@patel-deepanshu](https://github.com/patel-deepanshu) on GitHub and ask for a private
channel without disclosing details publicly. The security model is described in
[docs/SECURITY.md](docs/SECURITY.md).

## Suggesting features

Open an issue that describes the problem you want to solve and how you would use the feature. For large
changes (a new platform backend, a new integration, changes to the permission model or the daemon API), please
discuss the design in an issue before writing code, so the work fits the architecture in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing code

1. **Fork** the repository on GitHub and clone your fork:

   ```bash
   git clone https://github.com/<your-username>/claude-anywhere.git
   cd claude-anywhere
   git remote add upstream https://github.com/patel-deepanshu/claude-anywhere.git
   ```

2. **Create a branch** from an up-to-date `main`, named after the change:

   ```bash
   git fetch upstream
   git checkout -b fix/wayland-clipboard upstream/main     # or feature/…, docs/…
   ```

3. **Make your change**, with tests (see below). Keep each pull request focused on one change.

4. **Run the checks** locally (all must pass):

   ```bash
   npm test                  # the full node:test suite
   npm run lint              # syntax check of every source file
   claude plugin validate .  # plugin and marketplace manifests (needs Claude Code)
   ```

5. **Commit** with clear messages that say what changed and why (for example
   `Wayland: read the clipboard with wl-paste --no-newline`). Use your own name and email in `git config`, so the
   commit is credited to you.

6. **Push** your branch to your fork and **open a pull request** against `main` of
   `patel-deepanshu/claude-anywhere`. In the description, explain the problem, the change, how you tested it
   (including the operating systems you tried), and link the issue it fixes (`Fixes #123`).

7. **Review**: the maintainer may ask for changes. Push further commits to the same branch; the pull request
   updates automatically. Once approved, the maintainer merges it.

To keep your fork up to date: `git fetch upstream && git rebase upstream/main` on your branch (or merge
`upstream/main` into it if you prefer not to rebase).

## Running the tests

You need **Node.js 18.17 or newer**. The project has no npm dependencies, so there is nothing to install.

```bash
npm test                                         # every test/*.test.js through node --test
node scripts/test.js --test-name-pattern=voice   # only matching tests (options go to node --test)
node --test test/desktop-own-dialog.test.js      # a single file
npm run lint                                     # node scripts/check-syntax.js
```

The suite needs no network, display or audio device: OS drivers run against fakes and the mock driver
(`ANYWHERE_DRIVER=mock`). Some tests are skipped automatically when a tool is missing (Python 3 for the voice
sidecar, a Chromium browser for the dialog UI tests, which also need Node 22 or newer for its global WebSocket).

Opt-in tests that drive real hardware or a real desktop are skipped unless you enable them:

| Variable | What it enables |
|---|---|
| `ANYWHERE_LIVE_DESKTOP=1` | Live desktop tests: they move **your** mouse and type on **your** screen. Run them in a VM or a virtual display (Xvfb). |
| `ANYWHERE_LIVE_OCR=1` | On-screen text recognition against a real browser page. |
| `ANYWHERE_TEST_CHROME=/path/to/chrome` | The Chromium binary for the dialog UI tests (found automatically when installed). |

CI (`.github/workflows/ci.yml`) runs the suite on Linux, macOS and Windows with Node 18 and 22, compiles the
Windows PowerShell 5.1 host, and runs live desktop jobs on Xvfb, Windows and macOS runners.

## Coding guidelines

- **No runtime npm dependencies.** Use Node's standard library (and the OS's own tools) instead. Optional
  components (Electron, the Piper voice, the Python voice runtime) are downloaded only when the user asks for them,
  with pinned versions and checksums.
- **CommonJS** with `'use strict';`, two-space indentation, single quotes and semicolons, as in the existing code.
  Document exported functions with JSDoc comments, and explain *why* in comments where it is not obvious.
- **Cross-platform first.** Code that touches the OS goes through the drivers in `src/os/` (macOS, Windows/WSL,
  Linux X11/Wayland, and the mock driver). If you add a driver method, implement it for every backend (or return
  a clear `UNSUPPORTED` error) and the mock driver.
- **Security-sensitive areas** need extra care and tests: the permission classifier
  (`src/daemon/permissions.js`), the daemon's authentication (`src/daemon/server.js`), and the protections that
  stop Claude from operating the Claude Anywhere dialog itself (`src/os/computer.js`). Read
  [docs/SECURITY.md](docs/SECURITY.md) first.
- **Tests with every change.** Add a regression test for a bug fix and tests for new behavior next to the
  existing ones in `test/`.
- **Docs with every user-visible change.** Update `README.md` and the relevant guide in `docs/`, and the module
  contract in `docs/ARCHITECTURE.md` when an interface changes.
- **Never commit secrets** or personal data: tokens, API keys, recordings of your voice, screenshots of your
  desktop, or files from `~/.claude-anywhere`.

## Pull request checklist

- [ ] `npm test` passes (and you ran it on the platforms your change affects, if you can).
- [ ] `npm run lint` passes.
- [ ] `claude plugin validate .` passes, if you changed `.claude-plugin/`, `skills/` or the MCP server.
- [ ] New behavior and bug fixes have tests.
- [ ] Documentation is updated for user-visible changes, and `CHANGELOG.md` has an entry under *Unreleased*.
- [ ] No secrets, tokens or personal data are included.

## How contributors are credited

Every contribution is credited:

- **Your commits keep your name.** Pull requests are merged with your authorship preserved in the Git history
  (when a pull request is squashed, you remain the commit author).
- **CHANGELOG.md** names the contributor and links the pull request for each change it lists.
- **[CONTRIBUTORS.md](CONTRIBUTORS.md)** lists everyone whose contribution has been merged. Add yourself in your
  pull request, or the maintainer will add you when merging.
- Contributions other than code (bug reports, documentation, testing on a platform, design feedback) are
  credited in CONTRIBUTORS.md too.

## License of contributions

Claude Anywhere is released under the [MIT License](LICENSE), copyright Deepanshu Patel. By submitting a pull
request, you agree that your contribution is licensed under the same MIT License, and you confirm that you have
the right to submit it (it is your own work, or you have permission to contribute it under that license). You
keep the copyright to your contribution, and your authorship is credited as described above.
