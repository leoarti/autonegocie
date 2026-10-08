import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp, type DocumentData, type Query } from 'firebase-admin/firestore';
import { registeredHandler } from './dispatch';
import { groupOf } from './groups';

const SCAN_LIMIT = 2000;

const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || 'autonegocie-257c3';

if (!getApps().length) {
  try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      initializeApp({ credential: applicationDefault(), projectId });
    } else {
      initializeApp({ projectId });
    }
  } catch {
    if (!getApps().length) initializeApp({ projectId });
  }
}

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
  | { op: 'neq'; field: string; value: unknown }
  | { op: 'gte'; field: string; value: unknown }
  | { op: 'lte'; field: string; value: unknown }
  | { op: 'gt'; field: string; value: unknown }
  | { op: 'lt'; field: string; value: unknown }
  | { op: 'in'; field: string; value: unknown[] }
  | { op: 'not_in'; field: string; value: unknown[] }
  | { op: 'ilike'; field: string; value: string }
  | { op: 'not_null'; field: string }
  | { op: 'is_null'; field: string };

type SelectNode =
  | { kind: 'field'; name: string }
  | { kind: 'relation'; alias: string; table: string; nested: string; inner: boolean };

type Row = Record<string, any>;

export interface QueryResult {
  data: any;
  error: { message: string; code?: string; details?: string } | null;
  count: number | null;
}

const FUNCTION_REGION = 'southamerica-east1';

export function functionUrl(name: string): string {
  const clean = name.replace(/^\//, '');
  const group = groupOf(clean.split('/')[0]) || 'api';
  if (process.env.FUNCTIONS_BASE_URL) {
    return `${process.env.FUNCTIONS_BASE_URL.replace(/\/$/, '')}/${clean}`;
  }
  const project = process.env.GCLOUD_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || process.env.FIREBASE_PROJECT_ID
    || 'autonegocie-257c3';
  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    const host = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
    return `http://${host}/${project}/${FUNCTION_REGION}/${group}/${clean}`;
  }
  if (process.env.K_SERVICE || process.env.FUNCTION_TARGET) {
    return `https://${FUNCTION_REGION}-${project}.cloudfunctions.net/${group}/${clean}`;
  }
  return `http://127.0.0.1:${process.env.PORT || 8787}/${clean}`;
}

export async function callRoute(name: string, init?: { method?: string; headers?: HeadersInit; body?: BodyInit | null }): Promise<Response> {
  const handler = registeredHandler(name);
  const requestInit = {
    method: init?.method || 'POST',
    headers: init?.headers,
    body: init?.body ?? undefined,
  };
  if (handler) {
    return handler(new Request(`http://internal/${name.replace(/^\//, '')}`, requestInit));
  }
  return fetch(functionUrl(name), requestInit);
}

function store() {
  return getFirestore();
}

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
    const rawHead = token.slice(0, paren).trim();
    const inner = rawHead.includes('!inner');
    const head = rawHead.replace(/![\w]+/g, '');
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
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
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

function parseList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  const inner = value.trim().replace(/^\(/, '').replace(/\)$/, '');
  if (!inner) return [];
  return inner.split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, ''));
}

function passes(row: Row, filters: Filter[]): boolean {
  return filters.every((filter) => {
    const value = row[filter.field];
    if (filter.op === 'eq') return value === filter.value;
    if (filter.op === 'neq') return value !== filter.value;
    if (filter.op === 'in') return filter.value.includes(value);
    if (filter.op === 'not_in') return !filter.value.includes(value);
    if (filter.op === 'ilike') return matchesIlike(value, filter.value);
    if (filter.op === 'not_null') return value != null;
    if (filter.op === 'is_null') return value == null;
    if (filter.op === 'gte') return compare(value, filter.value) >= 0;
    if (filter.op === 'lte') return compare(value, filter.value) <= 0;
    if (filter.op === 'gt') return compare(value, filter.value) > 0;
    if (filter.op === 'lt') return compare(value, filter.value) < 0;
    return true;
  });
}

