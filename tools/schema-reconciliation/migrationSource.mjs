import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Preserve immutable migration byte identities across Windows checkouts. This
// is NOT SQL normalization: only a proven CRLF checkout of the exact Git blob
// may use that blob's original LF bytes. Any content drift fails closed.
export function verifyMigrationSourceBytes(workingBytes, committedBytes, file) {
  const text = workingBytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(workingBytes)) throw new Error(`MIGRATION_SOURCE_UTF8_INVALID:${file}`);
  let bytes = workingBytes;
  if (committedBytes !== null && !workingBytes.equals(committedBytes)) {
    const lf = Buffer.from(text.replace(/\r\n/gu, '\n'), 'utf8');
    if (committedBytes.includes(13) || !lf.equals(committedBytes)) {
      throw new Error(`MIGRATION_SOURCE_CONTENT_DRIFT:${file}`);
    }
    bytes = committedBytes;
  }
  return {
    sql: bytes.toString('utf8'),
    sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
    checkoutChecksum: createHash('sha256').update(workingBytes).digest('hex'),
    encoding: bytes === workingBytes ? 'EXACT_BYTES' : 'GIT_VERIFIED_CRLF_CHECKOUT',
  };
}

export function createMigrationSourceReader(root) {
  const git = (...args) => execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
    maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const head = git('rev-parse', 'HEAD').toString('utf8').trim();
  const proofs = new Map();
  return async file => {
    if (!/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/u.test(file)) throw new Error(`MIGRATION_SOURCE_PATH_INVALID:${file}`);
    if (!proofs.has(file)) {
      const entry = git('ls-tree', '-z', head, '--', `supabase/sql/${file}`).toString('utf8');
      if (!entry) proofs.set(file, null); // New append-only candidate: retain its exact bytes; never normalize it.
      else {
        const match = /^(100644|100755) blob ([a-f0-9]{40})\tsupabase\/sql\/[^\0]+\0$/u.exec(entry);
        if (!match) throw new Error(`MIGRATION_SOURCE_GIT_PROOF_INVALID:${file}`);
        proofs.set(file, git('cat-file', 'blob', match[2]));
      }
    }
    return verifyMigrationSourceBytes(await readFile(resolve(root, 'supabase/sql', file)), proofs.get(file), file);
  };
}
