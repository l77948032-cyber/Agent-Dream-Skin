const READ_ONLY_ACTIONS = new Set(["inspect"]);

function updateText(update) {
  if (update?.sessionUpdate !== "agent_message_chunk") return "";
  return update.content?.type === "text" ? update.content.text : "";
}

export function agentResponseText(updates) {
  const messages = updates.filter((update) => update?.sessionUpdate === "agent_message_chunk");
  const finalMessages = messages.filter((update) => update?._meta?.codex?.phase === "final_answer");
  return (finalMessages.length ? finalMessages : messages).map(updateText).join("").trim();
}

export function agentResponseFailure(updates) {
  const text = agentResponseText(updates);
  for (const line of text.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const payload = JSON.parse(candidate);
      if (payload?.type === "error" && typeof payload.error?.message === "string") {
        return payload.error.message;
      }
    } catch {}
  }
  return null;
}

function inputArguments(rawInput) {
  const value = rawInput?.arguments ?? rawInput?.input;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function allowedThemeTool(rawInput, policy = {}) {
  if (rawInput?.server !== "dreamskin-tool-compat" || rawInput.tool !== "dreamskin_theme") return false;
  const input = inputArguments(rawInput);
  const pluginId = input.pluginId || "dreamskin.trae";
  if (policy.pluginId && pluginId !== policy.pluginId) return false;
  if (READ_ONLY_ACTIONS.has(input.action)) return true;
  if (!policy.themeId || input.themeId !== policy.themeId) return false;
  if (input.action === "read" || input.action === "validate") return input.theme === undefined;
  if (input.action !== "update") return false;
  return input.imagePath === undefined
    && typeof input.expectedRevision === "string"
    && input.expectedRevision.length > 0
    && input.expectedRevision === policy.expectedRevision;
}

export function permissionResponse(params, policy = {}) {
  const isAllowed = allowedThemeTool(params.toolCall?.rawInput, policy);
  const kind = isAllowed ? "allow_once" : "reject_once";
  const option = params.options.find((candidate) => candidate.kind === kind)
    || (!isAllowed ? params.options.find((candidate) => candidate.kind === "reject_always") : null);
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}
