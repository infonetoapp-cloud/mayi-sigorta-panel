export const LEGACY_SQL_BYTES = 16 * 1024 * 1024;
export const MAX_RAW_SQL_BYTES = 96 * 1024 * 1024;
export const MAX_GZIP_SQL_BYTES = 8 * 1024 * 1024;
export const LEGACY_SQL_FILE = 'database.sql';
export const GZIP_SQL_FILE = 'database.sql.gz';
export const GZIP_INTEGRITY = 'R2_STORED_SHA256_AND_RAW_SIZE';
export const SHA256_HEX = /^[a-f0-9]{64}$/u;
