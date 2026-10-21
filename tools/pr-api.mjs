#!/usr/bin/env node
/**
 * pr-api.mjs — open a pull request in another repository through the
 * GitHub Data API, without a git push.
 *
 * Why: git-over-HTTPS from this machine half-connects and hangs, and SSH
 * has no key, but api.github.com answers normally. So the branch is built
 * the way the push tool builds one — blob -> tree -> commit -> ref — and
 * the pull request is opened with the API.
 *
 * The change is given as a file on disk and the path it replaces. Every
 * other file in the repository is left alone: the tree is based on the
 * remote head and carries only the changed path.
 *
 * Usage:
 *   node tools/pr-api.mjs --repo owner/name --branch name \
 *     --file path=local/path --title "..." --body "..." [--base main]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const REPO = argOf('--repo');
const BRANCH = argOf('--branch');
const TITLE = argOf('--title');
const BODY = argOf('--body');
const BASE = argOf('--base', 'main');
const DRY = process.argv.includes('--dry-run');
// The repository the BRANCH is written to. It is the same as the target
// when you have push access, and your FORK when you do not — the Data API
// refuses to write a blob into a repository you cannot push to (404), so
// a pull request to someone else's list has to be built in a fork and
// opened from the fork's branch.
const WRITE_REPO = argOf('--write-repo', REPO);
const FILES = process.argv
  .filter((_, i) => process.argv[i - 1] === '--file')
  .map((pair) => {
    const eq = pair.indexOf('=');
    return { path: pair.slice(0, eq), local: pair.slice(eq + 1) };
  });

if (!REPO || !BRANCH || !TITLE || !FILES.length) {
  console.error('usage: pr-api.mjs --repo owner/name --branch name --title "..." --file path=local --body "..."');
  process.exit(2);
}

const TOKEN = execFileSync('security', ['find-internet-password', '-s', 'github.com', '-w'], {
  encoding: 'utf8',
}).trim();
if (!TOKEN.startsWith('gh')) throw new Error('no github token in keychain');

const api = async (method, url, body) => {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'agentledger-pr-api',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const d = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${d.message || text.slice(0, 200)}`);
  return d;
};

const baseRef = await api('GET', `/repos/${WRITE_REPO}/git/ref/heads/${BASE}`);
const base = baseRef.object.sha;

const treeEntries = [];
for (const f of FILES) {
  const content = readFileSync(f.local);
  const blob = await api('POST', `/repos/${WRITE_REPO}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`blob  ${f.path} -> ${blob.sha.slice(0, 10)}`);
}

const tree = await api('POST', `/repos/${WRITE_REPO}/git/trees`, { base_tree: base, tree: treeEntries });
const commit = await api('POST', `/repos/${WRITE_REPO}/git/commits`, {
  message: TITLE,
  tree: tree.sha,
  parents: [base],
});
console.log(`commit ${commit.sha.slice(0, 10)} (base ${base.slice(0, 10)})`);

if (DRY) {
  console.log('dry run — nothing pushed');
  process.exit(0);
}

// The branch: create it, or force it if a previous attempt left one.
try {
  await api('POST', `/repos/${WRITE_REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  console.log(`branch ${BRANCH} created`);
} catch (err) {
  await api('PATCH', `/repos/${WRITE_REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true });
  console.log(`branch ${BRANCH} updated`);
}

// The pull request's head is `owner:branch` when the branch lives in a
// fork, and the plain branch name when it lives in the target itself.
const head = WRITE_REPO === REPO ? BRANCH : `${WRITE_REPO.split('/')[0]}:${BRANCH}`;
const pr = await api('POST', `/repos/${REPO}/pulls`, {
  title: TITLE,
  body: BODY,
  head,
  base: BASE,
});
console.log(`pull request #${pr.number}: ${pr.html_url}`);
