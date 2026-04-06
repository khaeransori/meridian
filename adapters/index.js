// adapters/index.js
//
// LLM provider adapter registry and dispatcher.
// Each adapter exports an `execute()` function with the same shape — see
// docs/plans/2026-04-06-llm-provider-adapters-design.md for the contract.

const ADAPTERS = {};

/**
 * Lazy-load an adapter by name. Adapters are loaded on first use to avoid
 * importing dependencies (e.g. @modelcontextprotocol/sdk) when not needed.
 */
export async function getAdapter(name) {
  if (!ADAPTERS[name]) {
    switch (name) {
      case "openrouter":
        ADAPTERS[name] = await import("./openrouter/execute.js");
        break;
      case "claude-local":
        ADAPTERS[name] = await import("./claude-local/execute.js");
        break;
      default:
        throw new Error(`Unknown LLM provider: ${name}`);
    }
  }
  return ADAPTERS[name];
}

// Map agent role constants → config key suffixes.
// agentType is "MANAGER" | "SCREENER" | "GENERAL", but config keys use
// "management" | "screening" | "general" to match the existing
// managementModel / screeningModel / generalModel naming in user-config.json.
const ROLE_KEY = {
  MANAGER:  "management",
  SCREENER: "screening",
  GENERAL:  "general",
};

function roleKey(agentType) {
  return ROLE_KEY[agentType] || agentType.toLowerCase();
}

/**
 * Resolve which provider should handle this agent role.
 * Resolution order:
 *   1. config.providers[role]
 *   2. config.providers.default
 *   3. "openrouter" (hardcoded fallback for backward compat)
 */
export function resolveProvider(agentType, config) {
  const role = roleKey(agentType);
  const providers = config.providers || {};
  return providers[role] || providers.default || "openrouter";
}

/**
 * Resolve which model the chosen provider should use for this role.
 * Resolution order:
 *   1. config[providerKey].models[role]
 *   2. config[providerKey].models.default
 *   3. legacy <role>Model key (config.llm.managementModel etc.) — backward compat
 *   4. legacy LLM_MODEL env var or hardcoded default
 */
export function resolveModel(provider, agentType, config) {
  const role = roleKey(agentType);
  const providerKey = provider === "claude-local" ? "claudeLocal" : provider;
  const providerConfig = config[providerKey] || {};
  const models = providerConfig.models || {};
  if (models[role]) return models[role];
  if (models.default) return models.default;
  const legacyKey = `${role}Model`;
  if (config.llm?.[legacyKey]) return config.llm[legacyKey];
  return process.env.LLM_MODEL || "openrouter/healer-alpha";
}
