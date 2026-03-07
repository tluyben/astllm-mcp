import { IndexStore } from '../storage/index_store.js';
import { resolveRepo, makeMeta } from './_utils.js';

export function invalidateCache(repo: string, storagePath?: string | null): Record<string, unknown> {
  const start = performance.now();
  const store = new IndexStore(storagePath);

  try {
    const [owner, name] = resolveRepo(repo, store);
    store.deleteIndex(owner, name);
    const elapsed = performance.now() - start;
    return {
      success: true,
      repo: `${owner}/${name}`,
      message: 'Index deleted. Next operation will re-index from scratch.',
      _meta: makeMeta(elapsed),
    };
  } catch (err) {
    const elapsed = performance.now() - start;
    return {
      error: err instanceof Error ? err.message : String(err),
      _meta: makeMeta(elapsed),
    };
  }
}
