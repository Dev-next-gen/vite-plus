// Real Homebrew lifecycle test. Run on a disposable Mac with no installed vite-plus:
// node .github/scripts/test-homebrew.mjs /absolute/path/to/artifacts
// Requires Homebrew and Node.js. CI runs with the test: install-e2e PR label.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { prepareFormula } from './homebrew-formula.mjs';

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), '../..');
assert(process.argv[2], 'Usage: node .github/scripts/test-homebrew.mjs <artifacts-directory>');
const artifacts = path.resolve(process.argv[2]);
const tap = 'voidzero-e2e/install';
const formula = `${tap}/vite-plus`;
const stateFile = path.join(artifacts, 'state.json');

function run(binary, args, options = {}) {
  const { status = 0, ...spawnOptions } = options;
  const result = spawnSync(binary, args, {
    cwd: artifacts,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    ...spawnOptions,
  });
  assert.equal(
    result.status,
    status,
    `${binary} ${args.join(' ')}\n${result.error?.message ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
  return result.stdout;
}

function buildEnvironment(state) {
  const env = { ...process.env, HOME: state.home, PATH: state.path };
  if (state.ci === undefined) {
    delete env.CI;
  } else {
    env.CI = state.ci;
  }
  for (const key of Object.keys(env)) {
    if (/^(VP_|XDG_|NPM_CONFIG_REGISTRY$|npm_config_registry$)/.test(key)) {
      delete env[key];
    }
  }
  return {
    ...env,
    HOMEBREW_NO_AUTO_UPDATE: '1',
    HOMEBREW_NO_INSTALL_FROM_API: '1',
    HOMEBREW_NO_INSTALL_CLEANUP: '1',
    HOMEBREW_NO_ASK: '1',
  };
}

function brew(state, args) {
  return run(state.brew, args, { env: buildEnvironment(state) }).trim();
}

function brewLogged(state, phase, args) {
  console.log(`::group::Homebrew ${phase}`);
  fs.writeFileSync(path.join(artifacts, 'phase.txt'), phase);
  const log = path.join(artifacts, `${phase}.log`);
  const fd = fs.openSync(log, 'w');
  try {
    run(state.brew, args, {
      env: buildEnvironment(state),
      stdio: ['ignore', fd, fd],
      timeout: 30 * 60_000,
    });
  } catch (error) {
    console.error(fs.readFileSync(log, 'utf8').split('\n').slice(-100).join('\n'));
    throw error;
  } finally {
    fs.closeSync(fd);
    // Homebrew reuses its log directory for the next build.
    const logs = path.join(state.home, 'Library/Logs/Homebrew/vite-plus');
    if (fs.existsSync(logs)) {
      fs.cpSync(logs, path.join(artifacts, `${phase}-build`), { recursive: true });
    }
    console.log('::endgroup::');
  }
}

async function prepare() {
  fs.mkdirSync(artifacts, { recursive: true });
  assert.equal(process.platform, 'darwin', 'Run this test on macOS');
  const state = {
    home: os.homedir(),
    path: process.env.PATH,
    ci: process.env.CI,
    brew: run('which', ['brew']).trim(),
  };
  assert(
    !brew(state, ['list', '--formula']).split('\n').includes('vite-plus'),
    'Use a disposable runner: vite-plus is already installed',
  );
  const tapPath = brew(state, ['--repository', tap]);
  assert(!fs.existsSync(tapPath), `Refusing to replace existing tap ${tapPath}`);
  state.prefix = brew(state, ['--prefix']);
  state.formulaPath = path.join(tapPath, 'Formula/vite-plus.rb');
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: repo }).trim();
  const coreSha = run('git', [
    'ls-remote',
    'https://github.com/Homebrew/homebrew-core.git',
    'HEAD',
  ]).split(/\s/)[0];
  assert.match(coreSha, /^[a-f0-9]{40}$/);
  const response = await fetch(
    `https://raw.githubusercontent.com/Homebrew/homebrew-core/${coreSha}/Formula/v/vite-plus.rb`,
  );
  assert(response.ok, `Cannot fetch official formula: ${response.status}`);
  const official = await response.text();
  fs.writeFileSync(path.join(artifacts, 'official-vite-plus.rb'), official);
  const sourceJson = (file) => JSON.parse(run('git', ['show', `${sha}:${file}`], { cwd: repo }));
  state.version = sourceJson('packages/cli/package.json').version;
  const upstream = sourceJson('packages/tools/.upstream-versions.json');
  const archive = path.join(artifacts, `vite-plus-${state.version}.tar.gz`);
  run(
    'git',
    [
      'archive',
      '--format=tar.gz',
      `--prefix=vite-plus-${state.version}/`,
      `--output=${archive}`,
      sha,
    ],
    { cwd: repo },
  );
  const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  for (const revision of [1, 2]) {
    fs.writeFileSync(
      path.join(artifacts, `vite-plus-${revision}.rb`),
      prepareFormula(official, {
        url: pathToFileURL(archive).href,
        sha256,
        version: state.version,
        revision,
        upstream,
      }),
    );
  }
  fs.writeFileSync(
    path.join(artifacts, 'inputs.json'),
    JSON.stringify({ sha, coreSha, sha256, version: state.version, upstream }, null, 2),
  );
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  brewLogged(state, 'tap-core', ['tap', '--force', 'homebrew/core']);
  brew(state, ['tap-new', '--no-git', tap]);
  fs.copyFileSync(path.join(artifacts, 'vite-plus-1.rb'), state.formulaPath);
  if (spawnSync(state.brew, ['command', 'trust']).status === 0) {
    brew(state, ['trust', '--formula', formula]);
  }
  fs.writeFileSync(path.join(artifacts, 'brew-config.log'), brew(state, ['config']));
  brewLogged(state, 'install', ['install', '--build-from-source', formula]);
  brewLogged(state, 'formula-test', ['test', formula]);
  state.node = path.join(brew(state, ['--prefix', 'node']), 'bin/node');
  state.nodeVersion = run(state.node, ['-p', 'process.versions.node']).trim();
  state.oldPrefix = fs.realpathSync(path.join(state.prefix, 'opt/vite-plus'));
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return state;
}

