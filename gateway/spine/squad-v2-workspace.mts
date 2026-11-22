import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { SquadArtifactPreview, SquadRepoBinding, SquadWorkspaceDelta } from './squad-v2-contracts.mjs';
const exec = promisify(execFile);
async function gitOutput(cwd: string, args: string[]) { return (await exec('git', ['-C', cwd, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout; }
export async function git(cwd: string, ...args: string[]) { return (await gitOutput(cwd, args)).trim(); }
export function safeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new Error('Invalid squad/slot identity.');
  return value;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const repositoryRef = /^[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,254}$/;
export interface SquadRepository { key: string; source: string; directory: string; remote: boolean }

export function parseRepository(value: unknown): SquadRepoBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid slot repo.');
  const repo = value as SquadRepoBinding;
  const validRef = (ref: unknown) => typeof ref === 'string' && repositoryRef.test(ref) && !ref.includes('..') &&
    ref.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
  if (Object.keys(repo).some(key => !['source', 'baseRef', 'branch', 'submodules'].includes(key)) ||
      typeof repo.source !== 'string' || !repo.source.trim() || repo.source.length > 4096 || /[\u0000-\u001f\u007f]/.test(repo.source) || repo.source.startsWith('-') ||
      repo.baseRef !== undefined && !validRef(repo.baseRef) || repo.branch !== undefined && !validRef(repo.branch) ||
      repo.submodules !== undefined && typeof repo.submodules !== 'boolean') throw new Error('Invalid slot repo.');
  return { source: repo.source, ...(repo.baseRef !== undefined ? { baseRef: repo.baseRef } : {}),
    ...(repo.branch !== undefined ? { branch: repo.branch } : {}), ...(repo.submodules !== undefined ? { submodules: repo.submodules } : {}) };
}

function remoteSource(source: string) {
  if (/^git@[\w.-]+:[^\s\\]+$/.test(source)) return source;
  if (!/^[a-z][a-z\d+.-]*:/i.test(source) || /^[a-z]:[\\/]/i.test(source)) return;
  if (!/^(?:https?|ssh|file):\/\//i.test(source) || source.includes('\\')) throw new Error('Unsupported Git repository URL.');
  const url = new URL(source);
  if (url.search || url.hash || url.password || (url.protocol === 'file:' ? url.hostname !== '' && url.hostname !== 'localhost' : !url.hostname) ||
      (['http:', 'https:'].includes(url.protocol) && url.username)) throw new Error('Invalid Git repository URL.');
  return url.protocol === 'file:' ? new URL(url.href).href : source;
}

const repoCacheDir = (home: string, source: string) => path.join(home, '.mycodex', '.repo-cache', `${hash(source)}.git`);
export function repositoryDirectory(home: string, source: string) {
  const remote = remoteSource(source);
  return remote ? repoCacheDir(home, remote) : source;
}

/** Canonical identity is the Git common directory for local linked checkouts,
 * or the exact approved transport address for a managed bare clone. */
export async function bindRepository(home: string, anchor: string, source: string): Promise<SquadRepository> {
  const remote = remoteSource(source);
  if (remote) return { key: `remote-${hash(remote)}`, source: remote, directory: repoCacheDir(home, remote), remote: true };
  const directory = await fs.realpath(path.resolve(anchor, source));
  const common = await fs.realpath(await git(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const anchorCommon = await git(anchor, 'rev-parse', '--path-format=absolute', '--git-common-dir').then(p => fs.realpath(p)).catch(() => undefined);
  const root = await git(directory, 'rev-parse', '--show-toplevel').catch(() => common);
  return { key: common === anchorCommon ? 'main' : `local-${hash(common)}`, source: root, directory: root, remote: false };
}

async function remoteGit(cwd: string, ...args: string[]) {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch { throw new Error(args.includes('submodule') ? 'Could not initialize the requested Squad submodules.' : 'Could not clone or fetch the requested Squad repository/ref.'); }
}

async function resolveBase(cwd: string, ref: string) {
  return git(cwd, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
}

export async function repositoryBase(repo: SquadRepository, ref = 'HEAD'): Promise<string> {
  if (!repo.remote) return resolveBase(repo.directory, ref);
  const root = path.dirname(repo.directory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  let published = false;
  if (!(await fs.lstat(repo.directory).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }))) {
    const staging = await fs.mkdtemp(path.join(root, '.clone-'));
    try {
      // --no-local also applies the requested filter for file:// fixtures.
      await remoteGit(root, 'clone', '--bare', '--filter=blob:none', '--no-local', '--', repo.source, staging);
      try { await fs.rename(staging, repo.directory); published = true; }
      catch (error) {
        if (!(await fs.lstat(repo.directory).catch(() => undefined))?.isDirectory()) throw error;
      }
    } finally { if (!published) await fs.rm(staging, { recursive: true, force: true }); }
  }
  if (!(await fs.lstat(repo.directory)).isDirectory() || await git(repo.directory, 'rev-parse', '--is-bare-repository') !== 'true' ||
      await git(repo.directory, 'config', '--get', 'remote.origin.url') !== repo.source) throw new Error('Invalid Squad repository cache.');
  if (published) {
    const base = await resolveBase(repo.directory, ref).catch(() => undefined);
    if (base) return base;
  }
  // Fetch into a private ref. Updating origin's heads could move a live slot
  // branch, and FETCH_HEAD is shared with other concurrent readers.
  const fetched = `refs/mycodex/fetch/${randomUUID()}`;
  try {
    await remoteGit(repo.directory, 'fetch', '--no-tags', '--no-write-fetch-head', '--filter=blob:none', '--refmap=', '--', 'origin', `+${ref}:${fetched}`);
    return await resolveBase(repo.directory, fetched);
  } finally { await git(repo.directory, 'update-ref', '-d', fetched).catch(() => {}); }
}

export async function isolatedWorkspace(cwd: string, directory: string, branch: string, base: string, options: { managedIgnores?: boolean; submodules?: boolean } = {}) {
  const { managedIgnores = true, submodules = false } = options;
  await git(cwd, 'check-ref-format', '--branch', branch);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await git(cwd, 'worktree', 'add', '-b', branch, directory, base);
  try {
    if (managedIgnores) {
      const dependencies = path.join(cwd, 'node_modules');
      try { await fs.stat(dependencies); await fs.symlink(dependencies, path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const exclude = await git(directory, 'rev-parse', '--git-path', 'info/exclude');
      const file = path.resolve(directory, exclude); await fs.mkdir(path.dirname(file), { recursive: true });
      const existing = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      const entries = ['/.mycodex/', '/node_modules'].filter(entry => !existing.split(/\r?\n/).includes(entry));
      if (entries.length) await fs.appendFile(file, '\n' + entries.join('\n') + '\n');
    }
    if (submodules) {
      const origin = await git(directory, 'remote', 'get-url', 'origin').catch(() => cwd);
      await remoteGit(directory, '-c', `remote.origin.url=${origin}`, 'submodule', 'update', '--init', '--recursive');
    }
    return { branch, worktreePath: directory, baseSha: await git(directory, 'rev-parse', 'HEAD') };
  } catch (error) {
    // Only retire the worktree/branch just created by this call, before a
    // worker can own it. Never clean an existing caller-owned checkout.
    await git(cwd, 'worktree', 'remove', '--force', directory).catch(() => {});
    await git(cwd, 'branch', '-D', branch).catch(() => {});
    throw error;
  }
}
function pathMatcher(patterns: string[]) {
  const rules = patterns.map(value => {
    const pattern = value.replace(/^\.\//, '').replace(/\/$/, '');
    // Standard glob matching skips leading dots. Red lines expressed as
    // wildcard paths should cover dotfiles and dot-directories as well.
    const wildcard = pattern.split(/(\*\*\/|\*\*|\*|\?)/).map(part => {
      switch (part) {
        case '**/': return '(?:[^/]+/)*';
        case '**': return '.*';
        case '*': return '[^/]*';
        case '?': return '[^/]';
        default: return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
    }).join('');
    return { pattern, includingDots: new RegExp(`^${wildcard}$`, 's') };
  });
  return (file: string) => rules.some(({ pattern, includingDots }) =>
    file === pattern || file.startsWith(pattern + '/') || includingDots.test(file) || !pattern.startsWith('!') && path.posix.matchesGlob(file, pattern));
}
async function workspaceStatus(cwd: string, ignored = false) {
  const raw = await gitOutput(cwd, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=none', ...(ignored ? ['--ignored=matching'] : [])]);
  return raw.split('\0').filter(Boolean).map(entry => ({ status: entry.slice(0, 2), file: entry.slice(3) }));
}
async function dirtyChanges(cwd: string) {
  const entries = await workspaceStatus(cwd);
  const dependency = await fs.lstat(path.join(cwd, 'node_modules')).catch(() => undefined);
  return entries.filter(({ file }) => file !== '.mycodex' && !file.startsWith('.mycodex/') &&
    !(file === 'node_modules' && dependency?.isSymbolicLink()));
}
export async function workspaceDelta(cwd: string, base: string, touches: string[] = [], forbid: string[] = []): Promise<SquadWorkspaceDelta> {
  const range = `${base}..HEAD`;
  const [headSha, log, diff, dirty] = await Promise.all([
    git(cwd, 'rev-parse', 'HEAD'), git(cwd, 'log', '--format=%H%x09%s', range),
    gitOutput(cwd, ['diff', '--raw', '--numstat', '-z', '--no-renames', base, '--']), dirtyChanges(cwd),
  ]);
  const commits = log.split('\n').filter(Boolean).map(line => { const [sha, ...subject] = line.split('\t'); return { sha, subject: subject.join('\t') }; });
  const changed: SquadWorkspaceDelta['changed'] = [];
  const rows = diff.split('\0');
  const statuses = new Map<string, 'A' | 'M' | 'D'>();
  let i = 0;
  for (; rows[i]?.startsWith(':'); i += 2) {
    const code = rows[i].at(-1);
    statuses.set(rows[i + 1], code === 'A' || code === 'D' ? code : 'M');
  }
  for (const row of rows.slice(i).filter(Boolean)) {
    const [add, del, ...name] = row.split('\t'); const file = name.join('\t');
    changed.push({ path: file, status: statuses.get(file) ?? 'M', add: Number(add) || 0, del: Number(del) || 0 });
  }
  for (const { file, status } of dirty) {
    if (status !== '??') continue;
    const target = path.join(cwd, file);
    const stat = await fs.lstat(target).catch(() => undefined);
    if (!stat) continue;
    const text = stat.isFile() ? await fs.readFile(target, 'utf8').catch(() => '') : '';
    changed.push({ path: file, status: 'A', add: text.split('\n').length - 1, del: 0 });
  }
  const committed = forbid.length && commits.length ? (await gitOutput(cwd, [
    'log', '--format=', '--name-only', '-z', '--no-renames', '--diff-merges=first-parent', range,
  ])).split('\0').filter(Boolean) : [];
  const forbiddenPaths = new Set([...changed.map(c => c.path), ...dirty.map(c => c.file), ...committed]);
  const touched = pathMatcher(touches), forbidden = pathMatcher(forbid);
  return { baseSha: base, headSha, commits, changed, dirtyCount: new Set(dirty.map(c => c.file)).size,
    outsideTouches: touches.length ? changed.filter(c => !touched(c.path)).map(c => c.path) : [],
    forbidViolations: [...forbiddenPaths].filter(forbidden).sort() };
}

async function archivedRelay(directory: string, archived: Record<string, string | undefined>) {
  if (!(await fs.lstat(directory)).isDirectory()) return;
  const files = await fs.readdir(directory, { withFileTypes: true });
  for (const file of files) {
    if (!file.isFile() || archived[file.name] === undefined || archived[file.name] !== await fs.readFile(path.join(directory, file.name), 'utf8')) return;
  }
  return files.map(file => file.name);
}

export async function removeScratchWorkspace(directory: string, archived: Record<string, string | undefined>) {
  try {
    if (!(await fs.lstat(directory)).isDirectory()) return false;
    const entries = await fs.readdir(directory);
    if (entries.some(name => name !== '.mycodex')) return false;
    if (entries.includes('.mycodex')) {
      const relay = path.join(directory, '.mycodex');
      const files = await archivedRelay(relay, archived);
      if (!files) return false;
      for (const file of files) {
        await fs.unlink(path.join(relay, file));
      }
      await fs.rmdir(relay);
    }
    await fs.rmdir(directory);
    return true;
  } catch { return false; }
}

async function initializedSubmodules(cwd: string, moduleRoot: string): Promise<string[]> {
  const root = await fs.realpath(cwd);
  const index = await gitOutput(cwd, ['ls-files', '--stage', '-z']);
  const initialized: string[] = [];
  for (const entry of index.split('\0')) {
    const gitlink = /^160000 [a-f0-9]+ 0\t([\s\S]+)$/.exec(entry);
    if (!gitlink) continue;
    const relative = gitlink[1], child = path.join(root, relative);
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Invalid submodule path.');
    const directory = await fs.lstat(child).catch(error => { if (error.code === 'ENOENT') return; throw error; });
    if (!directory) continue;
    if (!directory.isDirectory() || await fs.realpath(child) !== child) throw new Error('Changed submodule checkout.');
    const marker = await fs.lstat(path.join(child, '.git')).catch(error => { if (error.code === 'ENOENT') return; throw error; });
    if (!marker && !(await fs.readdir(child)).length) continue;
    if (!marker?.isFile()) throw new Error('Submodule contains local changes.');
    const admin = await fs.realpath(await git(child, 'rev-parse', '--absolute-git-dir'));
    if (!admin.startsWith(moduleRoot + path.sep) || (await workspaceStatus(child, true)).length) throw new Error('Submodule contains local changes.');
    await initializedSubmodules(child, moduleRoot);
    initialized.push(relative);
  }
  return initialized;
}

async function removeWithSubmoduleArchive(directory: string, remove: () => Promise<unknown>) {
  const modules = path.join(await git(directory, 'rev-parse', '--absolute-git-dir'), 'modules');
  const store = await fs.lstat(modules).catch(error => { if (error.code === 'ENOENT') return; throw error; });
  const checkouts = await initializedSubmodules(directory, store ? await fs.realpath(modules) : modules);
  if (!store && !checkouts.length) { await remove(); return; }
  if (!store?.isDirectory()) throw new Error('Submodule object store cannot be safely archived.');
  // Unforced worktree removal rejects even clean initialized submodules.
  // Keep their Git objects, stash/branch refs and checkout files together.
  const archive = await fs.mkdtemp(path.join(path.dirname(directory), '.submodules-'));
  const moved: Array<{ from: string; to: string }> = [];
  try {
    await fs.writeFile(path.join(archive, 'worktree.json'), JSON.stringify({ directory, checkouts }) + '\n', { mode: 0o600 });
    for (const file of checkouts) {
      const from = path.join(directory, file), to = path.join(archive, 'checkouts', file);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to); moved.push({ from, to });
      await fs.mkdir(from);
    }
    const to = path.join(archive, 'modules');
    await fs.rename(modules, to); moved.push({ from: modules, to });
    await remove();
  } catch (error) {
    let restored = true;
    for (const { from, to } of moved.reverse()) {
      try {
        if (from !== modules) await fs.rmdir(from).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
        await fs.rename(to, from);
      } catch { restored = false; }
    }
    if (restored) await fs.rm(archive, { recursive: true, force: true });
    throw error;
  }
}

/** Git's ordinary removal protects tracked and untracked changes. Check ignored
 * material separately because Git would otherwise discard it silently. */
export async function removeSquadWorkspace(cwd: string, directory: string, branch: string, archived: Record<string, string | undefined>): Promise<boolean> {
  try {
    if (await git(directory, 'symbolic-ref', 'HEAD') !== `refs/heads/${branch}`) return false;
    const status = await workspaceStatus(directory, true);
    let relayChecked = false;
    for (const { status: state, file } of status) {
      if (state !== '!!' && state !== '??') return false;
      if (file.startsWith('.mycodex/')) {
        if (!relayChecked && !await archivedRelay(path.join(directory, '.mycodex'), archived)) return false;
        relayChecked = true;
      } else if (file === 'node_modules') {
        const dependencies = path.join(directory, 'node_modules');
        if (!(await fs.lstat(dependencies)).isSymbolicLink() || await fs.realpath(dependencies) !== await fs.realpath(path.join(cwd, 'node_modules'))) return false;
      } else {
        return false;
      }
    }
    if (status.some(entry => entry.status === '??')) {
      // A per-command exclude keeps the external repository's config intact.
      const exclusions = path.join(path.dirname(directory), `.cleanup-${randomUUID()}.gitignore`);
      await fs.writeFile(exclusions, '/.mycodex/\n/node_modules\n', { flag: 'wx', mode: 0o600 });
      try {
        await removeWithSubmoduleArchive(directory, () => git(cwd, '-c', `core.excludesFile=${exclusions}`, 'worktree', 'remove', directory));
      }
      finally { await fs.unlink(exclusions); }
    } else await removeWithSubmoduleArchive(directory, () => git(cwd, 'worktree', 'remove', directory));
    try {
      await git(cwd, 'branch', '-d', '--', branch);
    } catch {
      // Unmerged tips remain reachable through a private ref. Git still
      // checks that the branch is not checked out or ahead of the saved tip.
      const archiveRef = `refs/mycodex/archive/${branch}`;
      try {
        const tip = await git(cwd, 'rev-parse', '--verify', `refs/heads/${branch}`);
        await git(cwd, 'update-ref', archiveRef, tip, '').catch(() => {});
        await git(cwd, '-c', `branch.${branch}.remote=.`, '-c', `branch.${branch}.merge=${archiveRef}`, 'branch', '-d', '--', branch);
      } catch { /* Preserve the branch if its tip could not be safely archived. */ }
    }
    return true;
  } catch { return false; }
}

/** The checker runs in its own Node process and shares the shipped receipt
 * parser and Git accounting with the gateway. It needs no npm packages. */
export function deliveryCheckScript(cwd: string, baseSha: string | null | undefined, touches: string[], forbid: string[] = []) {
  const stateModule = new URL('./squad-v2-state.mjs', import.meta.url);
  return `import fs from "node:fs/promises";
import { constants } from "node:fs";
import { parseResult } from ${JSON.stringify(stateModule.href)};
import { workspaceDelta } from ${JSON.stringify(import.meta.url)};

const resultFile = new URL("./result.md", import.meta.url);
const { cwd, baseSha, touches, forbid } = ${JSON.stringify({ cwd, baseSha: baseSha ?? null, touches, forbid })};
const errors = [];
try {
  const file = await fs.open(resultFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("result.md must be a regular file");
    parseResult(await file.readFile("utf8"), stat.mtimeMs);
  } finally { await file.close(); }
} catch (error) { errors.push("result.md: " + (error.code === "ENOENT" ? "missing" : error.message)); }
if (baseSha) {
  try {
    const delta = await workspaceDelta(cwd, baseSha, touches, forbid);
    if (delta.dirtyCount) errors.push("Git worktree has " + delta.dirtyCount + " uncommitted or untracked path(s)");
    if (delta.forbidViolations.length) errors.push("Forbidden paths: " + delta.forbidViolations.join(", "));
  } catch (error) { errors.push("Git workspace check failed: " + error.message); }
}
if (errors.length) {
  for (const issue of errors) console.error(issue);
  process.exitCode = 1;
} else console.log(baseSha ? "Delivery ready: valid receipt, clean Git worktree, no forbidden paths" : "Delivery ready: valid receipt");
`;
}

type Origin = { root: string; repository: string; github: boolean };
const origins = new Map<string, { expires: number; pending: Promise<Origin | undefined> }>();
function repositoryOrigin(cwd: string): Promise<Origin | undefined> {
  const now = Date.now(), cached = origins.get(cwd);
  if (cached && cached.expires > now) return cached.pending;
  const pending = git(cwd, 'remote', 'get-url', 'origin').then(remote => {
    const scp = remote.match(/^git@([a-z\d.-]+):([^\s]+)$/i);
    const ssh = remote.match(/^ssh:\/\/git@([a-z\d.-]+)(?::\d+)?\/([^\s]+)$/i);
    const hostPath = scp ?? ssh;
    const address = hostPath ? `https://${hostPath[1]}/${hostPath[2]}` : remote;
    if (!/^https?:\/\//i.test(address) || /[\u0000-\u001f\u007f\\]/.test(address)) return;
    const url = new URL(address);
    const repository = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..')) return;
    return { root: url.origin, repository, github: /(?:^|\.)github(?:\.|$)/i.test(url.hostname) };
  }).catch(() => undefined);
  origins.delete(cwd);
  origins.set(cwd, { expires: now + 60_000, pending });
  if (origins.size > 256) origins.delete(origins.keys().next().value!);
  return pending;
}

export async function resolveDeliveryHref(cwd: string, fallback: string, kind: 'mr' | 'issue', label: string, target?: string) {
  const marker = kind === 'mr' ? '!' : '#';
  const reference = [target, label].map(text => text?.match(/^(?:([\w.-]+(?:\/[\w.-]+)*)\s*)?([!#])([1-9]\d*)$/)).find(match => match?.[2] === marker);
  if (!reference) return;
  let preferred = cwd;
  if (target && target !== reference[0] && !target.includes('\0') && !target.split(/[\\/]/).includes('..')) {
    const candidate = path.resolve(cwd, target);
    const stat = await fs.lstat(candidate).catch(() => undefined);
    if (stat?.isDirectory()) preferred = candidate;
    if (stat?.isFile()) preferred = path.dirname(candidate);
  }
  const origin = await repositoryOrigin(preferred) ?? (preferred !== cwd ? await repositoryOrigin(cwd) : undefined) ??
    (fallback !== cwd && fallback !== preferred ? await repositoryOrigin(fallback) : undefined);
  if (!origin) return;
  const requested = reference[1];
  if (requested?.split('/').some(part => part === '.' || part === '..')) return;
  const repository = !requested || requested === origin.repository || requested === origin.repository.split('/').at(-1) ||
    origin.repository.endsWith('/' + requested) ? origin.repository : requested;
  if (!repository.includes('/')) return;
  const route = origin.github ? (kind === 'mr' ? 'pull' : 'issues') : (kind === 'mr' ? '-/merge_requests' : '-/issues');
  return `${origin.root}/${repository}/${route}/${reference[3]}`;
}

const PREVIEW_LIMIT = 256 * 1024;
export const commitRef = /^[a-f0-9]{4,64}$/i;
const normalizePlatformRoot = (resolved: string) =>
  process.platform === 'darwin' ? resolved.replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1') : resolved;
export function extractCommitToken(label: string, target?: string): { shaRef: string; repoTarget?: string } | undefined {
  if (target && commitRef.test(target)) return { shaRef: target };
  const labelSha = label.trim().match(/^(?:[\w./-]+@)?([a-f0-9]{7,64})$/i)?.[1];
  if (!labelSha) return undefined;
  return target && target !== label.trim() ? { shaRef: labelSha, repoTarget: target } : { shaRef: labelSha };
}
export async function verifiedRepositoryDir(cwd: string, target: string): Promise<string> {
  if (!target || target.includes('\0') || target.split(/[\\/]/).includes('..')) throw new Error('Invalid repository path.');
  const resolved = path.isAbsolute(target) ? normalizePlatformRoot(path.resolve(target)) : path.resolve(await fs.realpath(cwd), target);
  const actual = await fs.realpath(resolved);
  if (actual !== resolved || !(await fs.lstat(resolved)).isDirectory()) throw new Error('Symlink or non-directory repository is denied.');
  return resolved;
}
const localGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ![
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
].includes(key)));
Object.assign(localGitEnv, { GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' });

export async function resolveLocalCommit(cwd: string, ref: string): Promise<string> {
  if (!commitRef.test(ref)) throw new Error('Invalid commit identity.');
  try {
    const hex = ref.toLowerCase();
    const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--verify', '--end-of-options', `${hex}^{commit}`], { env: localGitEnv, timeout: 8000 });
    const sha = stdout.trim();
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) && sha.startsWith(hex)) return sha;
  } catch { /* The object must already exist in the bound repository. */ }
  throw new Error('Commit is unavailable in this slot repository.');
}

function decodePreview(data: Buffer, truncated: boolean) {
  // When truncated, discard an incomplete UTF-8 suffix.
  const text = new TextDecoder().decode(data, { stream: truncated });
  const encoded = Buffer.from(text);
  return encoded.length <= PREVIEW_LIMIT ? { content: text, truncated } :
    { content: new TextDecoder().decode(encoded.subarray(0, PREVIEW_LIMIT), { stream: true }), truncated: true };
}

export async function previewCommit(cwd: string, ref: string): Promise<SquadArtifactPreview> {
  const sha = await resolveLocalCommit(cwd, ref);
  const args = ['-C', cwd, 'show', '--stat', '--patch', '--no-color', '--no-ext-diff', '--no-textconv', '--no-notes', '--no-show-signature',
    '--submodule=short', '--format=medium', '-U4', sha, '--'];
  const child = spawn('git', args, { env: localGitEnv, stdio: ['ignore', 'pipe', 'ignore'], signal: AbortSignal.timeout(8000) });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  // Wait on the stream and process together so both errors are observed.
  let size = 0, truncated = false;
  const chunks: Buffer[] = [];
  const collect = async () => {
    for await (const chunk of child.stdout) {
      chunks.push(chunk.subarray(0, PREVIEW_LIMIT - size));
      size += chunk.length;
      if (size > PREVIEW_LIMIT) { truncated = true; child.kill(); break; }
    }
  };
  try {
    const [code] = await Promise.all([exit, collect()]);
    if (code !== 0 && !truncated) throw new Error('Git show failed.');
  } catch { throw new Error('Commit preview is unavailable.'); }
  return { kind: 'commit', title: sha.slice(0, 12), ...decodePreview(Buffer.concat(chunks), truncated) };
}

const verifiedTextFiles = new Map<string, string>();
export async function previewArtifactFile(cwd: string, target: string, includeContent = true): Promise<SquadArtifactPreview> {
  const segments = target.split(/[\\/]/);
  const name = segments.at(-1) ?? '';
  if (!target || target.includes('\0') || segments.includes('..') || /^brief\.md$/i.test(name) ||
      /(?:^|[\\/])\.mycodex[\\/]result\.md$/i.test(target) || !/\.(?:md|markdown|txt|json|jsonl|log)$/i.test(name)) throw new Error('Unsupported artifact file path.');
  // Relative targets use the bound workspace, even if a directory above it
  // has a system-level alias. Absolute targets must themselves be link-free.
  const file = path.isAbsolute(target) ? normalizePlatformRoot(path.resolve(target)) : path.resolve(await fs.realpath(cwd), target);
  const canonical = async () => {
    const actual = await fs.realpath(file);
    if (actual !== file) throw new Error('Symlink artifact paths are denied.');
    return fs.lstat(file);
  };
  try {
    const before = await canonical();
    if (!before.isFile()) throw new Error('Artifact is not a file.');
    const handle = await fs.open(file, fss.constants.O_RDONLY | fss.constants.O_NOFOLLOW | fss.constants.O_NONBLOCK);
    try {
      const opened = await handle.stat(), after = await canonical();
      if (!opened.isFile() || [before, after].some(stat => stat.ino !== opened.ino || stat.dev !== opened.dev)) throw new Error('Artifact path changed.');
      const kind = /\.(?:md|markdown)$/i.test(name) ? 'markdown' : 'text';
      const truncated = opened.size > PREVIEW_LIMIT;
      const stamp = `${opened.dev}:${opened.ino}:${opened.mtimeMs}:${opened.ctimeMs}:${opened.size}`;
      if (!includeContent && verifiedTextFiles.get(file) === stamp) return { kind, title: name, content: '', truncated };
      const prefix = Buffer.alloc(includeContent ? Math.min(opened.size, PREVIEW_LIMIT) : 0);
      const block = Buffer.alloc(64 * 1024);
      const deadline = Date.now() + 8000;
      let offset = 0;
      while (offset < opened.size) {
        const { bytesRead } = await handle.read(block, 0, Math.min(block.length, opened.size - offset), offset);
        if (!bytesRead || Date.now() > deadline) throw new Error('Artifact read did not complete.');
        const data = block.subarray(0, bytesRead);
        if (data.includes(0)) throw new Error('Binary artifact previews are denied.');
        if (offset < prefix.length) data.copy(prefix, offset);
        offset += bytesRead;
      }
      const end = await handle.stat();
      const final = await canonical();
      if (final.ino !== opened.ino || final.dev !== opened.dev ||
          end.size !== opened.size || end.mtimeMs !== opened.mtimeMs || end.ctimeMs !== opened.ctimeMs) throw new Error('Artifact changed during preview.');
      verifiedTextFiles.set(file, stamp);
      if (verifiedTextFiles.size > 256) verifiedTextFiles.delete(verifiedTextFiles.keys().next().value!);
      return { kind, title: name, ...decodePreview(prefix, truncated) };
    } finally { await handle.close(); }
  } catch { throw new Error('Artifact is unavailable or is not a readable regular text file.'); }
}
export async function workspaceFileDiff(cwd: string, base: string, filePath: string): Promise<string> {
  const segments = filePath.split('/');
  if (!filePath || filePath.startsWith('/') || segments.some(s => !s || s === '.' || s === '..') || filePath.includes('\0')) throw new Error('Invalid diff path.');
  const realRoot = await fs.realpath(cwd);
  let current = realRoot;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) throw new Error('Symlink diff path is denied.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw e;
    }
  }
  const tracked = await git(cwd, '-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-renames', '-U4', base, '--', filePath);
  if (tracked) return tracked;
  const target = path.resolve(realRoot, filePath);
  if (!target.startsWith(realRoot + path.sep)) throw new Error('Invalid diff path.');
  let fd: number | undefined;
  try {
    fd = fss.openSync(target, fss.constants.O_RDONLY | fss.constants.O_NOFOLLOW);
    const stat = fss.fstatSync(fd);
    const resolvedTarget = await fs.realpath(target);
    if (!resolvedTarget.startsWith(realRoot + path.sep) || !stat.isFile() || stat.size > 256 * 1024) return '';
    const buf = Buffer.alloc(stat.size);
    const bytes = fss.readSync(fd, buf, 0, stat.size, 0);
    const text = buf.subarray(0, bytes).toString('utf8');
    if (text.includes('\0')) return 'Binary file';
    const lines = text.split('\n');
    return [`--- /dev/null`, `+++ b/${filePath}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join('\n');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('Symlink diff path is denied.');
    throw e;
  } finally {
    if (fd !== undefined) try { fss.closeSync(fd); } catch {}
  }
}
export async function integrateWorkspace(target: string, source: string, base: string, touches: string[], forbid: string[] = []) {
  const delta = await workspaceDelta(source, base, touches, forbid);
  if (delta.forbidViolations?.length) throw new Error('Forbidden paths: ' + delta.forbidViolations.join(', '));
  if (delta.outsideTouches.length) throw new Error('Outside touches: ' + delta.outsideTouches.join(', '));
  if (delta.dirtyCount || (await dirtyChanges(target)).length) throw new Error('Integration requires clean worktrees.');
  const head = await git(target, 'rev-parse', 'HEAD');
  // Check the merge in an isolated index/tree before changing the target.
  await git(target, 'merge-tree', '--write-tree', head, delta.headSha!);
  const identity = await git(target, 'var', 'GIT_COMMITTER_IDENT').then(() => [], () =>
    ['-c', 'user.name=MyCodex Squad', '-c', 'user.email=squad@mycodex.local']);
  await git(target, ...identity, 'merge', '--no-edit', '--no-ff', delta.headSha!);
  return delta;
}

/** Advance only clean descendants at the next dispatch, leaving the accepted
 * wave's diff visible until then. Divergent/unmerged worker commits stay put. */
export async function advanceWorkspaceBaseline(source: string, integration: string, slot?: string, sourceHead?: string): Promise<string | undefined> {
  const fastForward = async (target: string, head: string) => {
    if ((await dirtyChanges(target)).length) return false;
    try { await git(target, 'merge-base', '--is-ancestor', 'HEAD', head); }
    catch (e) { if ((e as { code?: number }).code === 1) return false; throw e; }
    await git(target, 'merge', '--ff-only', head); return true;
  };
  await fastForward(integration, sourceHead ?? await git(source, 'rev-parse', 'HEAD'));
  const head = await git(integration, 'rev-parse', 'HEAD');
  return !slot || await fastForward(slot, head) ? head : undefined;
}
