import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prepareFormula } from '../homebrew-formula.mjs';

const official = `class VitePlus < Formula
  url "https://example.com/v0.1.0.tar.gz"
  sha256 "${'a'.repeat(64)}"
  license "MIT"

  bottle do
    sha256 arm64_tahoe: "published-bottle"
  end

  resource "rolldown" do
    url "https://github.com/rolldown/rolldown.git",
        revision: "${'1'.repeat(40)}"
    version "${'1'.repeat(40)}"
  end

  resource "vite" do
    url "https://github.com/vitejs/vite.git",
        revision: "${'2'.repeat(40)}"
    version "${'2'.repeat(40)}"
  end

  def install
    system "just", "build"
    bin.install "vp"
  end

  test do
    system bin/"vp", "--version"
  end
end
`;

const inputs = {
  url: 'file:///tmp/source%20archive.tar.gz',
  sha256: 'b'.repeat(64),
  version: '0.3.2',
  revision: 1,
  upstream: {
    rolldown: { repo: 'https://github.com/rolldown/rolldown.git', hash: '3'.repeat(40) },
    vite: { repo: 'https://github.com/vitejs/vite.git', hash: '4'.repeat(40) },
  },
};

test('updates source inputs and preserves the official installation and tests', () => {
  const formula = prepareFormula(official, inputs);
  assert(formula.includes(`url "${inputs.url}"`));
  assert(formula.includes(`sha256 "${inputs.sha256}"`));
  assert.match(formula, /version "0.3.2"\n  revision 1/);
  for (const { hash } of Object.values(inputs.upstream)) {
    assert(formula.includes(`revision: "${hash}"\n    version "${hash}"`));
  }
  assert.doesNotMatch(formula, /bottle do|published-bottle|example.com/);
  assert.equal(
    formula.slice(formula.indexOf('  def install')),
    official.slice(official.indexOf('  def install')),
  );
});

test('replaces an existing formula revision for a real Homebrew upgrade', () => {
  const withRevision = official.replace('  license', '  version "0.1.0"\n  revision 7\n  license');
  const first = prepareFormula(withRevision, inputs);
  const second = prepareFormula(withRevision, { ...inputs, revision: 2 });
  assert.equal(second, first.replace('  revision 1', '  revision 2'));
});

test('rejects formula changes that require a new source adapter', () => {
  assert.throws(
    () => prepareFormula(official.replace('  url', '    url'), inputs),
    /layout changed/,
  );
  assert.throws(
    () => prepareFormula(official.replace('  resource "vite"', '  resource "renamed"'), inputs),
    /layout changed/,
  );
  assert.throws(() => prepareFormula(`${official}\n__END__\npatch`, inputs), /release patches/);
  assert.throws(() => prepareFormula(official, { ...inputs, version: 'main"' }));
});
