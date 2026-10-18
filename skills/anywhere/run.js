#!/usr/bin/env node
'use strict';

/**
 * Launcher for the /anywhere skill. Finds the Claude Anywhere package and runs
 * its CLI (bin/anywhere.js) with the same arguments, forwarding stdio, signals
 * and the exit code.
 *
 * Package resolution, first match wins:
 *   1. ../../bin/anywhere.js when this file is <package>/skills/anywhere/run.js (repository
 *      checkout or plugin install)
 *   2. install.json in the state directory (ANYWHERE_HOME, default ~/.claude-anywhere), written by
 *      `anywhere install`: for a plugin install (pluginsDir), the version Claude Code has installed
 *      now, from <pluginsDir>/installed_plugins.json (each plugin update moves the plugin to a new
 *      versioned folder); else, or when that finds nothing, packageRoot
 *   3. `anywhere` on PATH
 *
 * A copy of this file is also the stable launcher of plugin installs (<state>/launcher/anywhere.js,
 * which the `anywhere` link and the hotkey run).
 *
 * Kept free of syntax newer than Node 10 so outdated Node versions get upgrade
 * instructions instead of a SyntaxError.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const MIN_MAJOR = 18;
const REPO = 'https://github.com/patel-deepanshu/claude-anywhere';

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

function nodeMajor(version) {
  return parseInt(String(version || process.versions.node).replace(/^v/, '').split('.')[0], 10) || 0;
}

function upgradeHint(platform) {
  if (platform === 'darwin') return 'brew install node   (or the LTS installer from https://nodejs.org)';
  if (platform === 'win32') return 'winget install OpenJS.NodeJS.LTS   (or the LTS installer from https://nodejs.org)';
  return 'use your package manager, or nvm: curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install --lts';
}

function stateDir(env, homedir) {
  return env.ANYWHERE_HOME ? path.resolve(env.ANYWHERE_HOME) : path.join(homedir, '.claude-anywhere');
}

function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    return path.resolve(p);
  }
}

/**
 * The anywhere plugin's current install folder, from Claude Code's installed_plugins.json
 * ("anywhere@<marketplace>": version 2 keeps a list of installs, version 1 one entry), or null.
 * An install from the same marketplace as `previousRoot` (…/cache/<marketplace>/anywhere/<v>) and
 * a user-scope one come first.
 * @param {string} pluginsDir
 * @param {string} [previousRoot]
 * @returns {string|null}
 */
function currentPluginRoot(pluginsDir, previousRoot) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'installed_plugins.json'), 'utf8'));
  } catch (e) {
    return null;
  }
  if (!manifest || typeof manifest !== 'object') return null;
  const plugins = manifest.plugins && typeof manifest.plugins === 'object' ? manifest.plugins : manifest;
  const m = /[\\/]cache[\\/]([^\\/]+)[\\/]anywhere[\\/][^\\/]+[\\/]?$/.exec(String(previousRoot || ''));
  const market = m ? m[1] : null;
  const found = [];
  Object.keys(plugins).forEach(function (key) {
    const parts = key.split('@');
    if (parts[0] !== 'anywhere') return;
    const entries = Array.isArray(plugins[key]) ? plugins[key] : [plugins[key]];
    entries.forEach(function (e) {
      const dir = e && typeof e.installPath === 'string' ? e.installPath : null;
      if (!dir || !isFile(path.join(dir, 'bin', 'anywhere.js'))) return;
      const rank = (market && parts[1] === market ? 0 : 2) + (e.scope && e.scope !== 'user' ? 1 : 0);
      found.push({ dir: dir, rank: rank });
    });
  });
  found.sort(function (a, b) {
    return a.rank - b.rank;
  });
  return found.length ? found[0].dir : null;
}

/**
 * Find an executable on PATH (honours PATHEXT on Windows).
 * @param {string} name
 * @param {object} env
 * @param {string} platform
 * @returns {string|null}
 */
function findOnPath(name, env, platform) {
  const isWin = platform === 'win32';
  const sep = isWin ? ';' : ':';
  const exts = isWin ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  const dirs = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  for (let i = 0; i < dirs.length; i += 1) {
    const dir = dirs[i].replace(/^"(.*)"$/, '$1');
    for (let j = 0; j < exts.length; j += 1) {
      const candidate = path.join(dir, name + exts[j].toLowerCase());
      if (!isFile(candidate)) continue;
      if (!isWin) {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch (e) {
          continue;
        }
      }
      return candidate;
    }
  }
  return null;
}

/**
 * Work out how to run the CLI.
 * @param {{skillDir?:string, env?:object, homedir?:string, platform?:string, self?:string}} [opts]
 *   `self`: this launcher's own file (default __filename), never run again through PATH
 * @returns {{kind:'script', script:string, root:string, via:'relative'|'plugin'|'install.json'|'path'} |
 *           {kind:'command', command:string, via:'path'} | null}
 */