function command(test, binary, args, options = {}) {
  const { expectedStatus = 0, ...spawnOptions } = options;
  const result = spawnSync(binary, args, {
    cwd: test.directory,
    env: test.env,
    encoding: 'utf8',
    timeout: 120_000,
    ...spawnOptions,
  });
  fs.appendFileSync(
    path.join(artifacts, `${test.name}.log`),
    `$ ${binary} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}\n`,
  );
  assert.equal(
    result.status,
    expectedStatus,
    `${result.error?.message ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
  return `${result.stdout}${result.stderr}`;
}

function settings(test) {
  return JSON.parse(fs.readFileSync(path.join(test.dirs.config, 'config.json'), 'utf8'));
}

function shimMode(choice) {
  return choice === 'yes' ? 'managed' : 'system_first';
}

function createCase(state, name, choices, singleRoot) {
  const directory = path.join(artifacts, name);
  const home = path.join(directory, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = buildEnvironment(state);
  delete env.CI;
  env.HOME = home;
  env.SHELL = '/bin/bash';
  env.PATH = `${path.dirname(state.node)}:${state.prefix}/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  env.NPM_CONFIG_REGISTRY = 'http://127.0.0.1:9';
  env.VP_SELF_SETUP_NO_MODIFY_PATH = '1';
  if (singleRoot) {
    env.VP_HOME = path.join(home, 'vp');
  }
  const vp = path.join(state.prefix, 'bin/vp');
  const dump = run(vp, [], { cwd: directory, env: { ...env, VP_DUMP_DIRS: '1' } });
  const dirs = Object.fromEntries(
    dump
      .trim()
      .split('\n')
      .map((line) => line.split('\t')),
  );
  for (const [key, value] of Object.entries(dirs)) {
    if (key !== 'layout') {
      assert(value.startsWith(`${home}/`), `${key} escaped isolated HOME: ${value}`);
    }
  }
  assert.equal(dirs.layout, singleRoot ? 'single-root' : 'split');
  const runtime = path.join(dirs.data, 'js_runtime/node', state.nodeVersion, 'bin');
  fs.mkdirSync(runtime, { recursive: true });
  fs.symlinkSync(state.node, path.join(runtime, 'node'));
  fs.writeFileSync(path.join(directory, '.node-version'), state.nodeVersion);
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      private: true,
      scripts: { smoke: 'node -p "21 * 2"' },
    }),
  );
  fs.writeFileSync(path.join(directory, 'example.js'), 'const value={answer:42};\n');
  const test = { name, directory, env, dirs, vp };
  const first = command(test, vp, ['--version'], { env: { ...env, ...choices } });
  assert.match(first, /Vite\+ setup complete/);
  assert.match(first, new RegExp(state.version.replaceAll('.', '\\.')));
  const receiptDir = path.join(dirs.state, 'self-setup');
  const receipts = fs.readdirSync(receiptDir);
  assert.equal(receipts.length, 1);
  const receipt = fs.readFileSync(path.join(receiptDir, receipts[0]), 'utf8');
  const second = command(test, vp, ['--version']);
  assert.doesNotMatch(second, /setup complete|installing vite-plus|Would you like/);
  assert.equal(fs.readFileSync(path.join(receiptDir, receipts[0]), 'utf8'), receipt);
  assert(!fs.existsSync(path.join(dirs.data, 'current')));
  assert.equal(fs.readlinkSync(path.join(dirs.bin, 'vp')), vp);
  env.PATH = `${dirs.bin}:${env.PATH}`;
  test.preferences = settings(test);
  assert.equal(test.preferences.nodeShimMode ?? 'managed', shimMode(choices.VP_NODE_MANAGER));
  for (const family of ['npm', 'pnpm', 'yarn', 'bun']) {
    const choice = choices[`VP_${family.toUpperCase()}_MANAGER`] ?? choices.VP_PM_MANAGER;
    assert.equal(test.preferences.packageManagerShimModes?.[family] ?? 'managed', shimMode(choice));
  }
  return test;
}

