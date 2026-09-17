import assert from 'node:assert/strict';

function replaceOnce(source, pattern, replacement) {
  assert.equal(
    [...source.matchAll(new RegExp(pattern, 'gm'))].length,
    1,
    `Homebrew formula layout changed: expected one ${pattern}`,
  );
  return source.replace(new RegExp(pattern, 'm'), replacement);
}

/** Adapt only source inputs; keep Homebrew's build, install, and test methods. */
export function prepareFormula(source, { url, sha256, version, revision, upstream }) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  assert.match(sha256, /^[a-f0-9]{64}$/);
  assert(Number.isSafeInteger(revision) && revision > 0);
  assert(
    !/\bpatch\b|^__END__|^  stable do/m.test(source),
    'Review the formula adapter before applying release patches or a stable block to PR source',
  );
  let formula = replaceOnce(source, '^  url "[^"]+"$', `  url ${JSON.stringify(url)}`);
  formula = replaceOnce(formula, '^  sha256 "[a-f0-9]+"$', `  sha256 "${sha256}"`);
  formula = formula.replace(/^  (?:version|revision) .*\n/gm, '');
  formula = replaceOnce(
    formula,
    '^  license (.+)$',
    `  version "${version}"\n  revision ${revision}\n  license $1`,
  );
  // Published bottles contain release code. Both revisions must build the tested source.
  formula = formula.replace(/\n  bottle do\n[\s\S]*?\n  end\n/, '\n');
  for (const name of ['rolldown', 'vite']) {
    const { repo, hash } = upstream[name];
    assert.match(repo, /^https:\/\/github\.com\/[\w-]+\/[\w.-]+\.git$/);
    assert.match(hash, /^[a-f0-9]{40}$/);
    formula = replaceOnce(
      formula,
      `(^  resource "${name}" do\\n)    url [^\\n]+\\n        revision: "[a-f0-9]+"\\n    version "[a-f0-9]+"`,
      `$1    url "${repo}",\n        revision: "${hash}"\n    version "${hash}"`,
    );
  }
  return formula;
}
