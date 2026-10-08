import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  setDoc,
  where,
  type QueryConstraint,
} from 'firebase/firestore';
import { auth, db } from './config';
import type { QueryResult } from './types';

const SCAN_LIMIT = 2000;

const TENANT_COLLECTIONS = new Set([
  'charges',
  'charge_executions',
  'payment_links',
  'message_templates',
]);

const INSERT_DEFAULTS: Record<string, Record<string, unknown>> = {
  charges: { status: 'pending', is_active: true, has_boleto_link: false },
  payment_splits: { status: 'pending', order_index: 0 },
  message_templates: { is_active: true },
  payout_accounts: { is_active: true },
  companies: { is_active: true },
};

const LOOKUP_COLLECTIONS = new Set([
  'companies',
  'profiles',
  'charges',
  'message_templates',
  'payout_accounts',
  'payment_links',
]);

const RELATION_OVERRIDES: Record<string, Record<string, { collection: string; kind: 'one' | 'many'; foreignKey: string }>> = {
  charges: {
    profiles: { collection: 'profiles', kind: 'one', foreignKey: 'created_by' },
  },
};

type Filter =
  | { op: 'eq'; field: string; value: unknown }
  | { op: 'gte'; field: string; value: unknown }
  | { op: 'lte'; field: string; value: unknown }
  | { op: 'gt'; field: string; value: unknown }
  | { op: 'lt'; field: string; value: unknown }
  | { op: 'in'; field: string; value: unknown[] }
  | { op: 'ilike'; field: string; value: string }
  | { op: 'not_null'; field: string };

type SelectNode =
  | { kind: 'field'; name: string }
  | { kind: 'relation'; alias: string; table: string; nested: string; inner: boolean };

type Row = Record<string, any>;

type Tenant = { uid: string; role: string; companyId: string | null };

let tenantCache: (Tenant & { at: number }) | null = null;

function singular(name: string): string {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (name.endsWith('s')) return name.slice(0, -1);
  return name;
}

