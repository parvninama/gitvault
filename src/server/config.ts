import { existsSync } from 'node:fs';

export interface Config {
  githubClientId: string;
  githubClientSecret: string;
  githubCallbackUrl: string;
  databasePath: string;
  maxGithubFileSize: number;
  targetRepositorySize: number;
  maxRepositories: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env && existsSync('.env')) process.loadEnvFile('.env');
  const num = (k: string, d: number) => {
    const v = env[k];
    if (v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${k} must be a positive number`);
    return n;
  };
  return {
    githubClientId: env.GITHUB_CLIENT_ID ?? '',
    githubClientSecret: env.GITHUB_CLIENT_SECRET ?? '',
    githubCallbackUrl: env.GITHUB_CALLBACK_URL ?? '',
    databasePath: env.DATABASE_PATH || './data/gitvault.sqlite',
    maxGithubFileSize: num('MAX_GITHUB_FILE_SIZE', 90 * 1024 * 1024),
    targetRepositorySize: num('TARGET_REPOSITORY_SIZE', 1024 * 1024 * 1024),
    maxRepositories: num('MAX_REPOSITORIES', 3),
  };
}
