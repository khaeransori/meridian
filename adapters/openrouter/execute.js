// adapters/openrouter/execute.js
//
// OpenRouter / OpenAI-compatible adapter — extracted verbatim from the
// previous inline ReAct loop in agent.js. No behavior change.

import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { log } from "../../logger.js";
import { config } from "../../config.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio)
// To use LM Studio: set LLM_BASE_URL=http://localhost:1234/v1 and LLM_API_KEY=lm-studio in .env
const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000,
});

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute the ReAct loop against an OpenAI-compatible endpoint.
 *
 * Returns:
 *   {
 *     content,      // string — final assistant text
 *     toolCalls,    // [{ name, args, result }, ...]
 *     usage,        // { inputTokens, outputTokens }
 *     costUsd,      // null (OpenRouter doesn't return cost in completion responses)
 *     billingType,  // "openrouter"
 *     model,        // model id actually used
 *   }
 */
export async function execute({
  systemPrompt,
  userPrompt,
  sessionHistory,
  tools,
  agentType,
  model,
  maxTurns,
  maxOutputTokens,
  toolExecutor,
  onToolStart,
  onToolFinish,
  toolChoiceForFirstStep,
}) {
  const goal = userPrompt;

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  const firedOnce = new Set();
  const mustUseRealTool = toolChoiceForFirstStep === "required";
  let sawToolCall = false;
  let noToolRetryCount = 0;

  // Aggregate results to return to caller
  const collectedToolCalls = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let lastUsedModel = model;

  const FALLBACK_MODEL = "stepfun/step-3.5-flash:free";

  for (let step = 0; step < maxTurns; step++) {
    log("agent", `Step ${step + 1}/${maxTurns}`);

    try {
      const activeModel = model;

      // Retry up to 3 times on transient provider errors (502, 503, 529)
      let response;
      let usedModel = activeModel;
      // Force a tool call on step 0 for action intents — caller pre-computed this
      let toolChoice = step === 0 ? toolChoiceForFirstStep : "auto";

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const createParams = {
            model: usedModel,
            messages,
            tools,
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          };
          if (toolChoice !== "none") createParams.tool_choice = toolChoice;
          response = await client.chat.completions.create(createParams);
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (isToolChoiceRequiredError(error)) {
            if (toolChoice === "required") {
              toolChoice = "auto";
              log("agent", "Provider rejected tool_choice=required — retrying with tool_choice=auto");
            } else {
              toolChoice = "none";
              log("agent", "Provider rejected tool_choice=auto — retrying without tool_choice");
            }
            attempt -= 1;
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }

      lastUsedModel = usedModel;
      if (response.usage) {
        inputTokens += response.usage.prompt_tokens || 0;
        outputTokens += response.usage.completion_tokens || 0;
      }

      const msg = response.choices[0].message;
      // Repair malformed tool call JSON before pushing to history —
      // the API rejects the next request if history contains invalid JSON args
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                log("error", `Could not repair JSON args for ${tc.function.name} — cleared to {}`);
              }
            }
          }
        }
      }
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
          if (noToolRetryCount >= 2) {
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              toolCalls: collectedToolCalls,
              usage: { inputTokens, outputTokens },
              costUsd: null,
              billingType: "openrouter",
              model: lastUsedModel,
            };
          }
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content: providerMode === "system"
              ? "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result."
              : "[SYSTEM REMINDER]\nYou have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return {
          content: msg.content,
          toolCalls: collectedToolCalls,
          usage: { inputTokens, outputTokens },
          costUsd: null,
          billingType: "openrouter",
          model: lastUsedModel,
        };
      }
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            functionArgs = {};
          }
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          const blockedResult = { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` };
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: blockedResult,
            success: false,
            step,
          });
          collectedToolCalls.push({ name: functionName, args: functionArgs, result: blockedResult });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(blockedResult),
          };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        const result = await toolExecutor(functionName, functionArgs);
        await onToolFinish?.({
          name: functionName,
          args: functionArgs,
          result,
          success: result?.success !== false && !result?.error && !result?.blocked,
          step,
        });

        collectedToolCalls.push({ name: functionName, args: functionArgs, result });

        // Lock deploy_position after first attempt regardless of outcome — retrying is never right
        // For close/swap: only lock on success so genuine failures can be retried
        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return {
    content: "Max steps reached. Review logs for partial progress.",
    toolCalls: collectedToolCalls,
    usage: { inputTokens, outputTokens },
    costUsd: null,
    billingType: "openrouter",
    model: lastUsedModel,
  };
}
