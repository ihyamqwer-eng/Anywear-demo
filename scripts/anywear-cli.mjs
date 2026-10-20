import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const port = 1111;
const appUrl = `http://${host}:${port}`;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDirectory, '..');
const installRoot = resolve(appRoot, '..');
const runtimeNode = resolve(installRoot, 'runtime', 'node.exe');
const serverEntry = resolve(appRoot, 'server', 'dist', 'index.js');
const configDirectory = resolve(process.env.LOCALAPPDATA || process.env.APPDATA || installRoot, 'QingyeTech', 'Anywear');
const configPath = resolve(configDirectory, '.env');
const seedConfigPath = resolve(appRoot, '.env.seed');
const statePath = resolve(configDirectory, 'server-state.json');

function fail(message) {
  console.error(`Anywear: ${message}`);
  process.exitCode = 1;
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureInstalled() {
  if (!await fileExists(runtimeNode)) throw new Error(`runtime not found at ${runtimeNode}`);
  if (!await fileExists(serverEntry)) throw new Error(`server entry point not found at ${serverEntry}`);
  if (!await fileExists(seedConfigPath)) throw new Error(`configuration seed not found at ${seedConfigPath}`);
}

async function ensureConfig() {
  await mkdir(configDirectory, { recursive: true });
  if (!await fileExists(configPath)) await copyFile(seedConfigPath, configPath, constants.COPYFILE_EXCL);
  return configPath;
}

async function readState() {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (!state || typeof state !== 'object' || !Number.isInteger(state.pid) || state.pid <= 0
      || typeof state.startedAt !== 'string' || typeof state.runtimeNode !== 'string' || typeof state.serverEntry !== 'string'
      || typeof state.controlToken !== 'string' || state.controlToken.length < 32) {
      return null;
    }
    return state;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw new Error('the recorded process state is unreadable');
  }
}

async function writeState(state) {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, statePath);
}

async function removeState() {
  await rm(statePath, { force: true });
}

function inspectProcess(pid) {
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue`,
    'if ($null -eq $process) { exit 2 }',
    '[pscustomobject]@{',
    '  processId = [int]$process.ProcessId',
    '  executablePath = [string]$process.ExecutablePath',
    '  commandLine = [string]$process.CommandLine',
    "  startedAt = $process.CreationDate.ToUniversalTime().ToString('o')",
    '} | ConvertTo-Json -Compress',
  ].join('\n');
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status === 2) return null;
  if (result.error || result.status !== 0) throw new Error('unable to inspect the recorded process');
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('unable to read recorded process details');
  }
}

function samePath(left, right) {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

function verifyOwnership(state) {
  if (!samePath(state.runtimeNode, runtimeNode) || !samePath(state.serverEntry, serverEntry)) {
    return { state: 'mismatch' };
  }
  const processInfo = inspectProcess(state.pid);
  if (!processInfo) return { state: 'stopped' };
  const commandLine = typeof processInfo.commandLine === 'string' ? processInfo.commandLine.toLowerCase() : '';
  const entryMatches = commandLine.includes(state.serverEntry.toLowerCase());
  const owned = samePath(processInfo.executablePath, state.runtimeNode)
    && entryMatches
    && processInfo.startedAt === state.startedAt;
  return owned ? { state: 'owned', processInfo } : { state: 'mismatch', processInfo };
}

async function healthCheck(timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${appUrl}/api/health`, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload && payload.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthCheck()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return false;
}

