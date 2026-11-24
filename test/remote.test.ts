import { test } from "node:test";
import { strict as assert } from "node:assert";
import { checkPassphrase, generatePassphrase, hashPassphrase, validatePublicUrl } from "../src/remote/config.ts";
import { isAllowedRedirect, redirectMatches } from "../src/remote/oauth.ts";

test("only Claude's own redirect addresses can register", () => {
  assert.ok(isAllowedRedirect("https://claude.ai/api/mcp/auth_callback"));
  assert.ok(isAllowedRedirect("http://localhost:3118/callback"));
  assert.ok(isAllowedRedirect("http://127.0.0.1:50123/callback"));
  assert.ok(!isAllowedRedirect("https://claude.ai.evil.example/api/mcp/auth_callback"));
  assert.ok(!isAllowedRedirect("https://claude.ai/api/mcp/auth_callback?x=1"));
  assert.ok(!isAllowedRedirect("http://localhost:3118/other"));
  assert.ok(!isAllowedRedirect("https://localhost:3118/callback"));
  assert.ok(!isAllowedRedirect("http://user@localhost:3118/callback"));
  assert.ok(!isAllowedRedirect("javascript:alert(1)"));
});

test("loopback redirects match on any port, hosted ones exactly", () => {
  assert.ok(redirectMatches(["http://localhost/callback"], "http://localhost:4444/callback"));
  assert.ok(!redirectMatches(["http://localhost/callback"], "http://127.0.0.1:4444/callback"));
  assert.ok(redirectMatches(["https://claude.ai/api/mcp/auth_callback"], "https://claude.ai/api/mcp/auth_callback"));
  assert.ok(!redirectMatches(["https://claude.ai/api/mcp/auth_callback"], "https://claude.com/api/mcp/auth_callback"));
});

test("passphrases are random, typeable and checked by hash", () => {
  const a = generatePassphrase();
  assert.match(a, /^[a-z2-9]{5}(-[a-z2-9]{5}){4}$/);
  assert.notEqual(a, generatePassphrase());
  const h = hashPassphrase(a);
  assert.ok(!JSON.stringify(h).includes(a));
  assert.ok(checkPassphrase(a, h));
  assert.ok(checkPassphrase(` ${a.toUpperCase()} `, h));
  assert.ok(!checkPassphrase(`${a}x`, h));
  assert.ok(!checkPassphrase("", h));
});

test("public URL must be https with a path", () => {
  assert.equal(validatePublicUrl("https://orchard.example.com/mcp").href, "https://orchard.example.com/mcp");
  assert.throws(() => validatePublicUrl("http://orchard.example.com/mcp"));
  assert.throws(() => validatePublicUrl("https://orchard.example.com"));
  assert.throws(() => validatePublicUrl("https://orchard.example.com/mcp/"));
  assert.throws(() => validatePublicUrl("https://orchard.example.com/mcp?token=x"));
  assert.ok(validatePublicUrl("http://localhost:8787/mcp"));
});