function splitTopLevel(spec: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of spec) {
    if (char === '(') depth += 1;
    if (char === ')' && depth > 0) depth -= 1;
    if (char === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseSelect(spec: string): SelectNode[] {
  return splitTopLevel(spec).map((token) => {
    const paren = token.indexOf('(');
    if (paren === -1) return { kind: 'field', name: token } as SelectNode;
    const head = token.slice(0, paren).trim().replace(/!(inner|left)/g, '');
    const inner = token.slice(0, paren).includes('!inner');
    const nested = token.slice(paren + 1, token.lastIndexOf(')')).trim();
    const [alias, table] = head.includes(':')
      ? head.split(':').map((part) => part.trim())
      : [head, head];
    return { kind: 'relation', alias, table, nested, inner };
  });
}

function resolveRelation(parent: string, node: Extract<SelectNode, { kind: 'relation' }>) {
  const override = RELATION_OVERRIDES[parent]?.[node.alias] || RELATION_OVERRIDES[parent]?.[node.table];
  if (override) return override;
  if (LOOKUP_COLLECTIONS.has(node.table)) {
    return { collection: node.table, kind: 'one' as const, foreignKey: `${singular(node.table)}_id` };
  }
  return { collection: node.table, kind: 'many' as const, foreignKey: `${singular(parent)}_id` };
}

function sanitize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, sanitize(entry)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function compare(left: unknown, right: unknown): number {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function matchesIlike(value: unknown, pattern: string): boolean {
  const text = String(value ?? '').toLowerCase();
  const expected = pattern.toLowerCase();
  if (expected.startsWith('%') && expected.endsWith('%')) return text.includes(expected.slice(1, -1));
  if (expected.startsWith('%')) return text.endsWith(expected.slice(1));
  if (expected.endsWith('%')) return text.startsWith(expected.slice(0, -1));
  return text === expected;
}

function passes(row: Row, filters: Filter[]): boolean {
  return filters.every((filter) => {
    const value = row[filter.field];
    if (filter.op === 'eq') return value === filter.value;
    if (filter.op === 'in') return filter.value.includes(value);
    if (filter.op === 'ilike') return matchesIlike(value, filter.value);
    if (filter.op === 'not_null') return value != null;
    if (filter.op === 'gte') return compare(value, filter.value) >= 0;
    if (filter.op === 'lte') return compare(value, filter.value) <= 0;
    if (filter.op === 'gt') return compare(value, filter.value) > 0;
    if (filter.op === 'lt') return compare(value, filter.value) < 0;
    return true;
  });
}

function snapToRow(id: string, data: Record<string, unknown> | undefined): Row {
  return { ...(data ?? {}), id };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function currentTenant(): Promise<Tenant | null> {
  const user = auth.currentUser;
  if (!user) {
    tenantCache = null;
    return null;
  }
  if (tenantCache && tenantCache.uid === user.uid && Date.now() - tenantCache.at < 30_000) {
    return tenantCache;
  }
  const [profileSnap, roleSnap] = await Promise.all([
    getDoc(doc(db, 'profiles', user.uid)),
    getDoc(doc(db, 'user_roles', user.uid)),
  ]);
  if (!profileSnap.exists()) return null;
  tenantCache = {
    uid: user.uid,
    role: String(roleSnap.data()?.role || 'operador'),
    companyId: (profileSnap.data()?.company_id as string | null) ?? null,
    at: Date.now(),
  };
  return tenantCache;
}

async function loadCandidates(collectionName: string, filters: Filter[]): Promise<Row[]> {
  const idEq = filters.find((filter): filter is Extract<Filter, { op: 'eq' }> => filter.op === 'eq' && filter.field === 'id');
  if (idEq) {
    const snap = await getDoc(doc(db, collectionName, String(idEq.value)));
    return snap.exists() ? [snapToRow(snap.id, snap.data())] : [];
  }

  const idIn = filters.find((filter): filter is Extract<Filter, { op: 'in' }> => filter.op === 'in' && filter.field === 'id');
  if (idIn) {
    if (idIn.value.length === 0) return [];
    const snaps = await Promise.all(idIn.value.map((id) => getDoc(doc(db, collectionName, String(id)))));
    return snaps.filter((snap) => snap.exists()).map((snap) => snapToRow(snap.id, snap.data()));
  }

  const inFilter = filters.find((filter): filter is Extract<Filter, { op: 'in' }> => filter.op === 'in');
  if (inFilter) {
    if (inFilter.value.length === 0) return [];
    const rows: Row[] = [];
    for (const part of chunk(inFilter.value, 30)) {
      const snap = await getDocs(query(
        collection(db, collectionName),
        where(inFilter.field, 'in', part),
        limit(SCAN_LIMIT),
      ));
      rows.push(...snap.docs.map((item) => snapToRow(item.id, item.data())));
    }
    return rows;
  }

  const equalities = filters.filter((filter) => filter.op === 'eq');
  const preferred = ['company_id', 'charge_id', 'user_id']
    .map((field) => equalities.find((filter) => filter.field === field))
    .find(Boolean) || equalities[0];

  const constraints: QueryConstraint[] = [];
  if (preferred && preferred.op === 'eq') constraints.push(where(preferred.field, '==', preferred.value));
  constraints.push(limit(SCAN_LIMIT));
  const snap = await getDocs(query(collection(db, collectionName), ...constraints));
  return snap.docs.map((item) => snapToRow(item.id, item.data()));
}

function project(row: Row, nodes: SelectNode[]): Row {
  if (nodes.length === 1 && nodes[0].kind === 'field' && nodes[0].name === '*') return row;
  const hasStar = nodes.some((node) => node.kind === 'field' && node.name === '*');
  const output: Row = hasStar ? { ...row } : {};
  for (const node of nodes) {
    if (node.kind === 'field' && node.name !== '*') output[node.name] = row[node.name];
    if (node.kind === 'relation') {
      const nested = parseSelect(node.nested || '*');
      const value = row[node.alias];
      if (Array.isArray(value)) output[node.alias] = value.map((item) => project(item, nested));
      else if (value) output[node.alias] = project(value, nested);
      else output[node.alias] = value ?? null;
    }
  }
  return output;
}

async function hydrate(collectionName: string, rows: Row[], nodes: SelectNode[]): Promise<void> {
  const relations = nodes.filter((node): node is Extract<SelectNode, { kind: 'relation' }> => node.kind === 'relation');
  await Promise.all(relations.map(async (node) => {
    const relation = resolveRelation(collectionName, node);
    if (relation.kind === 'one') {
      const ids = [...new Set(rows.map((row) => row[relation.foreignKey]).filter(Boolean).map(String))];
      const snaps = await Promise.all(ids.map((id) => getDoc(doc(db, relation.collection, id))));
      const byId = new Map(snaps.filter((snap) => snap.exists()).map((snap) => [snap.id, snapToRow(snap.id, snap.data())]));
      rows.forEach((row) => {
        row[node.alias] = byId.get(String(row[relation.foreignKey] ?? '')) ?? null;
      });
      return;
    }

    const parentIds = rows.map((row) => row.id).filter(Boolean);
    const children: Row[] = [];
    for (const part of chunk(parentIds, 30)) {
      if (part.length === 0) continue;
      const snap = await getDocs(query(
        collection(db, relation.collection),
        where(relation.foreignKey, 'in', part),
        limit(SCAN_LIMIT),
      ));
      children.push(...snap.docs.map((item) => snapToRow(item.id, item.data())));
    }
    rows.forEach((row) => {
      row[node.alias] = children.filter((child) => child[relation.foreignKey] === row.id);
    });
  }));
}

function relationPresent(row: Row, node: Extract<SelectNode, { kind: 'relation' }>): boolean {
  const value = row[node.alias];
  if (Array.isArray(value)) return value.length > 0;
  return value != null;
}

export class FirestoreQuery {
  private filters: Filter[] = [];
  private orders: { field: string; ascending: boolean }[] = [];
  private maxRows?: number;
  private rangeFrom?: number;
  private rangeTo?: number;
  private operation: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: unknown;
  private selectSpec = '*';
  private returning = true;
  private expect: 'many' | 'one' | 'maybe' = 'many';

  constructor(private readonly collectionName: string) {}

  select(columns = '*', options?: { count?: 'exact' }) {
    this.selectSpec = columns;
    this.returning = true;
    void options;
    return this;
  }

  insert(values: unknown) {
    this.operation = 'insert';
    this.payload = values;
    this.returning = false;
    return this;
  }

  update(values: unknown) {
    this.operation = 'update';
    this.payload = values;
    this.returning = false;
    return this;
  }

  delete() {
    this.operation = 'delete';
    this.returning = false;
    return this;
  }

  eq(field: string, value: unknown) {
    this.filters.push({ op: 'eq', field, value });
    return this;
  }

  gte(field: string, value: unknown) {
    this.filters.push({ op: 'gte', field, value });
    return this;
  }

  lte(field: string, value: unknown) {
    this.filters.push({ op: 'lte', field, value });
    return this;
  }

  gt(field: string, value: unknown) {
    this.filters.push({ op: 'gt', field, value });
    return this;
  }

  lt(field: string, value: unknown) {
    this.filters.push({ op: 'lt', field, value });
    return this;
  }

  in(field: string, value: unknown[]) {
    this.filters.push({ op: 'in', field, value: value ?? [] });
    return this;
  }

  ilike(field: string, value: string) {
    this.filters.push({ op: 'ilike', field, value });
    return this;
  }

  not(field: string, operator: string, value: unknown) {
    if (operator === 'is' && value == null) this.filters.push({ op: 'not_null', field });
    return this;
  }

  order(field: string, options?: { ascending?: boolean }) {
    this.orders.push({ field, ascending: options?.ascending !== false });
    return this;
  }

  limit(count: number) {
    this.maxRows = count;
    return this;
  }

  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  single() {
    this.expect = 'one';
    return this;
  }

  maybeSingle() {
    this.expect = 'maybe';
    return this;
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async scopeFilters(): Promise<Filter[] | 'empty'> {
    if (!TENANT_COLLECTIONS.has(this.collectionName)) return this.filters;
    if (this.filters.some((filter) => filter.op === 'eq' && filter.field === 'company_id')) return this.filters;
    const tenant = await currentTenant();
    if (!tenant || tenant.role === 'admin') return this.filters;
    if (!tenant.companyId) return 'empty';
    return [...this.filters, { op: 'eq', field: 'company_id', value: tenant.companyId }];
  }

  private async execute(): Promise<QueryResult> {
    try {
      if (this.operation === 'insert') return await this.executeInsert();
      const filters = await this.scopeFilters();
      if (filters === 'empty') {
        return { data: this.expect === 'many' ? [] : null, error: null, count: 0 };
      }
      if (this.operation === 'update') return await this.executeUpdate(filters);
      if (this.operation === 'delete') return await this.executeDelete(filters);
      return await this.executeSelect(filters);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao acessar o Firestore.';
      return { data: null, error: { message }, count: null };
    }
  }

  private async executeSelect(filters: Filter[]): Promise<QueryResult> {
    const nodes = parseSelect(this.selectSpec || '*');
    let rows = (await loadCandidates(this.collectionName, filters)).filter((row) => passes(row, filters));
    rows.sort((left, right) => {
      for (const order of this.orders) {
        const diff = compare(left[order.field], right[order.field]);
        if (diff !== 0) return order.ascending ? diff : -diff;
      }
      return 0;
    });

    const relations = nodes.filter((node): node is Extract<SelectNode, { kind: 'relation' }> => node.kind === 'relation');
    const innerRelations = relations.filter((node) => node.inner);
    if (innerRelations.length > 0) {
      await hydrate(this.collectionName, rows, nodes);
      rows = rows.filter((row) => innerRelations.every((node) => relationPresent(row, node)));
    }

    const count = rows.length;
    const from = this.rangeFrom ?? 0;
    const to = this.rangeTo != null ? this.rangeTo + 1 : (this.maxRows != null ? from + this.maxRows : undefined);
    const page = rows.slice(from, to);

    if (innerRelations.length === 0 && relations.length > 0) {
      await hydrate(this.collectionName, page, nodes);
    }

    const data = page.map((row) => project(row, nodes));
    return this.finish(data, count);
  }

  private async executeInsert(): Promise<QueryResult> {
    const items = Array.isArray(this.payload) ? this.payload : [this.payload];
    const now = new Date().toISOString();
    const defaults = INSERT_DEFAULTS[this.collectionName] ?? {};
    const rows: Row[] = [];

    for (const item of items) {
      const source = sanitize(item) as Row;
      const id = String(source.id || crypto.randomUUID());
      const row: Row = {
        ...defaults,
        ...source,
        id,
        created_at: source.created_at ?? now,
        updated_at: source.updated_at ?? now,
      };
      await setDoc(doc(db, this.collectionName, id), row);
      rows.push(row);
    }

    if (!this.returning) return { data: null, error: null, count: rows.length };
    const nodes = parseSelect(this.selectSpec || '*');
    return this.finish(rows.map((row) => project(row, nodes)), rows.length);
  }

  private async executeUpdate(filters: Filter[]): Promise<QueryResult> {
    const rows = (await loadCandidates(this.collectionName, filters)).filter((row) => passes(row, filters));
    const patch = sanitize(this.payload) as Row;
    delete patch.id;
    const updatedAt = new Date().toISOString();
    const updated: Row[] = [];
    for (const row of rows) {
      const next = { ...row, ...patch, updated_at: updatedAt };
      await setDoc(doc(db, this.collectionName, row.id), { ...patch, updated_at: updatedAt }, { merge: true });
      updated.push(next);
    }
    if (!this.returning) return { data: null, error: null, count: updated.length };
    const nodes = parseSelect(this.selectSpec || '*');
    return this.finish(updated.map((row) => project(row, nodes)), updated.length);
  }

  private async executeDelete(filters: Filter[]): Promise<QueryResult> {
    const rows = (await loadCandidates(this.collectionName, filters)).filter((row) => passes(row, filters));
    for (const row of rows) await deleteDoc(doc(db, this.collectionName, row.id));
    return { data: null, error: null, count: rows.length };
  }

  private finish(rows: Row[], count: number): QueryResult {
    if (this.expect === 'many') return { data: rows, error: null, count };
    if (rows.length === 1) return { data: rows[0], error: null, count };
    if (rows.length === 0 && this.expect === 'maybe') return { data: null, error: null, count };
    return {
      data: null,
      error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' },
      count,
    };
  }
}

export function from(collectionName: string) {
  return new FirestoreQuery(collectionName);
}
