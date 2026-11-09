import type pg from "pg";

/** A node-postgres pool, or a client inside the caller's transaction. */
export type Queryable = Pick<pg.ClientBase, "query">;

/**
 * Runs `work` in one plain transaction on a pooled client: commit when it returns, rollback when
 * it throws, and the error goes on to the caller. A connection that cannot even roll back is
 * discarded instead of returned to the pool. Writers with a retry policy of their own (the engine,
 * the plan writer) keep their own wrappers.
 */
export async function withTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    broken = !(await client.query("rollback").then(
      () => true,
      () => false,
    ));
    throw error;
  } finally {
    client.release(broken);
  }
}
