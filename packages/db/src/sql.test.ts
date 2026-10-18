import { describe, expect, it, vi } from "vitest";
import {
  type SqlStorage,
  type SqlStorageCursor,
  execScript,
  execute,
  queryAll,
  queryOne,
  queryOneOrThrow,
} from "./sql.js";

function makeSql(rows: unknown[] = []) {
  const cursor: SqlStorageCursor = {
    toArray: <T>() => rows as T[],
    one: <T>() => rows[0] as T,
    raw: <T extends unknown[]>() => rows as T[],
  };
  const exec = vi.fn(() => cursor);
  return { sql: { exec } as unknown as SqlStorage, exec };
}

describe("Durable Object SQLite helpers", () => {
  it("passes positional parameters unchanged and returns all selected rows", () => {
    const rows = [{ id: "row-1" }, { id: "row-2" }];
    const { sql, exec } = makeSql(rows);
    expect(
      queryAll<{ id: string }>(
        sql,
        "SELECT id FROM records WHERE id = ?",
        "row-1"
      )
    ).toBe(rows);
    expect(exec).toHaveBeenCalledWith(
      "SELECT id FROM records WHERE id = ?",
      "row-1"
    );
  });

  it("returns the first row or null without changing database errors", () => {
    const { sql } = makeSql([{ id: "first" }, { id: "second" }]);
    expect(queryOne<{ id: string }>(sql, "SELECT id FROM records")).toEqual({
      id: "first",
    });
    expect(queryOne(makeSql().sql, "SELECT id FROM records")).toBeNull();
    const failure = new Error("database unavailable");
    const broken: SqlStorage = {
      exec: () => {
        throw failure;
      },
    };
    expect(() => queryOne(broken, "SELECT id FROM records")).toThrow(failure);
  });

  it("throws only when queryOneOrThrow receives no row", () => {
    expect(
      queryOneOrThrow(makeSql([{ id: "row-1" }]).sql, "SELECT id FROM records")
    ).toEqual({ id: "row-1" });
    expect(() =>
      queryOneOrThrow(makeSql().sql, "SELECT id FROM records")
    ).toThrow("Expected one row, got zero");
  });

  it("forwards write statements and parameters without rewriting the query", () => {
    const { sql, exec } = makeSql();
    execute(sql, "UPDATE records SET value = ? WHERE id = ?", "value", "row-1");
    expect(exec).toHaveBeenCalledWith(
      "UPDATE records SET value = ? WHERE id = ?",
      "value",
      "row-1"
    );
  });

  it("executes schema scripts sequentially and stops at the first failure", () => {
    const { sql, exec } = makeSql();
    execScript(
      sql,
      "CREATE TABLE first(id TEXT)",
      "CREATE INDEX first_id ON first(id)"
    );
    expect(exec.mock.calls).toEqual([
      ["CREATE TABLE first(id TEXT)"],
      ["CREATE INDEX first_id ON first(id)"],
    ]);

    const failing = vi.fn().mockImplementationOnce(() => {
      throw new Error("bad DDL");
    });
    expect(() =>
      execScript({ exec: failing } as unknown as SqlStorage, "bad", "skipped")
    ).toThrow("bad DDL");
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
