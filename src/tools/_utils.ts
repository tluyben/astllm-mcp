import { IndexStore } from '../storage/index_store.js';

export function resolveRepo(
  repo: string,
  store: IndexStore,
): [string, string] {
  if (repo.includes('/')) {
    const [owner, name] = repo.split('/', 2);
    return [owner, name];
  }
  // Look up by short name
  const repos = store.listRepos();
  const match = repos.find(r => r.repo.endsWith(`/${repo}`));
  if (!match) throw new Error(`Repository not found: ${repo}`);
  return match.repo.split('/', 2) as [string, string];
}

export function makeMeta(timingMs: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { timing_ms: Math.round(timingMs * 10) / 10, ...extra };
}
