import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { get } from 'node:http';
import { isAbsolute, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { waitForResult } from '../../../experiments/libcurl-single-emission/run-apple.mjs';
import { classify, parseNative } from '../../../experiments/libcurl-single-emission/run.mjs';
import { fixturePort, runtimeRoutes, standardHttpsRoutes } from './ios-libcurl-scenarios.ts';
import { startFixture } from './server.ts';
import { evaluateRuntime } from './verify-ios-libcurl-runtime.mjs';

const run = promisify(execFile);
const results = 'qualification/ios-libcurl-results';
const runtimeId = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const deviceType = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17';
const bundleId = 'fr.bunnytalks.mobile.httpsqualification.libcurl';
const profile = 'ios-https-libcurl-runtime';
const projectId = '9f79f216-56bb-4a89-b2f2-ed367a4164da';
const native = 'modules/application-https/ios';
const vendor = native + '/vendor';
const witnessSource = '../../experiments/libcurl-single-emission';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hash40 = /^[a-f0-9]{40}$/;
const hash64 = /^[a-f0-9]{64}$/;
const env = Object.fromEntries(
  ['HOME', 'PATH', 'TMPDIR', 'DEVELOPER_DIR']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
env.LC_ALL = 'C';

const requireEvidence = (condition) => {
  if (!condition) throw new Error('qualification evidence unavailable');
};
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const write = (name, data) =>
  writeFile(join(results, name + '.json'), JSON.stringify(data, null, 2) + '\n');
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const command = async (file, args, timeout = 30_000, commandEnv = env) =>
  (await run(file, args, { env: commandEnv, timeout })).stdout.trim();
const simctl = (args, timeout) => command('/usr/bin/xcrun', ['simctl', ...args], timeout);

export function validateStage(app, pkg, eas, input) {
  const ios = eas.build?.[profile]?.ios;
  const settings = eas.build?.[profile];
  requireEvidence(
    Object.keys(eas.build ?? {}).length === 1 &&
      ios?.simulator === true &&
      ios.withoutCredentials === true &&
      ios.buildConfiguration === 'Release' &&
      ios.config === profile + '.yml' &&
      ios.image === 'macos-tahoe-26.5-xcode-26.6' &&
      settings.environment === 'preview' &&
      settings.node === '24.22.2' &&
      settings.pnpm === '10.34.9' &&
      Object.keys(settings.env ?? {}).length === 3 &&
      settings.env.EXPO_NO_DOTENV === '1' &&
      settings.env.EXPO_PUBLIC_USE_RN_FETCH === '1' &&
      settings.env.BUNNY_IOS_HTTPS_QUALIFICATION === '1' &&
      pkg.main === 'qualification/ios-libcurl-runtime-entry.tsx' &&
      app.expo.slug === 'bunny-talks-https' &&
      app.expo.extra?.eas?.projectId === projectId &&
      app.expo.ios?.bundleIdentifier === bundleId &&
      app.expo.jsEngine === 'hermes' &&
      app.expo.plugins?.includes('./qualification/with-ios-libcurl-link-map.cjs') &&
      hash40.test(input.reviewedRevision ?? ''),
  );
}

async function validateWorker() {
  requireEvidence(
    process.platform === 'darwin' &&
      process.arch === 'arm64' &&
      process.env.EAS_BUILD_RUNNER === 'eas-build' &&
      process.env.EAS_BUILD_PROFILE === profile &&
      process.env.EAS_BUILD_PLATFORM === 'ios' &&
      process.env.EAS_BUILD_PROJECT_ID === projectId &&
      process.env.BUNNY_IOS_HTTPS_QUALIFICATION === '1' &&
      process.env.EXPO_NO_DOTENV === '1' &&
      process.env.EXPO_PUBLIC_USE_RN_FETCH === '1' &&
      uuid.test(process.env.EAS_BUILD_ID ?? ''),
  );
  const paths = ['app.json', 'package.json', 'eas.json', 'qualification/ios-libcurl-input.json'];
  validateStage(...(await Promise.all(paths.map(json))));
}

async function preflight() {
  await validateWorker();
  requireEvidence((await readdir('.')).every((name) => !name.startsWith('.env') && name !== 'ios'));
  await mkdir(results, { mode: 0o700 });
  const proof = await command('python3', [
    '-I',
    native + '/verify_xcframeworks.py',
    'archive',
    vendor + '/xcframeworks.zip',
  ]);
  await write('provenance', JSON.parse(proof));
}

async function approvedApp() {
  const link = await json(join(results, 'link.json'));
  const { reviewedRevision } = await json('qualification/ios-libcurl-input.json');
  requireEvidence(
    link.bundleId === bundleId &&
      link.configuration === 'Release' &&
      link.architecture === 'arm64' &&
      link.platform === 'IOSSIMULATOR' &&
      link.minimumOS === '16.4' &&
      link.easBuildId === process.env.EAS_BUILD_ID &&
      link.reviewedRevision === reviewedRevision &&
      hash64.test(link.executableSha256 ?? '') &&
      /^[A-Za-z0-9_-]+$/.test(link.executable ?? ''),
  );
  const directory = 'ios/build/Build/Products/Release-iphonesimulator';
  const apps = (await readdir(directory)).filter((leaf) => /^[A-Za-z0-9_ -]+\.app$/.test(leaf));
  requireEvidence(apps.length === 1);
  const app = join(directory, apps[0]);
  requireEvidence((await hash(join(app, link.executable))) === link.executableSha256);
  return { app, link };
}

function readControl(basePort, path) {
  return new Promise((resolve, reject) => {
    const request = get(
      { host: '127.0.0.1', port: basePort + 5, path, agent: false },
      async (response) => {
        try {
          requireEvidence(response.statusCode === 200);
          const buffers = [];
          let bytes = 0;
          for await (const chunk of response) {
            bytes += chunk.length;
            requireEvidence(bytes <= 4 * 1024 * 1024);
            buffers.push(chunk);
          }
          resolve(JSON.parse(Buffer.concat(buffers).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      },
    );
    request.setTimeout(2000, () => request.destroy(new Error('fixture timeout')));
    request.on('error', reject);
  });
}

async function observeProcess(device, link, app, work) {
  await simctl(['install', device, app]);
  const installed = await simctl(['get_app_container', device, bundleId, 'app']);
  requireEvidence(
    installed.startsWith('/') &&
      (await hash(join(installed, link.executable))) === link.executableSha256,
  );
  const info = join(installed, 'Info.plist');
  const version = await command('plutil', [
    '-extract',
    'CFBundleShortVersionString',
    'raw',
    '-o',
    '-',
    info,
  ]);
  const buildVersion = await command('plutil', [
    '-extract',
    'CFBundleVersion',
    'raw',
    '-o',
    '-',
    info,
  ]);
  requireEvidence(
    [version, buildVersion].every((value) => /^\d{1,6}(?:\.\d{1,6}){0,3}$/.test(value)),
  );
  const log = join(work, 'app.log');
  const output = await open(log, 'wx', 0o600);
  const logStream = spawn(
    '/usr/bin/xcrun',
    [
      'simctl',
      'spawn',
      device,
      'log',
      'stream',
      '--level',
      'info',
      '--style',
      'compact',
      '--predicate',
      'subsystem == "com.facebook.react.log" AND category == "javascript" AND eventMessage CONTAINS "[BunnyIosCurlRuntime]"',
    ],
    { env, stdio: ['ignore', output.fd, 'ignore'] },
  );
  let logError = false;
  let stopped = false;
  let sampling;
  logStream.on('error', () => {
    logError = true;
  });
  await output.close();
  const samples = [];
  let appLog = '';
  try {
    await delay(1000);
    requireEvidence(!logError && logStream.exitCode === null);
    const launch = await simctl(['launch', device, bundleId]);
    requireEvidence(launch.startsWith(bundleId + ': '));
    const pid = Number(launch.slice(bundleId.length + 2));
    requireEvidence(Number.isSafeInteger(pid) && pid > 0);
    await write('installed', {
      buildId: link.easBuildId,
      sha256: link.executableSha256,
      version,
      buildVersion,
      pid,
    });
    sampling = (async () => {
      while (!stopped) {
        try {
          const value = await command('/bin/ps', ['-o', 'rss=', '-p', String(pid)], 1000);
          if (/^[1-9][0-9]{0,9}$/.test(value))
            samples.push({ atMs: Date.now(), rssKiB: Number(value) });
        } catch {
          // Missing phase samples are handled by the verifier.
        }
        await delay(200);
      }
    })();

    const deadline = performance.now() + 180_000;
    while (performance.now() < deadline) {
      requireEvidence((await stat(log)).size <= 1024 * 1024);
      appLog = await readFile(log, 'utf8');
      if (/\[BunnyIosCurlRuntime\] (?:DONE|FAIL setup)\r?\n/.test(appLog)) {
        await delay(500);
        appLog = await readFile(log, 'utf8');
        break;
      }
      if (logError || logStream.exitCode !== null) break;
      await delay(250);
    }
    return { appLog, samples };
  } finally {
    stopped = true;
    await sampling;
    logStream.kill();
  }
}

async function runWitness(device, work) {
  const provenance = await json(join(results, 'provenance.json'));
  const temporaryVendor = join(work, 'vendor');
  await command('python3', [
    '-I',
    native + '/verify_xcframeworks.py',
    'stage',
    vendor + '/xcframeworks.zip',
    temporaryVendor,
  ]);
  const slice = (name) => name + '.xcframework/ios-arm64-simulator';
  const libs = ['libcurl', 'libopenssl'].map((name) => slice(name) + '/' + name + '.a');
  const archives = {};
  for (const path of libs) {
    archives[path] = await hash(join(temporaryVendor, path));
    requireEvidence(archives[path] === provenance.archives[path]);
  }
  const directory = join(work, 'SingleEmission.app');
  await mkdir(directory);
  const plist = join(directory, 'Info.plist');
  await copyFile(join(witnessSource, 'Info.plist'), plist);
  const witnessId = 'fr.bunnytalks.experiment.curl.run-' + randomUUID();
  await command('plutil', ['-replace', 'CFBundleIdentifier', '-string', witnessId, plist]);
  const flags = [
    '--sdk',
    'iphonesimulator',
    'clang',
    '--target=arm64-apple-ios26.5-simulator',
    '-O2',
    '-DNDEBUG',
  ];
  const object = join(work, 'witness.o');
  await command('xcrun', [
    ...flags,
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-pedantic',
    '-DCURL_STATICLIB',
    '-Dmain=bunny_single_emission_main',
    '-I' + join(temporaryVendor, slice('libcurl'), 'Headers'),
    '-c',
    join(witnessSource, 'single-emission.c'),
    '-o',
    object,
  ]);
  const executable = join(directory, 'SingleEmission');
  await command('xcrun', [
    ...flags,
    '-fobjc-arc',
    join(witnessSource, 'SimulatorApp.m'),
    object,
    ...libs.map((name) => join(temporaryVendor, name)),
    ...['UIKit', 'Foundation', 'Security', 'CoreFoundation', 'CoreServices'].flatMap((name) => [
      '-framework',
      name,
    ]),
    '-o',
    executable,
  ]);
  await command('codesign', ['--sign', '-', directory]);
  await command('codesign', ['--verify', '--strict', directory]);
  await simctl(['install', device, directory]);
  const container = await simctl(['get_app_container', device, witnessId, 'data']);
  requireEvidence(container.startsWith('/'));

  const port = 29_453;
  const fixture = await startFixture(join(work, 'certificates'), port, '127.0.0.1', false, true);
  try {
    const [before, ...other] = await readControl(port, '/events');
    requireEvidence(!before && !other.length);
    let seen = 0;
    const observations = {};
    const pids = new Set();
    for (const mode of ['witness', 'candidate']) {
      const nonce = randomUUID();
      const basename = join(container, 'tmp', nonce);
      await copyFile(join(work, 'certificates/ca.pem'), basename + '.pem', constants.COPYFILE_EXCL);
      const launch = await simctl([
        'launch',
        device,
        witnessId,
        '--single-emission',
        mode,
        String(port),
        nonce,
      ]);
      requireEvidence(launch.startsWith(witnessId + ': '));
      const pid = Number(launch.slice(witnessId.length + 2));
      requireEvidence(Number.isSafeInteger(pid) && pid > 0 && !pids.has(pid));
      pids.add(pid);
      const raw = await waitForResult(basename + '.json', 15_000);
      await simctl(['terminate', device, witnessId]);
      const parsed = parseNative(raw, mode, 'OpenSSL/3.5.9');
      const all = await readControl(port, '/events');
      requireEvidence(Array.isArray(all) && all.length >= seen && all.length < 4096);
      const events = all.slice(seen).map((row) => ({
        route:
          row.path === '/retry-status-length'
            ? 'prime'
            : row.path === '/drop-before-headers'
              ? 'drop'
              : 'unexpected',
        target: row.destination === 'A' ? 'primary' : 'unexpected',
        connectionId: Number.isSafeInteger(row.connectionId) ? row.connectionId : null,
        http11: row.httpVersion === '1.1',
        get: row.method === 'GET',
        ambientCredentials: row.authorization !== false || row.cookie !== false,
        headersSent: row.headersSent === true,
        finished: row.finished === true,
        closed: row.closed === true,
      }));
      seen = all.length;
      const [verdict, reason] = classify(parsed, events, mode === 'candidate');
      observations[mode] = { verdict, reason, native: parsed, events };
    }
    const statuses = Object.values(observations).map((value) => value.verdict);
    return {
      verdict: statuses.includes('FAIL')
        ? 'FAIL'
        : statuses.every((status) => status === 'PASS')
          ? 'PASS'
          : 'NOT_RUN',
      executableSha256: await hash(executable),
      archives,
      observations,
    };
  } finally {
    await fixture.close();
  }
}

export function summarizeRuntimeChecks(checks, interruptedStage) {
  const failedChecks = Object.keys(checks).filter((name) => checks[name] === 'FAIL');
  const unconfirmedChecks = Object.keys(checks).filter(
    (name) => checks[name] !== 'PASS' && checks[name] !== 'FAIL',
  );
  const automatedVerdict = failedChecks.length
    ? 'FAIL'
    : unconfirmedChecks.length
      ? 'NOT_RUN'
      : 'PASS';
  return {
    verdict: automatedVerdict === 'FAIL' ? 'FAIL' : 'NOT_RUN',
    automatedVerdict,
    checks,
    reason: failedChecks.length
      ? 'checks-failed'
      : unconfirmedChecks.length
        ? 'checks-incomplete'
        : 'memory-attribution-required',
    failedChecks,
    unconfirmedChecks,
    ...(interruptedStage ? { interruptedStage } : {}),
    memoryAttribution: { verdict: 'NOT_RUN', reason: 'layer-specific-trace-required' },
  };
}

async function qualify() {
  let stage = 'worker-validation';
  let interruptedStage;
  let work;
  let device;
  let fixture;
  let cleanup = 'PASS';
  let app;
  let guard = { verdict: 'NOT_RUN', reason: 'witness-unavailable' };
  let link;
  try {
    await validateWorker();
    ({ app, link } = await approvedApp());
    stage = 'simulator-runtime';
    const xcode = await command('xcodebuild', ['-version']);
    const sdk = await command('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version']);
    requireEvidence(xcode === 'Xcode 26.6\nBuild version 17F113' && sdk === '26.5');
    const { runtimes } = JSON.parse(await simctl(['list', 'runtimes', '--json']));
    const runtime = runtimes.find(({ identifier }) => identifier === runtimeId);
    requireEvidence(runtime?.isAvailable && /^[0-9A-Z]{3,12}$/.test(runtime.buildversion));
    const deviceId = await simctl(['create', 'Bunny HTTPS ' + randomUUID(), deviceType, runtimeId]);
    requireEvidence(uuid.test(deviceId));
    device = deviceId;
    await simctl(['bootstatus', device, '-b'], 180_000);
    await write('environment', {
      easBuildId: link.easBuildId,
      reviewedRevision: link.reviewedRevision,
      executableSha256: link.executableSha256,
      configuration: link.configuration,
      platform: link.platform,
      architecture: link.architecture,
      minimumOS: link.minimumOS,
      xcode,
      sdk,
      model: 'iPhone 17',
      os: 'iOS 26.5',
      runtimeBuild: runtime.buildversion,
    });

    stage = 'fixture';
    work = await mkdtemp('/tmp/bunny-ios-curl.');
    const certificates = join(work, 'certificates');
    const openssl = await command('openssl', ['version']);
    let certificateEnv = env;
    if (!openssl.startsWith('OpenSSL 3.')) {
      const bin = join(await command('brew', ['--prefix', 'openssl@3']), 'bin');
      certificateEnv = { ...env, PATH: bin + ':' + env.PATH };
      requireEvidence(
        (await command('openssl', ['version'], 30000, certificateEnv)).startsWith('OpenSSL 3.'),
      );
    }
    await command('bash', ['qualification/certificates.sh', certificates], 30_000, certificateEnv);
    await simctl(['keychain', device, 'add-root-cert', join(certificates, 'ca.pem')]);
    fixture = await startFixture(certificates, fixturePort, '127.0.0.1', true, true, runtimeRoutes);
    const initial = await readControl(fixturePort, '/runtime');
    requireEvidence(
      initial?.overflow === false && !initial.events.length && !initial.connections.length,
    );

    stage = 'application';
    const observed = await observeProcess(device, link, app, work);
    let wire;
    try {
      wire = await readControl(fixturePort, '/runtime');
    } catch {
      /* Oracle reports missing evidence. */
    }
    await write(
      'runtime',
      evaluateRuntime(observed.appLog, wire, observed.samples, { requireProbeDiagnostic: true }),
    );
    await fixture.close();
    fixture = null;
    await simctl(['terminate', device, bundleId]);

    stage = 'witness';
    guard = await runWitness(device, work);
  } catch {
    interruptedStage = stage;
    // Do not publish tool output, child process arguments or unfiltered logs.
  } finally {
    const dispose = async (action) => {
      try {
        await action();
      } catch {
        cleanup = 'FAIL';
      }
    };
    if (fixture) await dispose(() => fixture.close());
    if (device) {
      try {
        await simctl(['shutdown', device]);
      } catch {
        /* A failed boot may leave it shut down. */
      }
      await dispose(() => simctl(['delete', device]));
    }
    if (work) await dispose(() => rm(work, { recursive: true, force: true }));
  }
  const readVerdict = async (name) => {
    try {
      const { verdict } = await json(join(results, name + '.json'));
      return ['PASS', 'FAIL', 'NOT_RUN'].includes(verdict) ? verdict : 'NOT_RUN';
    } catch {
      return 'NOT_RUN';
    }
  };
  const verdicts = {
    runtime: await readVerdict('runtime'),
    link: await readVerdict('link'),
    guard: guard.verdict,
    cleanup,
  };
  await write('witness', guard);
  const summary = summarizeRuntimeChecks(verdicts, interruptedStage);
  await write('summary', summary);
  return summary.automatedVerdict;
}

const runIdPattern = /^[a-f0-9]{32}$/;
const writePrivate = (file, data) =>
  writeFile(file, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600 });

async function standardWorkspace(work) {
  requireEvidence(
    process.platform === 'darwin' && isAbsolute(work) && (await realpath(work)) === work,
  );
  const context = await json(join(work, '.c2-owner.json'));
  requireEvidence(
    runIdPattern.test(context.runId) &&
      hash40.test(context.revision) &&
      hash64.test(context.treeSha256) &&
      hash64.test(context.zipSha256),
  );
  const receipt = async (scope) => {
    const data = await json(join(work, scope + '.json'));
    requireEvidence(
      data.scope === scope &&
        Object.keys(data.context ?? {}).length === Object.keys(context).length &&
        Object.entries(context).every(([key, value]) => data.context[key] === value),
    );
    return data;
  };
  return { context, receipt };
}

export function validateStandardFixture(addresses, initial, fixtureId) {
  requireEvidence(
    addresses.length === 7 &&
      addresses.every(
        (entry, i) => entry?.address === '127.0.0.1' && entry.port === fixturePort + i,
      ),
  );
  requireEvidence(
    initial?.fixtureId === fixtureId &&
      initial.overflow === false &&
      Array.isArray(initial.events) &&
      initial.events.length === 0 &&
      Array.isArray(initial.connections) &&
      initial.connections.length === 0,
  );
  return addresses.map(({ address, port }) => ({ address, port }));
}

async function serveStandardFixture(work, certificates) {
  const { context, receipt } = await standardWorkspace(work);
  const environment = await receipt('environment');
  requireEvidence(
    uuid.test(environment.device) && ['full', 'hosted-observed'].includes(environment.target),
  );
  const relativeCerts = relative(work, await realpath(certificates));
  requireEvidence(relativeCerts === 'certificates');
  const fixtureId = randomUUID().replaceAll('-', '');
  const base = {
    context,
    fixtureId,
    environmentDevice: environment.device,
    environmentSha256: await hash(join(work, 'environment.json')),
  };
  await writePrivate(join(work, 'fixture-start.json'), { scope: 'fixture-start', ...base });
  const { promise: stopped, resolve } = Promise.withResolvers();
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    resolve();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let fixture;
  try {
    fixture = await startFixture(
      certificates,
      fixturePort,
      '127.0.0.1',
      true,
      true,
      standardHttpsRoutes,
      fixtureId,
    );
    if (interrupted) return;
    const bindings = validateStandardFixture(
      fixture.addresses(),
      await readControl(fixturePort, '/runtime'),
      fixtureId,
    );
    await writePrivate(join(work, 'fixture.json'), {
      scope: 'fixture',
      ...base,
      bindings,
      initialCounters: { requests: 0, connections: 0 },
      rootSha256: await hash(join(certificates, 'ca.pem')),
      leafSha256: await hash(join(certificates, 'server.pem')),
    });
    await stopped;
  } finally {
    try {
      if (fixture) {
        await fixture.close();
        await writePrivate(join(work, 'fixture-stopped.json'), {
          scope: 'fixture-stopped',
          ...base,
          closed: true,
        });
      }
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
}

export function standardPhaseLog(raw, pid, runId, fixtureId, phase) {
  const boundMarker = '[BunnyIosStandardHttpsRun] ' + runId + ' ' + fixtureId + ' ' + phase;
  const lines = [];
  for (const [index, line] of raw.split(/\r?\n/).filter(Boolean).entries()) {
    if (index === 0 && line.startsWith('Filtering the log data using ')) continue;
    const row = JSON.parse(line);
    const message = row.eventMessage;
    if (typeof message !== 'string' || !message.startsWith('[BunnyIosStandardHttps')) continue;
    requireEvidence(row.processID === pid && !/[\r\n]/.test(message));
    lines.push(message);
  }
  requireEvidence(
    lines[0] === boundMarker &&
      lines.filter((line) => line.startsWith('[BunnyIosStandardHttpsRun]')).length === 1,
  );
  return lines.join('\n') + '\n';
}

async function checkStandardFixture(work) {
  const { receipt } = await standardWorkspace(work);
  const fixture = await receipt('fixture');
  validateStandardFixture(
    fixture.bindings,
    await readControl(fixturePort, '/runtime'),
    fixture.fixtureId,
  );
}

async function captureStandardWire(work, phase) {
  requireEvidence(['before', 'after'].includes(phase));
  const { context, receipt } = await standardWorkspace(work);
  const launch = await receipt('prelaunch');
  const stopped = await receipt('stopped-' + phase);
  const fixture = await receipt('fixture');
  const binding = {
    prelaunchSha256: await hash(join(work, 'prelaunch.json')),
    device: launch.device,
    fixtureId: launch.fixtureId,
  };
  requireEvidence(
    stopped.binding.prelaunchSha256 === binding.prelaunchSha256 &&
      stopped.binding.device === binding.device &&
      stopped.binding.fixtureId === binding.fixtureId &&
      fixture.fixtureId === binding.fixtureId &&
      fixture.environmentDevice === binding.device,
  );
  const raw = join(work, phase + '.ndjson');
  requireEvidence((await stat(raw)).size <= 1024 * 1024 && (await realpath(raw)) === raw);
  const log = standardPhaseLog(
    await readFile(raw, 'utf8'),
    stopped.pid,
    context.runId,
    fixture.fixtureId,
    phase,
  );
  const wire = await readControl(fixturePort, '/runtime');
  requireEvidence(
    wire.fixtureId === fixture.fixtureId &&
      (await hash(join(work, 'certificates/server.pem'))) === fixture.leafSha256,
  );
  await writeFile(join(work, phase + '.log'), log, { flag: 'wx', mode: 0o600 });
  await writePrivate(join(work, phase + '-wire.json'), {
    ...wire,
    scope: phase + '-wire',
    context,
    binding,
    stoppedSha256: await hash(join(work, 'stopped-' + phase + '.json')),
    logSha256: await hash(join(work, phase + '.log')),
  });
}

if (import.meta.main) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--preflight') await preflight();
    else if (process.argv.length === 5 && process.argv[2] === '--standard-fixture')
      await serveStandardFixture(process.argv[3], process.argv[4]);
    else if (process.argv.length === 5 && process.argv[2] === '--standard-wire')
      await captureStandardWire(process.argv[3], process.argv[4]);
    else if (process.argv.length === 4 && process.argv[2] === '--standard-check')
      await checkStandardFixture(process.argv[3]);
    else {
      requireEvidence(process.argv.length === 2);
      const verdict = await qualify();
      process.stdout.write('Bunny iOS libcurl automated checks: ' + verdict + '\n');
      process.exitCode = verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 2;
    }
  } catch {
    process.stderr.write('Bunny iOS libcurl runtime: NOT_RUN (worker or evidence unavailable)\n');
    process.exitCode = 2;
  }
}