function checkCase(state, test) {
  const shim = path.join(test.dirs.bin, 'vp');
  command(test, shim, ['--version']);
  assert.deepEqual(settings(test), test.preferences);
  command(test, shim, ['env', 'setup', '--refresh']);
  assert.deepEqual(settings(test), test.preferences);
  assert.equal(fs.realpathSync(shim), fs.realpathSync(test.vp));
  assert.match(command(test, path.join(test.dirs.bin, 'node'), ['-p', '21 * 2']), /42/);
  assert.match(command(test, path.join(state.prefix, 'bin/vpr'), ['smoke']), /42/);
  command(test, path.join(state.prefix, 'bin/vpx'), ['--help']);
  command(test, shim, ['fmt', 'example.js']);
  command(test, shim, ['fmt', '--check', 'example.js']);
  const doctor = command(test, shim, ['env', 'doctor', 'node']);
  assert.match(doctor, /CLI source\s+Homebrew/);
  assert.match(doctor, /CLI binary\s+/);
  assert.match(doctor, /Shim dir\s+/);
  assert.match(command(test, shim, ['upgrade', '--check']), /brew outdated vite-plus/);
  for (const args of [['upgrade'], ['upgrade', '--force'], ['upgrade', '--rollback']]) {
    assert.match(command(test, shim, args, { expectedStatus: 1 }), /brew upgrade vite-plus/);
  }
  assert(!fs.existsSync(path.join(test.dirs.data, 'current')));
}

function withReadOnlyPrefix(prefix, check) {
  const modes = [];
  function protect(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      return;
    }
    modes.push([file, stat.mode & 0o777]);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) {
        protect(path.join(file, name));
      }
    }
    fs.chmodSync(file, stat.mode & 0o555);
  }
  try {
    protect(prefix);
    check();
    assert(!fs.existsSync(path.join(prefix, 'bin/.vp-setup-complete')));
  } finally {
    for (const [file, mode] of modes) {
      fs.chmodSync(file, mode);
    }
  }
}