async function requestGracefulShutdown(controlToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${appUrl}/api/internal/shutdown`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${controlToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: controller.signal,
    });
    return response.status === 202;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function assertPortAvailable() {
  return new Promise((resolvePort, rejectPort) => {
    const listener = createServer();
    listener.once('error', (error) => {
      listener.close();
      rejectPort(error);
    });
    listener.listen({ host, port, exclusive: true }, () => listener.close(resolvePort));
  });
}

function launchBrowser() {
  const chromeCandidates = [
    process.env.ProgramFiles ? resolve(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    process.env['ProgramFiles(x86)'] ? resolve(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  ];
  const edgeCandidates = [
    process.env.ProgramFiles ? resolve(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    process.env['ProgramFiles(x86)'] ? resolve(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
  ];
  for (const executable of ['chrome.exe', 'msedge.exe']) {
    const result = spawnSync('where.exe', [executable], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) {
      const paths = result.stdout.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
      if (executable === 'chrome.exe') chromeCandidates.push(...paths);
      else edgeCandidates.push(...paths);
    }
  }
  const candidates = [...chromeCandidates, ...edgeCandidates].filter((path) => path && existsSync(path));
  for (const browser of candidates) {
    const child = spawn(browser, [appUrl], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => {});
    if (child.pid) {
      child.unref();
      return true;
    }
  }
  return false;
}

async function start() {
  await ensureInstalled();
  await ensureConfig();
  const existing = await readState();
  if (existing) {
    const ownership = verifyOwnership(existing);
    if (ownership.state === 'owned') {
      if (await healthCheck()) {
        launchBrowser();
        console.log(`Anywear is already running at ${appUrl}`);
        return;
      }
      throw new Error('the recorded Anywear process is running but is not healthy; stop it before starting again');
    }
    if (ownership.state === 'stopped') await removeState();
    else throw new Error('the recorded PID is no longer owned by Anywear; refusing to reuse or stop it');
  }
  try {
    await assertPortAvailable();
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EADDRINUSE') {
      throw new Error(`port ${port} is already in use; Anywear will not replace another process`);
    }
    throw error;
  }
  const controlToken = randomBytes(32).toString('base64url');
  const child = spawn(runtimeNode, [serverEntry], {
    cwd: appRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ANYWEAR_APP_ROOT: appRoot,
      ANYWEAR_DATA_DIR: configDirectory,
      NODE_ENV: 'production',
      HOST: host,
      PORT: String(port),
      ALLOWED_ORIGINS: appUrl,
      ANYWEAR_CONTROL_TOKEN: controlToken,
    },
  });
  if (!child.pid) throw new Error('failed to create the server process');
  child.unref();
  let processInfo;
  for (let attempt = 0; attempt < 10 && !processInfo; attempt += 1) {
    try {
      processInfo = inspectProcess(child.pid);
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  if (!processInfo) throw new Error('could not record ownership of the server process');
  const state = { pid: child.pid, startedAt: processInfo.startedAt, runtimeNode, serverEntry, controlToken };
  const ownership = verifyOwnership(state);
  if (ownership.state !== 'owned') throw new Error('could not verify ownership of the server process');
  await writeState(state);
  if (!await waitForHealth()) {
    throw new Error('the server did not become healthy within 20 seconds; its recorded PID was retained for a graceful stop');
  }
  if (!launchBrowser()) console.log(`Anywear is running at ${appUrl}`);
}

async function stop() {
  const state = await readState();
  if (!state) {
    console.log('Anywear is not running.');
    return;
  }
  const ownership = verifyOwnership(state);
  if (ownership.state === 'stopped') {
    await removeState();
    console.log('Anywear is not running.');
    return;
  }
  if (ownership.state !== 'owned') throw new Error('the recorded PID is not owned by Anywear; refusing to stop it');
  if (!await requestGracefulShutdown(state.controlToken)) {
    throw new Error('the server did not accept its graceful shutdown request; its recorded PID was retained');
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    if (verifyOwnership(state).state === 'stopped') {
      await removeState();
      console.log('Anywear stopped.');
      return;
    }
  }
  throw new Error('the server did not stop after SIGTERM; its state was retained');
}

async function status() {
  const state = await readState();
  if (!state) {
    console.log('Anywear is stopped.');
    return;
  }
  const ownership = verifyOwnership(state);
  if (ownership.state !== 'owned') {
    console.log(ownership.state === 'stopped' ? 'Anywear is stopped (stale state file).' : 'Anywear state does not match the recorded process.');
    process.exitCode = 1;
    return;
  }
  console.log(await healthCheck() ? `Anywear is running at ${appUrl}` : 'Anywear process is running but is not healthy.');
}

async function config(argumentsList) {
  if (argumentsList.length > 1 || (argumentsList.length === 1 && argumentsList[0] !== 'open')) {
    throw new Error('usage: anywear config [open]');
  }
  await ensureInstalled();
  const path = await ensureConfig();
  const editor = spawn('notepad.exe', [path], { detached: true, stdio: 'ignore', windowsHide: true });
  editor.unref();
  console.log(`Anywear configuration: ${path}`);
}

const [command, ...argumentsList] = process.argv.slice(2);
try {
  switch (command) {
    case 'start': await start(); break;
    case 'stop': await stop(); break;
    case 'status': await status(); break;
    case 'config': await config(argumentsList); break;
    default:
      console.log('Usage: anywear <start|stop|status|config [open]>');
      process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  fail(error instanceof Error ? error.message : 'unexpected failure');
}
