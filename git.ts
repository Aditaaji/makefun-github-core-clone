// git.ts — git object model, pkt-line framing, pack read/write, traversal, diff, merge.
// Stdlib only (node:crypto, node:zlib). No git binary, no network.

import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(s: string): boolean {
  return OID_RE.test(s);
}

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([header, data]));
}

export function newRequestId(): string {
  return randomUUID();
}

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

export type PktLine = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Encode one pkt-line carrying `payload` (payload must not contain its own length prefix). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > 65520) throw new Error(`pkt-line too long: ${len}`);
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode a list of lines ('flush' | 'delim' | string) as pkt-lines. */
export function encodePktLines(lines: ReadonlyArray<string | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else if (line === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. Throws on truncation or a bad length. */
export function decodePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') {
      out.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (head === '0002') {
      out.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > buf.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    out.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return out;
}

/** Split a buffer at the first flush packet: [lines before flush, bytes after flush]. */
export function splitAtFlush(buf: Buffer): { lines: PktLine[]; rest: Buffer } {
  let pos = 0;
  const lines: PktLine[] = [];
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') return { lines, rest: buf.subarray(pos + 4) };
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > buf.length) throw new Error('bad pkt-line length');
    lines.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  throw new Error('no flush packet in pkt-line stream');
}

/** Frame `data` as sideband packets on `band` (1 = data, 2 = progress, 3 = error). */
export function sideband(data: Buffer, band: 1 | 2 | 3): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  if (data.length === 0) {
    parts.push(pktLine(Buffer.from([band])));
    return Buffer.concat(parts);
  }
  for (let off = 0; off < data.length; off += CHUNK) {
    const slice = data.subarray(off, Math.min(data.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// pack read / write (version 2/3, plain objects + OFS/REF deltas on read)
// -------------------------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function writePack(objects: ReadonlyMap<string, GitObject> | readonly GitObject[]): Buffer {
  const list = Array.isArray(objects) ? objects : [...objects.values()];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of list) {
    const typeId = PACK_TYPE_IDS[obj.type];
    const size = obj.data.length;
    // varint header: first byte holds type in bits 4-6 and low 4 size bits, MSB continuation.
    const headBytes: number[] = [];
    let remaining = size;
    let first = (typeId << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headBytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      headBytes.push(b);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 20) return { ok: false, expected: '', actual: '' };
  const expected = sha1(pack.subarray(0, pack.length - 20));
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}

interface PackEntry {
  type: ObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Apply a git delta (copy/insert instructions) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos++];
      out |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return out;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  readVarint(); // result size (checked implicitly by construction)
  const parts: Buffer[] = [];
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) offset |= delta[pos++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) size |= delta[pos++] << (8 * i);
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  return Buffer.concat(parts);
}

export function readPack(
  pack: Buffer,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): { objects: Map<string, GitObject>; deltaCount: number } {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const entries: Array<{ offset: number; entry: PackEntry }> = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let byte = pack[pos++];
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let entry: PackEntry;
    if (typeId === 6) {
      // OFS_DELTA: offset varint (git's offset encoding)
      byte = pack[pos++];
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos++];
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      const data = inflateSync(pack.subarray(pos));
      pos += consumedDeflate(pack, pos);
      entry = { type: 'ofs-delta', data, baseOffset: start - offset };
    } else if (typeId === 7) {
      const baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const data = inflateSync(pack.subarray(pos));
      pos += consumedDeflate(pack, pos);
      entry = { type: 'ref-delta', data, baseOid };
    } else {
      const type = PACK_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      const data = inflateSync(pack.subarray(pos));
      pos += consumedDeflate(pack, pos);
      if (data.length !== size) throw new Error(`pack object size mismatch: ${data.length} != ${size}`);
      entry = { type, data };
    }
    entries.push({ offset: start, entry });
  }
  // Resolve deltas (entries may reference earlier entries in the same pack).
  const byOffset = new Map<number, GitObject>();
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  const resolve = (index: number): GitObject => {
    const { offset, entry } = entries[index]!;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (entry.type === 'ofs-delta') {
        base = byOffset.get(entry.baseOffset!);
        if (base === undefined) {
          const baseIndex = entries.findIndex((e) => e.offset === entry.baseOffset);
          if (baseIndex < 0) throw new Error('ofs-delta base not in pack');
          base = resolve(baseIndex);
        }
      } else {
        base = options.resolveBase?.(entry.baseOid!);
        if (base === undefined) {
          const found = [...objects.values()].find((o) => objectId(o.type, o.data) === entry.baseOid);
          if (found === undefined) throw new Error(`ref-delta base ${entry.baseOid} not available`);
          base = found;
        }
      }
      const data = applyDelta(base.data, entry.data);
      const obj: GitObject = { type: base.type, data };
      byOffset.set(offset, obj);
      objects.set(objectId(obj.type, obj.data), obj);
      return obj;
    }
    const obj: GitObject = { type: entry.type as ObjectType, data: entry.data };
    byOffset.set(offset, obj);
    objects.set(objectId(obj.type, obj.data), obj);
    return obj;
  };
  for (let i = 0; i < entries.length; i += 1) resolve(i);
  return { objects, deltaCount };
}

