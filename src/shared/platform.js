'use strict';

/** Detect OS, WSL and display server once per process. */

const fs = require('fs');
const os = require('os');

let cached = null;

function detectWSL() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function osName(platform) {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  try {
    const rel = fs.readFileSync('/etc/os-release', 'utf8');
    const m = rel.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (m) return m[1];
  } catch {
    /* ignore */
  }
  return 'Linux';
}

/**
 * @returns {{platform:'darwin'|'win32'|'linux',isWSL:boolean,displayServer:'quartz'|'windows'|'x11'|'wayland'|'none',
 *   desktop:string,arch:string,release:string,osName:string,hostname:string,user:string,shell:string,isHeadless:boolean}}
 */
function info() {
  if (cached) return cached;
  const platform = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
  const isWSL = detectWSL();
  let displayServer = 'none';
  if (platform === 'darwin') displayServer = 'quartz';
  else if (platform === 'win32' || isWSL) displayServer = 'windows';
  else if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') displayServer = 'wayland';
  else if (process.env.DISPLAY) displayServer = 'x11';
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    user = process.env.USER || process.env.USERNAME || '';
  }
  const shell =
    platform === 'win32'
      ? process.env.ComSpec || 'cmd.exe'
      : process.env.SHELL || '/bin/sh';
  cached = {
    platform,
    isWSL,
    displayServer,
    desktop: process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '',
    arch: process.arch,
    release: os.release(),
    osName: isWSL ? `Windows (WSL: ${osName('linux')})` : osName(platform),
    hostname: os.hostname(),
    user,
    shell,
    isHeadless: displayServer === 'none',
  };
  return cached;
}

/** For tests. */
function _reset() {
  cached = null;
}

module.exports = { info, _reset };
