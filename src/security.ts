import fs from 'fs';
import path from 'path';

const SECRET_PATTERNS = [
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx',
  '*.rsa', '*.ecdsa', '*.ed25519', '*.ppk', '*.der',
  '.npmrc', '.pypirc', '.netrc', '.htpasswd',
  'credentials', 'secrets.json', 'service-account.json',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
];

const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib',
  '.obj', '.o', '.class', '.jar', '.war', '.ear',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.pyc', '.pyo', '.pyd', '.wasm', '.bin', '.dat',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.sqlite', '.db', '.mdb', '.sqlite3',
  '.iso', '.img', '.dmg', '.vmdk',
]);

function fnmatchSimple(pattern: string, name: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(name);
}

export function validatePath(targetPath: string, rootDir: string): boolean {
  const resolved = path.resolve(targetPath);
  const root = path.resolve(rootDir);
  return resolved.startsWith(root + path.sep) || resolved === root;
}

export function isSymlinkEscape(targetPath: string, rootDir: string): boolean {
  try {
    const real = fs.realpathSync(targetPath);
    const root = path.resolve(rootDir);
    return !real.startsWith(root + path.sep) && real !== root;
  } catch {
    return false;
  }
}

export function isSecretFile(filePath: string): boolean {
  const name = path.basename(filePath);
  for (const pattern of SECRET_PATTERNS) {
    if (fnmatchSimple(pattern, name)) return true;
    if (fnmatchSimple(pattern, filePath)) return true;
  }
  return false;
}

export function isBinaryExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export function isBinaryContent(buf: Buffer): boolean {
  // Check first 8192 bytes for null bytes
  const check = buf.slice(0, 8192);
  return check.indexOf(0) !== -1;
}

export function safeReadFile(filePath: string): string | null {
  try {
    const buf = fs.readFileSync(filePath);
    if (isBinaryContent(buf)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

export type ExcludeReason =
  | 'symlink_escape'
  | 'path_traversal'
  | 'secret_file'
  | 'file_too_large'
  | 'binary_extension'
  | 'unreadable';

export function shouldExcludeFile(
  filePath: string,
  rootDir: string,
  maxSizeBytes = 500 * 1024,
): ExcludeReason | null {
  if (!validatePath(filePath, rootDir)) return 'path_traversal';

  try {
    const lstat = fs.lstatSync(filePath);
    if (lstat.isSymbolicLink() && isSymlinkEscape(filePath, rootDir)) {
      return 'symlink_escape';
    }
    if (lstat.size > maxSizeBytes) return 'file_too_large';
  } catch {
    return 'unreadable';
  }

  if (isSecretFile(filePath)) return 'secret_file';
  if (isBinaryExtension(filePath)) return 'binary_extension';

  return null;
}

export function getMaxIndexFiles(): number {
  return parseInt(process.env['ASTLLM_MAX_INDEX_FILES'] ?? '500', 10);
}

export function getMaxFileSizeBytes(): number {
  const kb = parseInt(process.env['ASTLLM_MAX_FILE_SIZE_KB'] ?? '500', 10);
  return kb * 1024;
}
