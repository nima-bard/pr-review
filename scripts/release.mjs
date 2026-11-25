// Builds a release of PR Review into dist/release-<version>/: the app for Apple silicon Macs
// (pr-review-<version>-arm64.dmg), the browser extension as a zip, and SHA256SUMS.txt. It typechecks and runs the
// unit and end-to-end tests first (--skip-tests skips them).
//
// With --publish it then creates a draft GitHub release v<version> with those files, to look over and publish on
// GitHub. That needs the GitHub CLI, a clean working tree and the current commit pushed; it checks before building.
//
//   npm run release
//   npm run release:publish
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const options = new Set(['--publish', '--skip-tests']);
const args = process.argv.slice(2);
for (const a of args) if (!options.has(a)) fail(`Unknown option ${a}. Options: ${[...options].join(', ')}.`);
const publish = args.includes('--publish');
const skipTests = args.includes('--skip-tests');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tag = `v${version}`;
const out = join(root, 'dist', `release-${version}`);

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function step(title) {
  console.log(`\n▸ ${title}`);
}

/** Runs a command in the repo; with `capture`, returns its output instead of showing it. Stops the release if it fails. */
function run(cmd, cmdArgs, { capture = false, env = {} } = {}) {
  try {
    const output = execFileSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', env: { ...process.env, ...env } });
    return capture ? output.trim() : '';
  } catch {
    fail(`"${cmd} ${cmdArgs.join(' ')}" failed.`);
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

if (process.platform !== 'darwin') fail('The release is a macOS app: build it on a Mac.');

let head = '';
if (publish) {
  // Everything the GitHub release needs, before the long build.
  step('Checking git and GitHub');
  if (spawnSync('gh', ['--version']).status !== 0) fail('Publishing needs the GitHub CLI (brew install gh, then gh auth login).');
  if (run('git', ['status', '--porcelain'], { capture: true }) !== '') fail('There are uncommitted changes. Commit them first: the release is built from, and tagged at, the current commit.');
  head = run('git', ['rev-parse', 'HEAD'], { capture: true });
  run('git', ['fetch', '--quiet']);
  if (run('git', ['branch', '-r', '--contains', head], { capture: true }) === '') fail(`The current commit ${head.slice(0, 7)} isn't pushed yet. Push it first: the release tag points at it.`);
  if (spawnSync('gh', ['release', 'view', tag], { cwd: root, stdio: 'ignore' }).status === 0) fail(`There's a release ${tag} already. Raise "version" in package.json for a new one.`);
}

if (skipTests) console.log('\n(Skipping the checks and tests.)');
else {
  step('Typecheck');
  run('npm', ['run', 'typecheck']);
  step('Unit tests');
  run('npm', ['test']);
  step('End-to-end test');
  run('npm', ['run', 'e2e'], { env: { PR_REVIEW_HIDDEN_WINDOWS: '1' } });
}

step('Building the app');
run('npx', ['electron-vite', 'build']);
run('npx', ['electron-builder', '--mac', '--arm64', '--publish', 'never']);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const dmg = join(root, 'dist', `pr-review-${version}-arm64.dmg`);
if (!existsSync(dmg)) fail(`The build didn't produce ${relative(root, dmg)}.`);
copyFileSync(dmg, join(out, basename(dmg)));

step('Packing the browser extension');
const extension = join(out, `pr-review-browser-extension-${version}.zip`);
// --keepParent: the zip holds a browser-extension folder, which is what "Load unpacked" wants.
run('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--keepParent', 'browser-extension', extension]);

step('Checksums');
const files = [basename(dmg), basename(extension)];
writeFileSync(join(out, 'SHA256SUMS.txt'), `${files.map((f) => `${sha256(join(out, f))}  ${f}`).join('\n')}\n`);
for (const f of [...files, 'SHA256SUMS.txt']) console.log(`  ${relative(root, join(out, f))}`);

if (!publish) {
  console.log(`\nDone. "npm run release:publish" also creates a draft GitHub release ${tag} with these files.`);
  process.exit(0);
}

step(`Creating the draft release ${tag}`);
const notes = `## Install

1. Download \`${basename(dmg)}\` (Macs with Apple silicon), open it and drag **PR Review** into Applications.
2. The app isn't notarized by Apple, so macOS blocks the first launch. Open it once, then click **Open Anyway** in **System Settings › Privacy & Security**. Or run \`xattr -dr com.apple.quarantine "/Applications/PR Review.app"\` in Terminal.
3. The first launch walks you through the setup: GitHub sign-in (through the GitHub CLI), where your clones are, worktrees and editor.

Optional: to open GitHub pull request links in the app, unzip \`${basename(extension)}\` and load it in Chrome (chrome://extensions › Developer mode › Load unpacked). The app ships it too: Settings › Open pull requests from GitHub.

Checksums are in \`SHA256SUMS.txt\`.
`;
const url = run(
  'gh',
  ['release', 'create', tag, '--draft', '--title', `PR Review ${version}`, '--notes', notes, '--generate-notes', '--target', head, ...files.map((f) => join(out, f)), join(out, 'SHA256SUMS.txt')],
  { capture: true },
);
console.log(`\nDraft release: ${url}\nLook over the notes and files on GitHub, then publish it.`);
