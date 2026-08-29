/** Minimal in-memory stand-in for the Supabase query builder used by delivery code. */
type Row = Record<string, any>;

export interface FakeDb {
  tables: Record<string, Row[]>;
  from: (table: string) => any;
  rpc: (...args: unknown[]) => Promise<{ data: null; error: null }>;
}

export function createFakeDb(tables: Record<string, Row[]>): FakeDb {
  const store: Record<string, Row[]> = JSON.parse(JSON.stringify(tables));

  function makeBuilder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    let limit: number | null = null;

    const run = () => {
      const rows = store[table] ?? (store[table] = []);
      if (mode === "insert") {
        // Emulate the unique(order_id) constraint used as the duplicate guard.
        if (payload["order_id"] && rows.some((r) => r["order_id"] === payload["order_id"])) {
          return { data: null, error: { code: "23505" } };
        }
        const row = { id: `row_${rows.length + 1}`, attempt_count: 0, ...payload };
        rows.push(row);
        return { data: row, error: null };
      }
      let matched = rows.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") {
        matched.forEach((r) => Object.assign(r, payload));
      }
      if (limit !== null) matched = matched.slice(0, limit);
      return { data: matched, error: null };
    };

    const builder: any = {
      select: () => builder,
      insert: (values: Row) => {
        mode = "insert";
        payload = values;
        return builder;
      },
      update: (values: Row) => {
        mode = "update";
        payload = values;
        return builder;
      },
      eq: (col: string, value: unknown) => {
        filters.push((r) => r[col] === value);
        return builder;
      },
      neq: (col: string, value: unknown) => {
        filters.push((r) => r[col] !== value);
        return builder;
      },
      in: (col: string, values: unknown[]) => {
        filters.push((r) => values.includes(r[col]));
        return builder;
      },
      is: (col: string, value: unknown) => {
        filters.push((r) => (r[col] ?? null) === value);
        return builder;
      },
      not: () => builder,
      gte: () => builder,
      lte: () => builder,
      order: () => builder,
      limit: (n: number) => {
        limit = n;
        return builder;
      },
      maybeSingle: async () => {
        const result = run();
        if (Array.isArray(result.data)) return { data: result.data[0] ?? null, error: null };
        return result;
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  return {
    tables: store,
    from: (table: string) => makeBuilder(table),
    rpc: async () => ({ data: null, error: null }),
  };
}
