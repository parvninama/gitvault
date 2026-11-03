export type StorageErrorCode =
  | 'REQUIRES_CHUNKING'
  | 'ALREADY_EXISTS'
  | 'NOT_FOUND'
  | 'NOT_ARCHIVED'
  | 'ALREADY_ARCHIVED'
  | 'UNKNOWN_REF'
  | 'RESTORE_FAILED';

export class StorageError extends Error {
  code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}
