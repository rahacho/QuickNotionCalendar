/**
 * In-memory stand-in for the slice of the Admin SDK's Firestore that tick.ts uses: documents by path,
 * collection / collection-group queries with `<=` / `>` / `==` filters (ranges compare numbers with
 * numbers and Dates with Dates, as Firestore compares only values of one type), orderBy, limit, `set`, and `update`
 * with a `lastUpdateTime` precondition (FAILED_PRECONDITION, gRPC code 9, when the document changed).
 * `reads` logs each query label (and, for filtered queries, the label plus its filters).
 * Every operation yields to the event loop so concurrent ticks interleave like real I/O.
 */
import type { DocData, FsDb, FsDocRef, FsDocSnap, FsQuery } from '../tick.js';

interface Stored {
  data: DocData;
  updateTime: number;
}

type Filter = { field: string; op: '<=' | '==' | '>'; value: unknown };

/** A range-comparable value: [type, number] (Firestore orders numbers and timestamps separately). */
function rangeKey(v: unknown): [string, number] | null {
  if (typeof v === 'number') return ['number', v];
  if (v instanceof Date) return ['timestamp', v.getTime()];
  return null;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

const tickOnce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export class FakeFirestore implements FsDb {
  readonly store = new Map<string, Stored>();
  private clock = 0;
  /** Called right before an update is applied (simulate a concurrent writer). */
  beforeUpdate: ((path: string) => void | Promise<void>) | null = null;
  readonly reads: string[] = [];

  set(path: string, data: DocData): void {
    this.store.set(path, { data: clone(data), updateTime: ++this.clock });
  }

  /** A client-side write (bumps updateTime like any write). */
  patch(path: string, data: DocData): void {
    const cur = this.store.get(path);
    if (!cur) throw new Error(`no doc ${path}`);
    this.store.set(path, { data: { ...cur.data, ...clone(data) }, updateTime: ++this.clock });
  }

  get(path: string): DocData | undefined {
    const cur = this.store.get(path);
    return cur ? clone(cur.data) : undefined;
  }

  has(path: string): boolean {
    return this.store.has(path);
  }

  doc(path: string): FsDocRef {
    return new FakeDocRef(this, path);
  }

  collection(path: string): FsQuery {
    const depth = path.split('/').length + 1;
    return new FakeQuery(this, `collection(${path})`, (p) => p.startsWith(`${path}/`) && p.split('/').length === depth);
  }

  collectionGroup(id: string): FsQuery {
    return new FakeQuery(this, `collectionGroup(${id})`, (p) => {
      const parts = p.split('/');
      return parts.length % 2 === 0 && parts[parts.length - 2] === id;
    });
  }

  /** @internal */
  async _update(path: string, data: DocData, precondition?: { lastUpdateTime?: unknown }): Promise<void> {
    await tickOnce();
    if (this.beforeUpdate) await this.beforeUpdate(path);
    const cur = this.store.get(path);
    if (!cur) throw Object.assign(new Error(`NOT_FOUND: ${path}`), { code: 5 });
    if (precondition?.lastUpdateTime !== undefined && precondition.lastUpdateTime !== cur.updateTime) {
      throw Object.assign(new Error(`FAILED_PRECONDITION: ${path}`), { code: 9 });
    }
    this.store.set(path, { data: { ...cur.data, ...clone(data) }, updateTime: ++this.clock });
  }

  /** @internal */
  async _set(path: string, data: DocData): Promise<void> {
    await tickOnce();
    this.store.set(path, { data: clone(data), updateTime: ++this.clock });
  }

  /** @internal */
  async _delete(path: string): Promise<void> {
    await tickOnce();
    this.store.delete(path);
  }

  /** @internal */
  _snap(path: string): FsDocSnap {
    const cur = this.store.get(path);
    const ref = new FakeDocRef(this, path);
    const data = cur ? clone(cur.data) : undefined;
    return {
      id: ref.id,
      ref,
      exists: cur !== undefined,
      updateTime: cur?.updateTime,
      data: () => (data ? clone(data) : undefined),
    };
  }
}

class FakeDocRef implements FsDocRef {
  readonly id: string;
  readonly parent: { readonly parent: FsDocRef | null };

  constructor(
    private readonly db: FakeFirestore,
    readonly path: string,
  ) {
    const parts = path.split('/');
    this.id = parts[parts.length - 1] ?? '';
    const parentDoc = parts.length >= 4 ? parts.slice(0, -2).join('/') : null;
    this.parent = { parent: parentDoc ? new FakeDocRef(db, parentDoc) : null };
  }

  update(data: DocData, precondition?: { lastUpdateTime?: unknown }): Promise<unknown> {
    return this.db._update(this.path, data, precondition);
  }

  set(data: DocData): Promise<unknown> {
    return this.db._set(this.path, data);
  }

  delete(): Promise<unknown> {
    return this.db._delete(this.path);
  }

  async get(): Promise<FsDocSnap> {
    await tickOnce();
    this.db.reads.push(this.path);
    return this.db._snap(this.path);
  }

  collection(id: string): FsQuery {
    return this.db.collection(`${this.path}/${id}`);
  }
}

class FakeQuery implements FsQuery {
  constructor(
    private readonly db: FakeFirestore,
    private readonly label: string,
    private readonly match: (path: string) => boolean,
    private readonly filters: Filter[] = [],
    private readonly order: string | null = null,
    private readonly max = Infinity,
  ) {}

  where(field: string, op: '<=' | '==' | '>', value: unknown): FsQuery {
    return new FakeQuery(this.db, this.label, this.match, [...this.filters, { field, op, value }], this.order, this.max);
  }

  orderBy(field: string): FsQuery {
    return new FakeQuery(this.db, this.label, this.match, this.filters, field, this.max);
  }

  limit(n: number): FsQuery {
    return new FakeQuery(this.db, this.label, this.match, this.filters, this.order, n);
  }

  async get(): Promise<{ docs: FsDocSnap[] }> {
    await tickOnce();
    this.db.reads.push(this.label);
    if (this.filters.length > 0) {
      const show = (v: unknown): string => (v instanceof Date ? String(v.getTime()) : String(v));
      this.db.reads.push(`${this.label} where ${this.filters.map((f) => `${f.field} ${f.op} ${show(f.value)}`).join(' and ')}`);
    }
    let paths = [...this.db.store.keys()].filter((p) => this.match(p));
    paths = paths.filter((p) => {
      const data = this.db.store.get(p)?.data ?? {};
      return this.filters.every((f) => {
        const v = data[f.field];
        if (f.op === '==') return v === f.value;
        // Firestore range filters only match values of the same type (null / missing never match).
        const a = rangeKey(v);
        const b = rangeKey(f.value);
        if (!a || !b || a[0] !== b[0]) return false;
        return f.op === '<=' ? a[1] <= b[1] : a[1] > b[1];
      });
    });
    if (this.order) {
      const field = this.order;
      paths.sort((a, b) => {
        const va = rangeKey(this.db.store.get(a)?.data[field]);
        const vb = rangeKey(this.db.store.get(b)?.data[field]);
        return (va ? va[1] : 0) - (vb ? vb[1] : 0);
      });
    }
    return { docs: paths.slice(0, this.max).map((p) => this.db._snap(p)) };
  }
}
