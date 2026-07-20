import assert from "node:assert/strict";
import test from "node:test";

import { agentResponseFailure, agentResponseText, permissionResponse } from "../src/core/acp-policy.mjs";

const options = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "reject", name: "Reject once", kind: "reject_once" },
];

const policy = {
  pluginId: "dreamskin.trae",
  themeId: "sunlit-spark-copy",
  expectedRevision: "revision-1",
};

function permission(rawInput, overrides = policy) {
  return permissionResponse({ toolCall: { toolCallId: "call-1", rawInput }, options }, overrides);
}

test("ACP policy allows only the scoped DreamSkin Tool action", () => {
  const call = (action, argumentsInput = {}) => ({
    server: "dreamskin-tool-compat",
    tool: "dreamskin_theme",
    arguments: { action, ...argumentsInput },
  });
  assert.equal(permission(call("inspect")).outcome.optionId, "allow");
  assert.equal(permission(call("list")).outcome.optionId, "reject");
  assert.equal(permission(call("read", { themeId: policy.themeId })).outcome.optionId, "allow");
  assert.equal(permission(call("update", { themeId: policy.themeId, expectedRevision: policy.expectedRevision, themePatch: {} })).outcome.optionId, "allow");
  assert.equal(permission(call("validate", { themeId: policy.themeId })).outcome.optionId, "allow");
  assert.equal(permission(call("create", { themeId: policy.themeId, themePatch: {} })).outcome.optionId, "reject");
  assert.equal(permission(call("update", { themeId: "other", expectedRevision: policy.expectedRevision, themePatch: {} })).outcome.optionId, "reject");
  assert.equal(permission(call("update", { themeId: policy.themeId, expectedRevision: "stale", themePatch: {} })).outcome.optionId, "reject");
  assert.equal(permission(call("validate", { theme: {} })).outcome.optionId, "reject");
  assert.equal(permission({ server: "trae-dream-skin", tool: "theme_write" }).outcome.optionId, "reject");
  assert.equal(permission({ server: "other-server", tool: "dreamskin_theme" }).outcome.optionId, "reject");
  assert.equal(permission({ command: "node", args: ["script.mjs"] }).outcome.optionId, "reject");
});

test("ACP policy resolves an omitted plugin id from the WorkBuddy session scope", () => {
  const workBuddyPolicy = {
    pluginId: "dreamskin.workbuddy",
    themeId: "harbor-focus-copy",
    expectedRevision: "revision-workbuddy-1",
  };
  const call = (action, argumentsInput = {}) => ({
    server: "dreamskin-tool-compat",
    tool: "dreamskin_theme",
    arguments: { action, ...argumentsInput },
  });

  assert.equal(permission(call("inspect"), workBuddyPolicy).outcome.optionId, "allow");
  assert.equal(permission(call("read", {
    themeId: workBuddyPolicy.themeId,
  }), workBuddyPolicy).outcome.optionId, "allow");
  assert.equal(permission(call("update", {
    themeId: workBuddyPolicy.themeId,
    expectedRevision: workBuddyPolicy.expectedRevision,
    themePatch: {},
  }), workBuddyPolicy).outcome.optionId, "allow");
  assert.equal(permission(call("inspect", {
    pluginId: "dreamskin.trae",
  }), workBuddyPolicy).outcome.optionId, "reject");
});

test("ACP response text prefers the final answer over progress messages", () => {
  const updates = [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Checking..." } },
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Theme updated." },
      _meta: { codex: { phase: "final_answer" } },
    },
  ];
  assert.equal(agentResponseText(updates), "Theme updated.");
  assert.equal(agentResponseText(updates.slice(0, 1)), "Checking...");
});

test("ACP response failures recognize structured agent errors without guessing from prose", () => {
  const failure = [{
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: 'Warning from adapter\n{"type":"error","status":400,"error":{"message":"Upgrade Codex CLI."}}',
    },
  }];
  assert.equal(agentResponseFailure(failure), "Upgrade Codex CLI.");
  assert.equal(agentResponseFailure([{
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "The theme has an error badge style." },
  }]), null);
});
