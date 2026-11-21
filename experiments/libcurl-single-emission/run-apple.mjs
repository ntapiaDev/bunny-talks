import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { fixturePort, printReport, runExperiment } from './run.mjs';

const exec = promisify(execFile);
const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const iphone = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17';
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const bundlePattern = /^fr\.bunnytalks\.experiment\.curl\.run-[0-9a-f-]+$/;

export async function waitForResult(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) return null;
    await delay(100);
  } while (Date.now() < deadline);
  return null;
}

async function runApple(directory, udid, port) {
  let report = { verdict: 'NOT_RUN' };
  let stage = 'apple-fixture-openssl';
  const app = join(directory, 'SingleEmission.app');
  let installedBundle;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('SIMCTL_CHILD_')),
  );
  const command = async (file, args) =>
    (await exec(file, args, { env, timeout: 30_000 })).stdout.trim();
  const simctl = (...args) => command('/usr/bin/xcrun', ['simctl', ...args]);

  try {
    if (!/^OpenSSL 3\.\d+\.\d+\b/.test(await command('openssl', ['version']))) {
      throw new Error('OpenSSL 3.x must be on PATH for the fixture certificate script');
    }
    stage = 'apple-build-evidence';
    const build = JSON.parse(await readFile(join(directory, 'build.json'), 'utf8'));
    const bundleId = await command('/usr/bin/plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      '-o',
      '-',
      join(app, 'Info.plist'),
    ]);
    const hash = createHash('sha256')
      .update(await readFile(join(app, 'SingleEmission')))
      .digest('hex');
    if (
      !bundlePattern.test(bundleId) ||
      !uuidPattern.test(bundleId.slice('fr.bunnytalks.experiment.curl.run-'.length)) ||
      bundleId !== build.bundleId ||
      hash !== build.executableSha256 ||
      build.architecture !== 'arm64' ||
      build.sdk !== 'iphonesimulator' ||
      build.sdkVersion !== '26.5' ||
      build.minimumOS !== '26.5' ||
      build.configuration !== 'Release' ||
      build.expectedTLS !== 'OpenSSL/3.5.9'
    ) {
      throw new Error('Invalid app identity');
    }
    await command('/usr/bin/codesign', ['--verify', '--strict', app]);
    const xcode = await command('/usr/bin/xcodebuild', ['-version']);
    const sdkBuild = await command('/usr/bin/xcrun', [
      '--sdk',
      'iphonesimulator',
      '--show-sdk-build-version',
    ]);
    if (
      xcode !== 'Xcode 26.6\nBuild version 17F113' ||
      build.xcode !== '26.6 (17F113)' ||
      !sdkBuild ||
      sdkBuild !== build.sdkBuild
    ) {
      throw new Error('Unexpected Xcode');
    }

    stage = 'apple-simulator-preflight';
    const { devices } = JSON.parse(await simctl('list', 'devices', '-j'));
    const { runtimes } = JSON.parse(await simctl('list', 'runtimes', '-j'));
    const installedRuntime = runtimes.find((item) => item.identifier === runtime);
    const device = devices[runtime]?.find((item) => item.udid.toLowerCase() === udid.toLowerCase());
    if (
      !installedRuntime?.isAvailable ||
      !installedRuntime.buildversion ||
      !device?.isAvailable ||
      device.state !== 'Booted' ||
      device.deviceTypeIdentifier !== iphone
    ) {
      throw new Error('Expected a booted iPhone 17 Simulator with iOS 26.5');
    }
    const installed = await simctl('listapps', udid);
    if (installed.includes(bundleId)) throw new Error('Experiment bundle is already installed');

    stage = 'apple-app-install';
    await simctl('install', udid, app);
    installedBundle = bundleId;
    stage = 'apple-data-container';
    const container = await simctl('get_app_container', udid, bundleId, 'data');
    if (!isAbsolute(container)) throw new Error('Simulator data container missing');
    report.build = build;
    report.simulator = {
      model: 'iPhone 17',
      runtime: 'iOS 26.5',
      runtimeBuild: installedRuntime.buildversion,
    };
    const pids = new Set();

    const runNative = async (mode, basePort, ca) => {
      const nonce = randomUUID();
      const input = join(container, 'tmp', nonce + '.pem');
      const pending = join(container, 'tmp', nonce + '.pending');
      const result = join(container, 'tmp', nonce + '.json');
      await copyFile(ca, input, constants.COPYFILE_EXCL);
      let launched = false;
      let output;
      let terminationError;
      try {
        const reply = await simctl(
          'launch',
          udid,
          bundleId,
          '--single-emission',
          mode,
          String(basePort),
          nonce,
        );
        launched = true;
        const prefix = bundleId + ': ';
        const pid = Number(reply.slice(prefix.length));
        if (!reply.startsWith(prefix) || !Number.isSafeInteger(pid) || pid <= 0 || pids.has(pid)) {
          throw new Error('Fresh simulator process not confirmed');
        }
        pids.add(pid);
        output = await waitForResult(result, 15_000);
      } finally {
        try {
          if (launched) await simctl('terminate', udid, bundleId);
        } catch (error) {
          terminationError = error;
        } finally {
          await Promise.all([input, pending, result].map((path) => rm(path, { force: true })));
        }
      }
      if (output != null && terminationError) throw terminationError;
      return output;
    };
    stage = 'apple-experiment';
    Object.assign(report, await runExperiment(runNative, port, 'OpenSSL/3.5.9'));
  } catch {
    report.reason = stage + '-unavailable';
  } finally {
    if (installedBundle) {
      try {
        await simctl('uninstall', udid, installedBundle);
      } catch {
        report.cleanup = 'apple-uninstall-failed';
      }
    }
  }
  return report;
}

if (import.meta.main) {
  const [, , directory, udid, portArg] = process.argv;
  const port = fixturePort(portArg);
  if (!directory || !uuidPattern.test(udid ?? '') || !port || process.argv.length > 5) {
    process.stderr.write('Usage: node run-apple.mjs BUILD_DIR SIMULATOR_UDID [BASE_PORT]\n');
    printReport({ verdict: 'NOT_RUN', reason: 'invalid-arguments' });
  } else if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    printReport({ verdict: 'NOT_RUN', reason: 'apple-environment-unavailable' });
  } else {
    printReport(await runApple(resolve(directory), udid, port));
  }
}
