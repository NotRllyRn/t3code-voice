import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

it.effect.each([67, 81, 88, 97, 103, 118])(
  "preserves saved conversation data at migration %s",
  (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: id });
      if (id === 103) {
        yield* sql`
        INSERT INTO issue_tracker_bindings (project_id, tracker, scope, updated_at)
        VALUES ('saved-project', 'linear', 'saved-team', '2026-01-01')
      `;
      }
      const payload = JSON.stringify({
        text: "Saved voice conversation",
        voice: { sessionId: "voice-session", segmentId: "voice-segment", playback: "interrupted" },
        phase: "partial_answer",
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('saved-message', 'saved-thread', 'assistant', 0, '2026-01-01', '2026-01-01', ${payload})
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
        VALUES ('saved-item', 'saved-thread', 17, 'assistant_message', 'completed', '2026-01-01', ${payload})
      `;
      // Compare every pre-existing column and row, not just the voice tables.
      const tables = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
          AND name NOT IN ('effect_sql_migrations', 'sqlite_sequence')
      `;
      const snapshots = yield* Effect.forEach(tables, ({ name }) =>
        Effect.gen(function* () {
          const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
          const columns = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${quote(name)})`);
          const query = `SELECT ${columns.map((column) => quote(column.name)).join(", ")} FROM ${quote(name)}`;
          return { query, rows: yield* sql.unsafe(query) };
        }),
      );
      const beforeHistory = yield* history;
      const applied = yield* runMigrations();
      assert.deepStrictEqual(
        applied,
        migrationManifest.filter(([number]) => number > id),
      );
      for (const { query, rows } of snapshots) {
        assert.deepStrictEqual(yield* sql.unsafe(query), rows, query);
      }
      assert.deepStrictEqual((yield* history).slice(0, beforeHistory.length), beforeHistory);
      assert.deepStrictEqual(yield* runMigrations(), []);
      const issueTables = yield* sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'issue_tracker_bindings'
    `;
      assert.deepStrictEqual(issueTables, [{ name: "issue_tracker_bindings" }]);
      if (id === 103) {
        assert.deepStrictEqual(
          yield* sql`SELECT project_id, tracker, scope, updated_at, additional_scopes, account_id FROM issue_tracker_bindings`,
          [
            {
              project_id: "saved-project",
              tracker: "linear",
              scope: "saved-team",
              updated_at: "2026-01-01",
              additional_scopes: "[]",
              account_id: null,
            },
          ],
        );
      }
      const generationColumns = yield* sql<{ name: string }>`
      SELECT name FROM pragma_table_info('scheduled_tasks') WHERE name = 'task_generation'
    `;
      assert.deepStrictEqual(generationColumns, [{ name: "task_generation" }]);
      const columns = yield* sql<{ name: string }>`
        SELECT name FROM pragma_table_info('projection_projects')
      `;
      assert.include(
        columns.map((column) => column.name),
        "has_custom_title",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it("registers unique contiguous numeric migration IDs", () => {
  const ids = migrationManifest.map(([id]) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepStrictEqual(
    ids,
    Array.from({ length: ids.length }, (_, index) => index + 1),
  );
});
