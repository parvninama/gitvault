import type { MetadataStore, RepositoryRecord } from '../database/MetadataStore.ts';
import type { StorageProvider } from '../storage/types.ts';

export interface ProviderFactory {
  /** Create (or adopt) the backing repository for a logical repo id; returns where it lives. */
  createRepository(repoId: string): Promise<{ owner: string; repository: string }>;
  openProvider(record: RepositoryRecord): StorageProvider;
}

export class CapacityError extends Error {
  code = 'CAPACITY_EXHAUSTED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CapacityError';
  }
}

export interface ManagerOptions {
  store: MetadataStore;
  factory: ProviderFactory;
  /** TARGET_REPOSITORY_SIZE in bytes. */
  targetSize: number;
  /** Hard cap on repositories: this app never creates unlimited repos. */
  maxRepositories: number;
  logicalVolume?: string;
}

/**
 * Treats N repositories as one volume. IMPORTANT: capacity is judged by HISTORICAL size, because Git history
 * never shrinks when a file is archived. Using "current tree size" would let a repository grow without bound.
 */
export class RepositoryManager {
  private store: MetadataStore;
  private factory: ProviderFactory;
  private target: number;
  private maxRepositories: number;
  private volume: string;
  private providers = new Map<string, StorageProvider>();

  constructor(o: ManagerOptions) {
    this.store = o.store;
    this.factory = o.factory;
    this.target = o.targetSize;
    this.maxRepositories = o.maxRepositories;
    this.volume = o.logicalVolume ?? 'default';
  }

  get targetSize(): number { return this.target; }
  get maxRepos(): number { return this.maxRepositories; }

  list(): RepositoryRecord[] {
    return this.store.listRepositories();
  }

  provider(repoId: string): StorageProvider {
    let p = this.providers.get(repoId);
    if (!p) {
      const rec = this.store.getRepository(repoId);
      if (!rec) throw new Error(`Unknown repository ${repoId}`);
      p = this.factory.openProvider(rec);
      this.providers.set(repoId, p);
    }
    return p;
  }

  static used(r: RepositoryRecord): number {
    return Math.max(r.approximateCurrentSize, r.approximateHistoricalSize);
  }

  /** Where would `bytes` go? Never creates anything. Throws CapacityError if nowhere. */
  peek(bytes: number): { repoId: string; label: string; willCreate: boolean } {
    if (bytes > this.target) {
      throw new CapacityError(`Object of ${bytes} bytes exceeds the whole-repository target of ${this.target} bytes`);
    }
    const repos = this.list();
    const fit = repos.find((r) => r.status === 'active' && RepositoryManager.used(r) + bytes <= this.target);
    if (fit) return { repoId: fit.repoId, label: `${fit.owner}/${fit.repository}`, willCreate: false };
    if (repos.length >= this.maxRepositories) {
      throw new CapacityError(`All ${repos.length} repositories are at their ${this.target}-byte target and the limit of ${this.maxRepositories} repositories is reached`);
    }
    const repoId = `repo-${String(repos.length + 1).padStart(2, '0')}`;
    return { repoId, label: `${repoId} (new repository will be created)`, willCreate: true };
  }

  /** Fill-first allocation. Callers must serialise allocate+record (StorageService does). */
  async allocate(bytes: number): Promise<{ record: RepositoryRecord; provider: StorageProvider }> {
    const target = this.peek(bytes);
    if (!target.willCreate) return { record: this.store.getRepository(target.repoId)!, provider: this.provider(target.repoId) };
    const { owner, repository } = await this.factory.createRepository(target.repoId);
    const record: RepositoryRecord = {
      repoId: target.repoId, owner, repository, logicalVolume: this.volume,
      approximateCurrentSize: 0, approximateHistoricalSize: 0, status: 'active',
    };
    this.store.upsertRepository(record);
    return { record, provider: this.provider(target.repoId) };
  }

  private update(repoId: string, f: (r: RepositoryRecord) => void): void {
    const r = this.store.getRepository(repoId);
    if (!r) throw new Error(`Unknown repository ${repoId}`);
    f(r);
    if (r.status !== 'disabled') r.status = RepositoryManager.used(r) >= this.target ? 'full' : 'active';
    this.store.upsertRepository(r);
  }

  recordUpload(repoId: string, parwBytes: number): void {
    this.update(repoId, (r) => { r.approximateCurrentSize += parwBytes; r.approximateHistoricalSize += parwBytes; });
  }
  /** Tree shrinks to a pointer; history GROWS by the pointer blob. Nothing is reclaimed. */
  recordArchive(repoId: string, parwBytes: number, pointerBytes: number): void {
    this.update(repoId, (r) => {
      r.approximateCurrentSize = Math.max(0, r.approximateCurrentSize - parwBytes + pointerBytes);
      r.approximateHistoricalSize += pointerBytes;
    });
  }
  /** Identical bytes return to the tree; Git de-duplicates the blob so history does not grow. */
  recordRestoreToTree(repoId: string, parwBytes: number, pointerBytes: number): void {
    this.update(repoId, (r) => { r.approximateCurrentSize += parwBytes - pointerBytes; });
  }

  /** Replace estimates with what the backend reports (when it reports anything). */
  async refresh(repoId: string): Promise<RepositoryRecord> {
    const u = await this.provider(repoId).getUsage();
    this.update(repoId, (r) => {
      r.approximateCurrentSize = u.currentTreeBytes;
      const hist = u.historicalObjectBytes ?? u.estimatedRepoBytes;
      if (hist !== null) r.approximateHistoricalSize = Math.max(hist, r.approximateCurrentSize);
    });
    return this.store.getRepository(repoId)!;
  }
}
