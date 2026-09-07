// Pure checks on the API-key proxy's routing, pricing and the webhook
// address filter. No database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRoute, estimateRequest, parseUsage } from "../lib/proxy";
import { isPrivateAddress } from "../lib/notify";

test("proxy forwards only priceable endpoints", () => {
  assert.equal(classifyRoute("openai", "POST", "chat/completions"), "generate");
  assert.equal(classifyRoute("openai", "POST", "responses"), "generate");
  assert.equal(classifyRoute("openai", "POST", "embeddings"), "generate");
  assert.equal(classifyRoute("openai", "GET", "models"), "free");
  assert.equal(classifyRoute("openai", "GET", "models/gpt-4o"), "free");
  assert.equal(classifyRoute("openai", "POST", "files"), null);
  assert.equal(classifyRoute("openai", "GET", "organization/usage"), null);
  assert.equal(classifyRoute("openai", "POST", "fine_tuning/jobs"), null);
  assert.equal(classifyRoute("openai", "DELETE", "models/x"), null);
  assert.equal(classifyRoute("openai", "POST", "../admin"), null);
  assert.equal(classifyRoute("openai", "POST", "chat//completions"), null);
  assert.equal(classifyRoute("anthropic", "POST", "messages"), "generate");
  assert.equal(classifyRoute("anthropic", "POST", "messages/batches"), null);
  assert.equal(classifyRoute("gemini", "POST", "models/gemini-2.5-flash:generateContent"), "generate");
  assert.equal(classifyRoute("gemini", "POST", "models/gemini-2.5-flash:streamGenerateContent"), "generate");
  assert.equal(classifyRoute("gemini", "POST", "tunedModels/x:generateContent"), null);
  assert.equal(classifyRoute("gemini", "POST", "files"), null);
});

test("estimates budget for attachments, hidden history and snake_case configs", () => {
  const plain = estimateRequest("openai", "chat/completions", { model: "gpt-4o", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
  const withImage = estimateRequest("openai", "chat/completions", { model: "gpt-4o", max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "https://x/y.png" } }] }] });
  assert.ok(withImage.inputTokens > plain.inputTokens + 1000);
  const cont = estimateRequest("openai", "responses", { model: "gpt-4o", max_output_tokens: 100, input: "more", previous_response_id: "resp_1" });
  assert.ok(cont.inputTokens > 30_000);
  const g = estimateRequest("gemini", "models/gemini-2.5-flash:generateContent", { contents: [{ parts: [{ text: "hi" }] }], generation_config: { max_output_tokens: 10 } });
  assert.equal(g.outputTokens, 10);
  const n = estimateRequest("openai", "chat/completions", { model: "gpt-4o", max_tokens: 100, n: 3, messages: [] });
  assert.equal(n.outputTokens, 300);
  // Token counting costs nothing at the provider: forwarded without authorisation.
  assert.equal(classifyRoute("anthropic", "POST", "messages/count_tokens"), "free");
  assert.equal(classifyRoute("gemini", "POST", "models/gemini-2.5-flash:countTokens"), "free");
});

test("gemini thinking tokens settle as output", () => {
  const u = parseUsage("gemini", JSON.stringify({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 300 } }));
  assert.deepEqual(u, { inputTokens: 10, outputTokens: 320, cachedTokens: 0 });
});

test("webhook targets cannot point inside the network", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "[::ffff:7f00:1]", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "224.0.0.1", "not-an-ip"]) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111", "100.128.0.1", "::ffff:808:808"]) assert.equal(isPrivateAddress(ip), false, ip);
});
