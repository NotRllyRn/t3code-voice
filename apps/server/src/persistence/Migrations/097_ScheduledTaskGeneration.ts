import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN task_generation TEXT NOT NULL DEFAULT ''`;
  yield* sql`UPDATE scheduled_tasks SET task_generation = lower(hex(randomblob(16)))`;
  yield* sql`CREATE TRIGGER scheduled_task_generation_insert AFTER INSERT ON scheduled_tasks BEGIN
    UPDATE scheduled_tasks SET task_generation = lower(hex(randomblob(16))) WHERE task_id = NEW.task_id;
  END`;
  yield* sql`CREATE TRIGGER scheduled_task_generation_update AFTER UPDATE OF
    title, prompt, enabled, schedule_json, project_id, thread_id, thread_mode,
    workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
    webhook_token, webhook_secret ON scheduled_tasks BEGIN
    UPDATE scheduled_tasks SET task_generation = lower(hex(randomblob(16))) WHERE task_id = NEW.task_id;
  END`;
});