function upgrade(state) {
  fs.copyFileSync(path.join(artifacts, 'vite-plus-2.rb'), state.formulaPath);
  brewLogged(state, 'upgrade', ['upgrade', '--build-from-source', formula]);
  assert.notEqual(fs.realpathSync(path.join(state.prefix, 'opt/vite-plus')), state.oldPrefix);
  brewLogged(state, 'cleanup', ['cleanup', formula]);
  assert(!fs.existsSync(state.oldPrefix), 'Homebrew did not remove the old keg');
}

function verify(state) {
  fs.writeFileSync(path.join(artifacts, 'phase.txt'), 'runtime-before-upgrade');
  const cases = [];
  withReadOnlyPrefix(state.oldPrefix, () => {
    cases.push(
      createCase(state, 'default-system', { VP_NODE_MANAGER: 'no', VP_PM_MANAGER: 'no' }, false),
    );
    cases.push(
      createCase(state, 'managed', { VP_NODE_MANAGER: 'yes', VP_PM_MANAGER: 'yes' }, true),
    );
    cases.push(
      createCase(
        state,
        'mixed',
        { VP_NODE_MANAGER: 'yes', VP_PM_MANAGER: 'no', VP_PNPM_MANAGER: 'yes' },
        true,
      ),
    );
    for (const test of cases) {
      checkCase(state, test);
    }
  });
  console.log('First-run setup, offline bundled CLI, preferences, and ownership checks passed.');
  const mixed = cases.find((test) => test.name === 'mixed');
  // Keep Bash's command cache alive across an actual brew upgrade and cleanup.
  command(
    mixed,
    '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      [
        'set -eu',
        'vp --version',
        'test "$(hash -t vp)" = "$E2E_SHIM/vp"',
        '"$E2E_NODE" "$E2E_SCRIPT" "$E2E_ARTIFACTS" upgrade',
        'vp --version',
        '"$E2E_SHIM/vp" --version',
        'test "$("$E2E_SHIM/node" -p "21 * 2")" = 42',
      ].join('\n'),
    ],
    {
      timeout: 40 * 60_000,
      env: {
        ...mixed.env,
        E2E_SHIM: mixed.dirs.bin,
        E2E_NODE: process.execPath,
        E2E_SCRIPT: script,
        E2E_ARTIFACTS: artifacts,
      },
    },
  );
  const prefix = fs.realpathSync(path.join(state.prefix, 'opt/vite-plus'));
  fs.writeFileSync(path.join(artifacts, 'phase.txt'), 'runtime-after-upgrade');
  withReadOnlyPrefix(prefix, () => {
    for (const test of cases) {
      checkCase(state, test);
      const output = command(test, test.vp, ['implode', '--yes']);
      assert.match(output, /brew uninstall vite-plus/);
      assert.match(output, /hash -r/);
      for (const [key, directory] of Object.entries(test.dirs)) {
        if (key !== 'layout' && key !== 'bin') {
          assert(!fs.existsSync(directory), `implode left ${directory}`);
        }
      }
      assert(!fs.existsSync(path.join(test.dirs.bin, 'vp')));
      assert(!fs.existsSync(path.join(test.dirs.bin, 'node')));
      assert(fs.existsSync(path.join(prefix, 'bin/vp')));
    }
  });
  brewLogged(state, 'uninstall', ['uninstall', formula]);
  assert(!fs.existsSync(prefix));
  assert(!fs.existsSync(path.join(state.prefix, 'bin/vp')));
  brew(state, ['untap', tap]);
  fs.writeFileSync(path.join(artifacts, 'phase.txt'), 'passed');
  console.log(
    'Homebrew upgrade, old-keg removal, cached Bash commands, and uninstall checks passed.',
  );
}

if (process.argv[3] === 'upgrade') {
  upgrade(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
} else {
  verify(await prepare());
}