function resolveLauncher(opts) {
  const o = opts || {};
  const skillDir = o.skillDir || __dirname;
  const env = o.env || process.env;
  const homedir = o.homedir || os.homedir();
  const platform = o.platform || process.platform;

  // Only inside a package (<root>/skills/anywhere): a copy elsewhere, such as the stable launcher in
  // the state directory, must not pick up an unrelated ../../bin/anywhere.js.
  const inPackage = path.basename(skillDir) === 'anywhere' && path.basename(path.dirname(skillDir)) === 'skills';
  const local = path.resolve(skillDir, '..', '..', 'bin', 'anywhere.js');
  if (inPackage && isFile(local)) return { kind: 'script', script: local, root: path.dirname(path.dirname(local)), via: 'relative' };

  const infoFile = path.join(stateDir(env, homedir), 'install.json');
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  } catch (e) {
    info = null; // not installed that way
  }
  if (info && typeof info === 'object') {
    const root = typeof info.packageRoot === 'string' ? info.packageRoot : '';
    if (typeof info.pluginsDir === 'string' && info.pluginsDir) {
      const current = currentPluginRoot(info.pluginsDir, root);
      if (current) return { kind: 'script', script: path.join(current, 'bin', 'anywhere.js'), root: current, via: 'plugin' };
    }
    if (root && isFile(path.join(root, 'bin', 'anywhere.js'))) return { kind: 'script', script: path.join(root, 'bin', 'anywhere.js'), root: root, via: 'install.json' };
  }

  const onPath = findOnPath('anywhere', env, platform);
  if (onPath) {
    // Our own shims sit next to anywhere.js: run that directly (no shell needed).
    let real = onPath;
    try {
      real = fs.realpathSync(onPath);
    } catch (e) {
      real = onPath;
    }
    const sibling = path.join(path.dirname(real), 'anywhere.js');
    // The stable launcher (this file, or this launcher's copy) would only come back here.
    if (realOr(sibling) === realOr(o.self || __filename)) return null;
    if (isFile(sibling)) return { kind: 'script', script: sibling, root: path.dirname(path.dirname(sibling)), via: 'path' };
    return { kind: 'command', command: onPath, via: 'path' };
  }
  return null;
}

/** Quote one argument for cmd.exe (only used for a .cmd/.bat `anywhere` on PATH). */
function quoteWinArg(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[\s"&|<>^%!()]/.test(s)) return s;
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').replace(/%/g, '"%"') + '"';
}

/**
 * Build the spawn call for a resolved launcher.
 * @returns {{command:string, args:string[], shell:boolean}}
 */
function spawnSpec(launcher, argv, platform) {
  const plat = platform || process.platform;
  if (launcher.kind === 'script') return { command: process.execPath, args: [launcher.script].concat(argv), shell: false };
  if (plat === 'win32' && /\.(cmd|bat)$/i.test(launcher.command)) {
    return { command: quoteWinArg(launcher.command), args: argv.map(quoteWinArg), shell: true };
  }
  return { command: launcher.command, args: argv.slice(), shell: false };
}

function notFoundMessage() {
  return [
    'Claude Anywhere is not installed where this skill can find it.',
    'Install it (needs git and Node.js 18.17+):',
    '  macOS / Linux:  curl -fsSL https://raw.githubusercontent.com/patel-deepanshu/claude-anywhere/main/scripts/install.sh | bash',
    '  Windows:        irm https://raw.githubusercontent.com/patel-deepanshu/claude-anywhere/main/scripts/install.ps1 | iex',
    '  From a clone:   node bin/anywhere.js install',
    'Or as a Claude Code plugin: /plugin marketplace add patel-deepanshu/claude-anywhere, then /plugin install anywhere@anywhere-marketplace',
    'More: ' + REPO,
  ].join('\n');
}

function main() {
  if (nodeMajor() < MIN_MAJOR) {
    process.stderr.write(
      'Claude Anywhere needs Node.js 18.17 or newer, but `node` here is ' + process.version + '.\n' +
        'Upgrade: ' + upgradeHint(process.platform) + '\n' +
        'Then run /anywhere again.\n'
    );
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const launcher = resolveLauncher();
  if (!launcher) {
    process.stderr.write(notFoundMessage() + '\n');
    process.exit(1);
  }
  const spec = spawnSpec(launcher, argv);
  let child;
  try {
    child = childProcess.spawn(spec.command, spec.args, { stdio: 'inherit', shell: spec.shell, windowsHide: false });
  } catch (err) {
    process.stderr.write('Could not run Claude Anywhere (' + spec.command + '): ' + err.message + '\n');
    process.exit(1);
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (process.platform === 'win32') signals.push('SIGBREAK');
  const handlers = {};
  signals.forEach(function (sig) {
    handlers[sig] = function () {
      try {
        child.kill(sig);
      } catch (e) {
        /* child already gone */
      }
    };
    try {
      process.on(sig, handlers[sig]);
    } catch (e) {
      /* signal not supported on this platform */
    }
  });
  child.on('error', function (err) {
    process.stderr.write('Could not run Claude Anywhere (' + spec.command + '): ' + err.message + '\n');
    process.exit(1);
  });
  child.on('exit', function (code, signal) {
    if (signal) {
      Object.keys(handlers).forEach(function (sig) {
        process.removeListener(sig, handlers[sig]);
      });
      try {
        process.kill(process.pid, signal);
      } catch (e) {
        process.exit(1);
      }
      setTimeout(function () {
        process.exit(1);
      }, 200);
      return;
    }
    process.exit(code == null ? 1 : code);
  });
}

if (require.main === module) main();

module.exports = { resolveLauncher, currentPluginRoot, spawnSpec, findOnPath, nodeMajor, quoteWinArg, notFoundMessage, stateDir };
