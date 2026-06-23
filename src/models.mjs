// Map an agent's reasoning level to the concrete model parameters the chosen
// model actually supports. Cursor models expose tunables via Cursor.models.list()
// — Claude models have `effort` (low/medium/high/xhigh/max) + `thinking`,
// GPT models have `reasoning` (none/low/medium/high/extra-high). We only set
// params the model declares, so this is safe across models.

import { Cursor } from "@cursor/sdk";

let _cache = null;
let _tried = false;

async function models(apiKey) {
  if (_tried) return _cache || [];
  _tried = true;
  try { _cache = await Cursor.models.list({ apiKey }); } catch { _cache = []; }
  return _cache || [];
}

const LEVEL = { low: "low", medium: "medium", high: "high" };

/**
 * @returns {Promise<{id:string, params?:Array<{id,value}>}>}
 */
export async function modelSelectionFor(agent, apiKey) {
  const id = agent.model;
  const reasoning = LEVEL[agent.reasoning] || "medium";
  const list = await models(apiKey);
  const m = list.find((x) => x.id === id);
  if (!m || !m.parameters) return { id };

  const params = [];
  for (const p of m.parameters) {
    if (p.id === "effort" || p.id === "reasoning") {
      const vals = p.values.map((v) => v.value);
      const pick = vals.includes(reasoning) ? reasoning : (vals.includes("medium") ? "medium" : vals[0]);
      if (pick) params.push({ id: p.id, value: pick });
    } else if (p.id === "thinking" && reasoning === "high") {
      params.push({ id: "thinking", value: "true" });
    }
  }
  return params.length ? { id, params } : { id };
}
