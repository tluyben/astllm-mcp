import { IndexStore } from '../storage/index_store.js';
import { makeMeta } from './_utils.js';

export function listRepos(storagePath?: string | null): Record<string, unknown> {
  const start = performance.now();
  const store = new IndexStore(storagePath);
  const repos = store.listRepos();
  const elapsed = performance.now() - start;

  return {
    repos,
    count: repos.length,
    _meta: makeMeta(elapsed),
  };
}