/** Bytes the zlib stream starting at `pos` consumed (inflateSync gives no length, so find it). */
function consumedDeflate(pack: Buffer, pos: number): number {
  // A zlib stream ends with an adler32; the deflate stream's end is found by trial inflation of
  // increasing slices — expensive in general, but packs here are small. Use a binary search on the
  // smallest prefix that inflates cleanly to the expected size is not available; instead inflate the
  // whole tail once per object is wrong. We locate the end by scanning: inflateSync on a truncated
  // buffer throws, so binary-search the minimal length that inflates without error.
  let lo = 2;
  let hi = pack.length - pos;
  // Fast path: most streams end well before the tail; exponential probe then binary search.
  const tryInflate = (len: number): boolean => {
    try {
      inflateSync(pack.subarray(pos, pos + len));
      return true;
    } catch {
      return false;
    }
  };
  if (!tryInflate(hi)) throw new Error('corrupt deflate stream in pack');
  let probe = 2;
  while (probe < hi && !tryInflate(probe)) probe *= 2;
  lo = Math.floor(probe / 2);
  hi = Math.min(hi, probe);
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (tryInflate(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

// -------------------------------------------------------------------------------------------
// tree / commit / tag codecs
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) throw new Error('bad tree entry');
    const mode = data.subarray(pos, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

export function encodeCommit(view: CommitView): Buffer {
  const lines = [`tree ${view.tree}`];
  for (const p of view.parents) lines.push(`parent ${p}`);
  lines.push(`author ${view.author}`);
  lines.push(`committer ${view.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${view.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: TagView = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) view.tag = line.slice(4);
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

// -------------------------------------------------------------------------------------------
// traversal helpers (operate on an object map)
// -------------------------------------------------------------------------------------------

export type ObjectMap = ReadonlyMap<string, GitObject>;

export function getCommit(objects: ObjectMap, oid: string): CommitView | null {
  const obj = objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

/** All commit oids reachable from `tips` (following parents), in visit order. */
export function commitClosure(objects: ObjectMap, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const commit = getCommit(objects, oid);
    if (commit === null) continue;
    seen.add(oid);
    for (const p of commit.parents) stack.push(p);
  }
  return seen;
}

/** Commits reachable from `tips` in newest-first (topological, parents after children) order. */
export function commitList(objects: ObjectMap, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const commit = getCommit(objects, oid);
    if (commit === null) continue;
    seen.add(oid);
    out.push(oid);
    for (const p of commit.parents) stack.push(p);
  }
  return out;
}

/** First common ancestor of a and b (BFS from both sides, first meeting point). */
export function mergeBase(objects: ObjectMap, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = commitClosure(objects, [a]);
  // BFS from b by generation.
  const queue: string[] = [b];
  const seen = new Set<string>([b]);
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancestorsA.has(oid)) return oid;
    const commit = getCommit(objects, oid);
    if (commit === null) continue;
    for (const p of commit.parents) {
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return null;
}

/** Is `ancestor` an ancestor of (or equal to) `descendant`? */
export function isAncestor(objects: ObjectMap, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitClosure(objects, [descendant]).has(ancestor);
}

/** Flatten a tree (by oid) into path -> {oid, mode}. */
export function flattenTree(objects: ObjectMap, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [p, v] of flattenTree(objects, entry.oid, path)) out.set(p, v);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

/** File-level diff between two trees (null tree = empty). */
export function diffTrees(objects: ObjectMap, oldTree: string | null, newTree: string | null): FileChange[] {
  const oldMap = oldTree === null ? new Map() : flattenTree(objects, oldTree);
  const newMap = newTree === null ? new Map() : flattenTree(objects, newTree);
  const changes: FileChange[] = [];
  const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
  for (const path of [...paths].sort()) {
    const o = oldMap.get(path);
    const n = newMap.get(path);
    if (o !== undefined && n === undefined) changes.push({ path, status: 'removed', oldOid: o.oid, newOid: null });
    else if (o === undefined && n !== undefined) changes.push({ path, status: 'added', oldOid: null, newOid: n.oid });
    else if (o !== undefined && n !== undefined && o.oid !== n.oid) {
      changes.push({ path, status: 'modified', oldOid: o.oid, newOid: n.oid });
    }
  }
  return changes;
}

/** Count lines in a blob (for additions/deletions accounting). */
export function countLines(objects: ObjectMap, oid: string | null): number {
  if (oid === null) return 0;
  const obj = objects.get(oid);
  if (obj === undefined) return 0;
  const text = obj.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
