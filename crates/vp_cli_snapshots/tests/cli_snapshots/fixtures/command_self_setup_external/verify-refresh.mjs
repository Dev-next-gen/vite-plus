import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const action = process.argv[2];
const root = path.resolve(process.env.REPLACEMENT_ROOT ?? 'replacement');
const publicVp = path.join(root, 'brew/bin/vp');
const oldPrefix = path.join(root, 'brew/Cellar/vite-plus/old');
const newPrefix = path.join(root, 'brew/Cellar/vite-plus/new');

// These actions run between commands in the same Bash session.
if (action === 'switch') {
  fs.unlinkSync(publicVp);
  fs.symlinkSync(path.join(newPrefix, 'bin/vp'), publicVp);
} else if (action === 'remove') {
  fs.rmSync(oldPrefix, { recursive: true });
} else {
  const source = path.join(process.env.VP_HOME, 'bin/vp');
  const managed = { VP_NODE_MANAGER: 'yes', VP_PM_MANAGER: 'yes' };
  const mixed = { VP_NODE_MANAGER: 'yes', VP_PM_MANAGER: 'no', VP_PNPM_MANAGER: 'yes' };

  function bundle(prefix, label) {
    const bin = path.join(prefix, 'bin/vp');
    const pkg = path.join(prefix, 'node_modules/vite-plus');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.copyFileSync(source, bin);
    fs.chmodSync(bin, 0o555);
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"vite-plus"}');
    fs.writeFileSync(path.join(pkg, 'dist/bin.js'), `console.log(${JSON.stringify(label)});`);
    return bin;
  }

  function environment(directory) {
    const home = path.join(directory, 'home');
    const system = path.join(directory, 'system/bin');
    const runtime = path.join(home, 'js_runtime/node', process.versions.node, 'bin');
    fs.mkdirSync(system, { recursive: true });
    fs.mkdirSync(runtime, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(system, 'node'));
    fs.symlinkSync(process.execPath, path.join(runtime, 'node'));
    fs.writeFileSync(path.join(directory, '.node-version'), process.versions.node);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('VP_') || key.startsWith('XDG_') || key === 'CI') delete env[key];
    }
    return {
      ...env,
      HOME: home,
      VP_HOME: home,
      VP_SELF_SETUP_NO_MODIFY_PATH: '1',
      NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9',
      PATH: [path.join(home, 'bin'), path.join(directory, 'brew/bin'), system, env.PATH].join(path.delimiter),
    };
  }

  function run(binary, args, cwd, env) {
    const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
    return result.stdout.trim();
  }

  function settings(env) {
    return JSON.parse(fs.readFileSync(path.join(env.VP_HOME, 'config.json'), 'utf8'));
  }

  if (action === 'preferences') {
    for (const [label, choices] of [['managed', managed], ['mixed', mixed]]) {
      const directory = path.resolve(label);
      const binary = bundle(path.join(directory, 'external'), label);
      const env = environment(directory);
      run(binary, ['--help'], directory, { ...env, ...choices });
      const before = settings(env);
      const modified = fs.statSync(binary).mtimeMs + 1000;
      fs.utimesSync(binary, new Date(modified), new Date(modified));
      run(binary, ['--help'], directory, env);
      assert.deepEqual(settings(env), before, `${label} choices changed after receipt expiry`);
      console.log(`${label} preferences survive executable replacement`);
      fs.utimesSync(binary, new Date(modified + 1000), new Date(modified + 1000));
      run(binary, ['--help'], directory, { ...env, VP_NODE_MANAGER: 'no', VP_PNPM_MANAGER: 'no' });
      assert.deepEqual(settings(env), {
        ...before,
        nodeShimMode: 'system_first',
        packageManagerShimModes: { ...before.packageManagerShimModes, pnpm: 'system_first' },
      });
    }
    console.log('explicit overrides still apply during setup without changing other preferences');
  } else {
    assert.equal(action, 'replacement');
    bundle(oldPrefix, 'bundle-old');
    bundle(newPrefix, 'bundle-new');
    fs.mkdirSync(path.dirname(publicVp), { recursive: true });
    fs.symlinkSync(path.join(oldPrefix, 'bin/vp'), publicVp);
    const env = environment(root);
    run(publicVp, ['--help'], root, { ...env, ...mixed });
    const before = settings(env);
    const output = run('bash', ['--noprofile', '--norc', '-c', [
      'set -e',
      'vp sync-versions --json',
      'test "$(hash -t vp)" = "$VP_HOME/bin/vp"',
      '"$TEST_NODE" "$TEST_SCRIPT" switch',
      '"$VP_HOME/bin/node" -p "20 + 1"',
      'vp sync-versions --json',
      '"$TEST_NODE" "$TEST_SCRIPT" remove',
      '"$VP_HOME/bin/vp" sync-versions --json',
      'vp sync-versions --json',
      '"$VP_HOME/bin/node" -p "40 + 2"',
    ].join('\n')], root, {
      ...env,
      REPLACEMENT_ROOT: root,
      TEST_NODE: process.execPath,
      TEST_SCRIPT: fileURLToPath(import.meta.url),
    });
    assert.equal(output, 'bundle-old\n21\nbundle-new\nbundle-new\nbundle-new\n42');
    assert.deepEqual(settings(env), before, 'mixed choices changed after a package upgrade');
    // Explicit setup must preserve the public entrypoint too.
    run(publicVp, ['env', 'setup', '--refresh'], root, env);
    assert.equal(fs.readlinkSync(path.join(env.VP_HOME, 'bin/vp')), publicVp);
    console.log('vp follows the public entrypoint while the old package still exists');
    console.log('direct vp, cached Bash vp, and node shims survive removal of the old package');
    console.log('mixed preferences survive a new package path');
  }
}