function snapToRow(id: string, data: DocumentData | undefined): Row {
  return { ...((sanitize(data ?? {}) as Row)), id };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function loadCandidates(collectionName: string, filters: Filter[]): Promise<Row[]> {
  const fs = store();
  const col = fs.collection(collectionName);

  const idEq = filters.find((filter): filter is Extract<Filter, { op: 'eq' }> => filter.op === 'eq' && filter.field === 'id');
  if (idEq && idEq.value != null) {
    const snap = await col.doc(String(idEq.value)).get();
    return snap.exists ? [snapToRow(snap.id, snap.data())] : [];
  }

  const idIn = filters.find((filter): filter is Extract<Filter, { op: 'in' }> => filter.op === 'in' && filter.field === 'id');
  if (idIn) {
    if (idIn.value.length === 0) return [];
    const snaps = await Promise.all(idIn.value.map((id) => col.doc(String(id)).get()));
    return snaps.filter((snap) => snap.exists).map((snap) => snapToRow(snap.id, snap.data()));
  }

  const inFilter = filters.find((filter): filter is Extract<Filter, { op: 'in' }> => filter.op === 'in');
  if (inFilter) {
    if (inFilter.value.length === 0) return [];
    const rows: Row[] = [];
    for (const part of chunk(inFilter.value, 30)) {
      const snap = await col.where(inFilter.field, 'in', part).limit(SCAN_LIMIT).get();
      rows.push(...snap.docs.map((item) => snapToRow(item.id, item.data())));
    }
    return rows;
  }

  const equalities = filters.filter((filter): filter is Extract<Filter, { op: 'eq' }> => filter.op === 'eq' && filter.value !== undefined);
  const preferred = ['company_id', 'charge_id', 'user_id']
    .map((field) => equalities.find((filter) => filter.field === field))
    .find(Boolean) || equalities[0];

  let query: Query = col;
  if (preferred) query = query.where(preferred.field, '==', preferred.value as any);
  const snap = await query.limit(SCAN_LIMIT).get();
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
  const fs = store();
  const relations = nodes.filter((node): node is Extract<SelectNode, { kind: 'relation' }> => node.kind === 'relation');
  await Promise.all(relations.map(async (node) => {
    const relation = resolveRelation(collectionName, node);
    if (relation.kind === 'one') {
      const ids = [...new Set(rows.map((row) => row[relation.foreignKey]).filter(Boolean).map(String))];
      const snaps = await Promise.all(ids.map((id) => fs.collection(relation.collection).doc(id).get()));
      const byId = new Map(snaps.filter((snap) => snap.exists).map((snap) => [snap.id, snapToRow(snap.id, snap.data())]));
      rows.forEach((row) => {
        row[node.alias] = byId.get(String(row[relation.foreignKey] ?? '')) ?? null;
      });
      return;
    }

    const parentIds = rows.map((row) => row.id).filter(Boolean);
    const children: Row[] = [];
    for (const part of chunk(parentIds, 30)) {
      if (part.length === 0) continue;
      const snap = await fs.collection(relation.collection).where(relation.foreignKey, 'in', part).limit(SCAN_LIMIT).get();
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

class FirestoreQuery {
  private filters: Filter[] = [];
  private orders: { field: string; ascending: boolean }[] = [];
  private maxRows?: number;
  private rangeFrom?: number;
  private rangeTo?: number;
  private operation: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private payload: unknown;
  private selectSpec = '*';
  private returning = true;
  private expect: 'many' | 'one' | 'maybe' = 'many';

  constructor(private readonly collectionName: string) {}

  select(columns = '*', _options?: { count?: 'exact'; head?: boolean }) {
    this.selectSpec = columns;
    this.returning = true;
    return this;
  }

  insert(values: unknown) {
    this.operation = 'insert';
    this.payload = values;
    this.returning = false;
    return this;
  }

  upsert(values: unknown, _options?: { onConflict?: string }) {
    this.operation = 'upsert';
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

  neq(field: string, value: unknown) {
    this.filters.push({ op: 'neq', field, value });
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

  is(field: string, value: unknown) {
    if (value == null) this.filters.push({ op: 'is_null', field });
    else this.filters.push({ op: 'eq', field, value });
    return this;
  }

  not(field: string, operator: string, value: unknown) {
    if (operator === 'is' && value == null) this.filters.push({ op: 'not_null', field });
    else if (operator === 'in') this.filters.push({ op: 'not_in', field, value: parseList(value) });
    else if (operator === 'eq') this.filters.push({ op: 'neq', field, value });
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

  private async execute(): Promise<QueryResult> {
    try {
      if (this.operation === 'insert' || this.operation === 'upsert') return await this.executeInsert(this.operation === 'upsert');
      if (this.operation === 'update') return await this.executeUpdate(this.filters);
      if (this.operation === 'delete') return await this.executeDelete(this.filters);
      return await this.executeSelect(this.filters);
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

  private async executeInsert(merge: boolean): Promise<QueryResult> {
    const items = Array.isArray(this.payload) ? this.payload : [this.payload];
    const now = new Date().toISOString();
    const defaults = INSERT_DEFAULTS[this.collectionName] ?? {};
    const rows: Row[] = [];
    const col = store().collection(this.collectionName);

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
      if (merge) await col.doc(id).set(row, { merge: true });
      else await col.doc(id).set(row);
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
    const col = store().collection(this.collectionName);
    for (const row of rows) {
      const next = { ...row, ...patch, updated_at: updatedAt };
      await col.doc(row.id).set({ ...patch, updated_at: updatedAt }, { merge: true });
      updated.push(next);
    }
    if (!this.returning) return { data: null, error: null, count: updated.length };
    const nodes = parseSelect(this.selectSpec || '*');
    return this.finish(updated.map((row) => project(row, nodes)), updated.length);
  }

  private async executeDelete(filters: Filter[]): Promise<QueryResult> {
    const rows = (await loadCandidates(this.collectionName, filters)).filter((row) => passes(row, filters));
    const col = store().collection(this.collectionName);
    for (const row of rows) await col.doc(row.id).delete();
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

function authApi(boundToken?: string) {
  return {
    async getUser(token?: string) {
      const raw = String(token || boundToken || '').replace(/^Bearer\s+/i, '').trim();
      if (!raw) return { data: { user: null }, error: { message: 'Unauthorized' } };
      try {
        const decoded = await getAuth().verifyIdToken(raw);
        return {
          data: {
            user: {
              id: decoded.uid,
              email: decoded.email ?? null,
              user_metadata: { full_name: decoded.name || '' },
            },
          },
          error: null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unauthorized';
        return { data: { user: null }, error: { message } };
      }
    },
    admin: {
      async createUser(input: {
        email: string;
        password: string;
        email_confirm?: boolean;
        user_metadata?: { full_name?: string };
      }) {
        try {
          const user = await getAuth().createUser({
            email: input.email,
            password: input.password,
            displayName: input.user_metadata?.full_name,
            emailVerified: Boolean(input.email_confirm),
          });
          const now = new Date().toISOString();
          const fs = store();
          await fs.collection('profiles').doc(user.uid).set({
            id: user.uid,
            full_name: input.user_metadata?.full_name || '',
            is_active: true,
            company_id: null,
            created_at: now,
            updated_at: now,
          }, { merge: true });
          await fs.collection('user_roles').doc(user.uid).set({
            id: user.uid,
            user_id: user.uid,
            role: 'operador',
            created_at: now,
          }, { merge: true });
          return { data: { user: { id: user.uid, email: user.email } }, error: null };
        } catch (error) {
          const code = (error as { code?: string }).code;
          const message = code === 'auth/email-already-exists'
            ? 'User already registered'
            : (error instanceof Error ? error.message : 'Erro ao criar usuário');
          return { data: { user: null }, error: { message } };
        }
      },
      async deleteUser(id: string) {
        await getAuth().deleteUser(id);
        return { data: { user: { id } }, error: null };
      },
      async updateUserById(id: string, attributes: { password?: string; email?: string }) {
        try {
          const patch: { password?: string; email?: string } = {};
          if (attributes.password) patch.password = attributes.password;
          if (attributes.email) patch.email = attributes.email;
          await getAuth().updateUser(id, patch);
          return { data: { user: { id } }, error: null };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Erro ao atualizar usuário';
          return { data: null, error: { message } };
        }
      },
    },
  };
}

async function invoke(name: string, options?: { body?: unknown; headers?: Record<string, string> }) {
  try {
    const headers: Record<string, string> = { ...(options?.headers ?? {}) };
    if (options?.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await callRoute(name, {
      method: 'POST',
      headers,
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!response.ok) {
      const message = typeof data === 'object' && data && 'error' in data
        ? String((data as { error: unknown }).error)
        : text || `Erro ${response.status} ao chamar ${name}`;
      return { data: null, error: { message } };
    }
    return { data, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao chamar função.';
    return { data: null, error: { message } };
  }
}

function calculateNextChargeDate(baseDate: unknown, recurrenceType: unknown, intervalValue: unknown): string | null {
  const date = new Date(String(baseDate));
  if (Number.isNaN(date.getTime())) return null;
  const interval = Number(intervalValue) || 1;
  const type = String(recurrenceType || '');
  if (type === 'pontual') return null;
  if (type === 'diaria') date.setUTCDate(date.getUTCDate() + interval);
  else if (type === 'semanal') date.setUTCDate(date.getUTCDate() + 7 * interval);
  else if (type === 'quinzenal') date.setUTCDate(date.getUTCDate() + 14 * interval);
  else if (type === 'mensal' || type === 'semestral' || type === 'anual') {
    const months = type === 'mensal' ? interval : type === 'semestral' ? interval * 6 : interval * 12;
    const day = date.getUTCDate();
    date.setUTCMonth(date.getUTCMonth() + months);
    if (date.getUTCDate() < day) date.setUTCDate(0);
  } else {
    return null;
  }
  return date.toISOString();
}

async function rpc(name: string, args: Record<string, unknown> = {}) {
  if (name === 'calculate_next_charge_date') {
    return {
      data: calculateNextChargeDate(args.base_date, args.recurrence_type, args.interval_value),
      error: null,
    };
  }
  return { data: null, error: { message: `Função ${name} não existe.` } };
}

const exportsRoot = join(__dirname, '..', 'data', 'exports');

export function readExportFile(relativePath: string): Buffer | null {
  const cleaned = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
  if (!cleaned || cleaned.startsWith('..') || cleaned.includes('\0')) return null;
  const full = join(exportsRoot, cleaned);
  if (!full.startsWith(exportsRoot) || !existsSync(full)) return null;
  return readFileSync(full);
}

function storageApi() {
  return {
    from(bucket: string) {
      return {
        async upload(filePath: string, content: Uint8Array | Buffer | string, _options?: { contentType?: string; upsert?: boolean }) {
          try {
            const full = join(exportsRoot, bucket, filePath);
            mkdirSync(dirname(full), { recursive: true });
            const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
            writeFileSync(full, bytes);
            return { data: { path: filePath }, error: null };
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Falha ao gravar arquivo.';
            return { data: null, error: { message } };
          }
        },
        async createSignedUrl(filePath: string, _expiresIn: number) {
          const url = `${functionUrl('export-file')}?path=${encodeURIComponent(`${bucket}/${filePath}`)}`;
          return { data: { signedUrl: url }, error: null };
        },
      };
    },
  };
}

export type Db = ReturnType<typeof createClient>;

export function createClient(
  _url?: string,
  _key?: string,
  options?: { global?: { headers?: { Authorization?: string } }; auth?: Record<string, unknown> },
) {
  const header = options?.global?.headers?.Authorization;
  const token = header ? String(header) : undefined;
  return {
    from(name: string) {
      return new FirestoreQuery(name);
    },
    auth: authApi(token),
    functions: { invoke },
    rpc,
    storage: storageApi(),
  };
}
