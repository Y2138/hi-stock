import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import { jobFlowAvailableTools } from "../../agent/tools.js";
import { strategyEvaluatorMetadata } from "./registry.js";
import {
  getStrategyRuntimeDefinition,
  listStrategyEvaluationRuns,
  listStrategyRuntimeDefinitions,
} from "./repo.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
}

function limitOf(query: URLSearchParams): number {
  const raw = query.get("limit") ?? "50";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw apiErrors.badRequest("limit 必须是 1-200 的整数");
  }
  return value;
}

function withEvaluatorMetadata<T extends { entry_evaluator_code: string | null; exit_evaluator_code: string | null; context_evaluator_code: string | null; tasks: Array<{ code: string }> }>(definition: T) {
  return { ...definition, tasks: definition.tasks.map((task) => ({ ...task, available_tools: jobFlowAvailableTools(task.code) })), evaluators: {
    entry: strategyEvaluatorMetadata(definition.entry_evaluator_code),
    exit: strategyEvaluatorMetadata(definition.exit_evaluator_code),
    context: strategyEvaluatorMetadata(definition.context_evaluator_code),
  } };
}

export const strategyRuntimeRoutes = {
  async list({ pool }: Ctx) {
    return { data: (await listStrategyRuntimeDefinitions(pool)).map(withEvaluatorMetadata) };
  },
  async get({ pool, params }: Ctx) {
    return { data: withEvaluatorMetadata(await getStrategyRuntimeDefinition(pool, params.code!)) };
  },
  async evaluations({ pool, params, query }: Ctx) {
    return { data: await listStrategyEvaluationRuns(pool, params.code!, limitOf(query)) };
  },
};
