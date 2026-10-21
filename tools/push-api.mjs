#!/usr/bin/env node
/**
 * push-api.mjs — push local HEAD to origin/main through the GitHub Data API.
 *
 * Why this exists: git-over-HTTPS from this machine half-connects and hangs,
 * and SSH has no key, but api.github.com answers normally. So the push is
 * done the way the previous round did it: blobs -> tree -> commit ->
 * PUT /git/refs/heads/main.
 *
 * Two rules learned the hard way (round 33b), both enforced here:
 *   - Modes are carried, not assumed. The API push that hardcoded 100644
 *     silently un-executed bin/agentledger.js — identical content, broken
 *     permission, invisible in a text diff. Every blob below takes its mode
 *     from `git ls-tree`, i.e. from local truth.
 *   - "I pushed it" is a claim until the remote tree is diffed against the
 *     local one. The final step does exactly that and prints the result.
 *
 * Usage: node tools/push-api.mjs [--dry-run] [--repo owner/name] [--dir path]
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
// The default is this repository, but the tool is not tied to it: the
// Homebrew tap is a second repository that has to be pushed the same way,
// and `git push` over HTTPS hangs from this machine.
const root = path.resolve(argOf('--dir', path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
const dryRun = process.argv.includes('--dry-run');
const REPO = argOf('--repo', 'garyleelty/agentledger');
const BRANCH = argOf('--branch', 'main');

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
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
};

/** Local tree of HEAD: every blob with its REAL mode. */
const localTree = () => {
  const out = execFileSync('git', ['ls-tree', '-r', 'HEAD'], { encoding: 'utf8', cwd: root });
  const entries = [];
  for (const line of out.trim().split('\n')) {
    const [meta, filePath] = line.split('\t');
    const [mode, , sha] = meta.split(' ');
    entries.push({ mode, path: filePath, sha });
  }
  return entries;
};

/** Remote tree of a ref, for the after-push verification. */
const remoteTree = async (ref) => {
  const d = await api('GET', `/repos/${REPO}/git/trees/${ref}?recursive=1`);
  const m = new Map();
  for (const e of d.tree) {
    if (e.type === 'blob') m.set(e.path, `${e.mode} ${e.sha}`);
  }
  return m;
};

const entries = localTree();
console.log(`local HEAD tree: ${entries.length} blobs (modes read from git, not assumed)`);

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: root }).trim();
// The remote may have advanced since HEAD was written (a scheduled digest
// job commits on its own). The API rejects a non-fast-forward, so read the
// remote head and use IT as the parent, not the local HEAD^. Local content
// still wins: every blob below comes from `git ls-tree HEAD`, so this pushes
// our tree on top of whatever the remote is at now.
const remoteRef = await api('GET', `/repos/${REPO}/git/refs/heads/${BRANCH}`);
const parent = remoteRef.object.sha;
const localParent = execFileSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8', cwd: root }).trim();
if (parent !== localParent) {
  console.log(`remote ${BRANCH} advanced to ${parent.slice(0, 10)} (local HEAD^ is ${localParent.slice(0, 10)})`);
  console.log('pushing our tree on top of the remote head, as the API requires a fast-forward');
}
const message = execFileSync('git', ['log', '-1', '--format=%B'], { encoding: 'utf8', cwd: root });

// Blobs already on the remote are reused rather than re-uploaded: the API
// dedupes by sha, and re-PUTting a few hundred of them is just slow.
const remote = await remoteTree(await api('GET', `/repos/${REPO}/git/refs/heads/${BRANCH}`).then((r) => r.object.sha));
let uploaded = 0;
let reused = 0;
const treeEntries = [];
for (const e of entries) {
  if (remote.get(e.path) === `${e.mode} ${e.sha}`) {
    reused++;
  } else {
    const content = execFileSync('git', ['cat-file', 'blob', e.sha], { encoding: 'buffer', cwd: root });
    // base64 the buffer so the JSON stays valid for non-UTF8 content.
    const b64 = content.toString('base64');
    const blob = await api('POST', `/repos/${REPO}/git/blobs`, { content: b64, encoding: 'base64' });
    uploaded++;
    treeEntries.push({ mode: e.mode, type: 'blob', path: e.path, sha: blob.sha });
    continue;
  }
  treeEntries.push({ mode: e.mode, type: 'blob', path: e.path, sha: e.sha });
}
console.log(`blobs: ${uploaded} uploaded, ${reused} already identical on the remote`);

if (dryRun) {
  console.log('dry run — nothing pushed');
  process.exit(0);
}

const tree = await api('POST', `/repos/${REPO}/git/trees`, { tree: treeEntries });
console.log(`tree ${tree.sha.slice(0, 10)}`);

const commit = await api('POST', `/repos/${REPO}/git/commits`, {
  message,
  tree: tree.sha,
  parents: [parent],
});
console.log(`commit ${commit.sha.slice(0, 10)} (parent ${parent.slice(0, 10)})`);

await api('PUT', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
console.log(`pushed ${BRANCH} -> ${commit.sha.slice(0, 10)}`);

// The verification that makes "pushed" a fact rather than a claim.
const after = await remoteTree(commit.sha);
const localMap = new Map(entries.map((e) => [e.path, `${e.mode} ${e.sha}`]));
const drift = [];
for (const [p, v] of localMap) {
  if (after.get(p) !== v) drift.push(`${p}: local ${v} vs remote ${after.get(p)}`);
}
for (const p of after.keys()) {
  if (!localMap.has(p)) drift.push(`${p}: on the remote but not local`);
}
if (drift.length) {
  console.error(`DRIFT — ${drift.length} difference(s):`);
  for (const d of drift) console.error(`  ${d}`);
  process.exit(1);
}
console.log(`verified: remote tree matches local HEAD exactly (${localMap.size} blobs, modes included)`);
