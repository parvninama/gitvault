import { LocalVersionedBackend } from './LocalVersionedBackend.ts';
import { VersionedStorageProvider } from './VersionedStorageProvider.ts';
import type { ProviderOptions } from './VersionedStorageProvider.ts';

/** Offline provider backed by the local git-like simulation. Same workflow code as the GitHub provider. */
export class LocalStorageProvider extends VersionedStorageProvider {
  constructor(rootDir: string, opts: ProviderOptions = {}) {
    super(new LocalVersionedBackend(rootDir), opts);
  }
}
