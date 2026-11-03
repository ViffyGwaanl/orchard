/**
 * End-to-end check of remote mode: starts the built server over HTTP against
 * the fake helper, signs in through the OAuth flow exactly the way an MCP
 * client does (401 → discovery → dynamic registration → consent page with the
 * passphrase → PKCE code exchange), then calls tools with the token.
 * Also checks the refusals: no token, wrong passphrase, foreign redirect,
 * bad PKCE verifier, reused code and reused refresh token.
 *
 * Run: npm run build && npm run smoke:http
 */
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";

const entry = new URL("../dist/index.js", import.meta.url).pathname;
const fake = new URL("../test/fake-helper.mjs", import.meta.url).pathname;
chmodSync(fake, 0o755);

const port = await new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const home = mkdtempSync(join(tmpdir(), "orchard-remote-"));
const base = `http://localhost:${port}`;
const mcpUrl = `${base}/mcp`;
const env = { ...process.env, ORCHARD_HOME: home, ORCHARD_HELPER: fake, FAKE_FDA: "1", TZ: "Asia/Shanghai", ORCHARD_KEEP_AWAKE: "0" };

// remote-init prints only the passphrase on stdout
const init = spawnSync(process.execPath, [entry, "remote-init", "--public-url", mcpUrl, "--port", String(port)], { env, encoding: "utf8" });
assert.equal(init.status, 0, init.stderr);
const passphrase = init.stdout.trim();
assert.match(passphrase, /^[a-z2-9]{5}(-[a-z2-9]{5}){4}$/, `unexpected passphrase output: ${init.stdout}`);
const cfgFile = join(home, "remote", "config.json");
assert.equal(statSync(cfgFile).mode & 0o777, 0o600, "config must be owner-only");
assert.equal(statSync(join(home, "remote")).mode & 0o777, 0o700, "remote dir must be owner-only");
assert.ok(!readFileSync(cfgFile, "utf8").includes(passphrase), "passphrase must not be stored in clear text");
// running it again keeps the passphrase
const again = spawnSync(process.execPath, [entry, "remote-init", "--public-url", mcpUrl, "--port", String(port)], { env, encoding: "utf8" });
assert.equal(again.status, 0, again.stderr);
assert.equal(again.stdout.trim(), "", "re-running remote-init must not print or change the passphrase");
const badUrl = spawnSync(process.execPath, [entry, "remote-init", "--public-url", "http://orchard.example.com/mcp"], { env, encoding: "utf8" });
assert.notEqual(badUrl.status, 0, "plain http on a public host must be refused");

const server = spawn(process.execPath, [entry, "serve-http"], { env, stdio: ["ignore", "inherit", "pipe"] });
let serverLog = "";
server.stderr.on("data", (d) => {
  serverLog += d;
  if (process.env.SMOKE_VERBOSE) process.stderr.write(d);
});
const cleanup = () => {
  server.kill();
  rmSync(home, { recursive: true, force: true });
};
process.on("exit", cleanup);

for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 100));
}

// ---------- refusals before sign-in ----------
let r = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
assert.equal(r.status, 401, "MCP without a token must be 401");
assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
r = await fetch(mcpUrl, { method: "POST", headers: { authorization: "Bearer orc_at_nope", "content-type": "application/json" }, body: "{}" });
assert.equal(r.status, 401, "a made-up token must be 401");

const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
assert.equal(prm.resource, mcpUrl);
assert.deepEqual(prm.authorization_servers.map((s) => s.replace(/\/$/, "")), [base]);
const asMeta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
assert.deepEqual(asMeta.code_challenge_methods_supported, ["S256"]);
assert.ok(asMeta.registration_endpoint);

r = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"] }) });
assert.equal(r.status, 400, "foreign redirect addresses must be refused at registration");
const hostStatus = await new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "GET", headers: { host: "evil.example" } }, (res) => {
    res.resume();
    resolve(res.statusCode);
  });
  req.on("error", reject);
  req.end();
});
assert.equal(hostStatus, 403, "unknown Host header must be refused (DNS rebinding)");

// ---------- the real flow, driven by the SDK's own OAuth client ----------
async function consent(authUrl, pass) {
  const page = await fetch(authUrl);
  assert.equal(page.status, 200, `consent page failed: ${await page.clone().text()}`);
  const html = await page.text();
  assert.match(html, /允许/);
  assert.match(html, /localhost:\d+/, "consent page must show where the code goes");
  const req = html.match(/name="req" value="([^"]+)"/)[1];
  const res = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ req, passphrase: pass, action: "allow" }),
    redirect: "manual",
  });
  return { res, req };
}

const store = {};
const provider = {
  get redirectUrl() {
    return "http://localhost:53682/callback";
  },
  get clientMetadata() {
    return { client_name: "Orchard smoke test", redirect_uris: ["http://localhost:53682/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  },
  clientInformation: () => store.client,
  saveClientInformation: (c) => (store.client = c),
  tokens: () => store.tokens,
  saveTokens: (t) => (store.tokens = t),
  saveCodeVerifier: (v) => (store.verifier = v),
  codeVerifier: () => store.verifier,
  saveDiscoveryState: (d) => (store.discovery = d),
  discoveryState: () => store.discovery,
  redirectToAuthorization: async (url) => {
    // Wrong passphrase first: page comes back with an error, no redirect.
    const wrong = await consent(url, "aaaaa-bbbbb-ccccc-ddddd-eeeee");
    assert.equal(wrong.res.status, 401);
    assert.match(await wrong.res.text(), /口令不对/);
    const ok = await consent(url, passphrase.toUpperCase().replace(/-/g, " - "));
    assert.equal(ok.res.status, 302, "right passphrase (any case/spacing) must redirect");
    const loc = new URL(ok.res.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, "http://localhost:53682/callback");
    assert.equal(loc.searchParams.get("iss")?.replace(/\/$/, ""), base);
    store.code = loc.searchParams.get("code");
    store.authState = loc.searchParams.get("state");
  },
};

let transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider });
let client = new Client({ name: "orchard-smoke-http", version: "1.0.0" });
await assert.rejects(client.connect(transport), UnauthorizedError);
assert.ok(store.code, "flow should have produced a code");
assert.ok(store.client?.client_id?.startsWith("orc_client_"));
await transport.finishAuth(store.code);
assert.ok(store.tokens?.access_token?.startsWith("orc_at_"));
assert.ok(store.tokens?.refresh_token?.startsWith("orc_rt_"));

// A used code must not work twice.
r = await fetch(`${base}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: store.code, client_id: store.client.client_id, code_verifier: store.verifier, redirect_uri: "http://localhost:53682/callback" }),
});
assert.equal(r.status, 400);
assert.equal((await r.json()).error, "invalid_grant");

transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider });
client = new Client({ name: "orchard-smoke-http", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
assert.ok(tools.length >= 30, `expected the full tool list over HTTP, got ${tools.length}`);
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
  assert.ok(!res.isError, `${name} failed: ${res.content.map((c) => c.text).join("\n")}`);
  return res.content.map((c) => c.text).join("\n");
};
assert.match(await call("apple_status"), /Reminders — allowed/);
assert.match(await call("apple_today"), /Pay office rent/);
assert.match(await call("reminders_create", { items: [{ title: "从云端加的待办", due: "tomorrow" }] }), /Created 1 reminder/);
await client.close();

// ---------- PKCE mismatch ----------
{
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const u = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: store.client.client_id, redirect_uri: "http://localhost:40000/callback", code_challenge: challenge, code_challenge_method: "S256", state: "s1", resource: mcpUrl })) u.searchParams.set(k, v);
  const { res } = await consent(u.href, passphrase);
  assert.equal(res.status, 302, "loopback redirect on another port must be accepted");
  const code = new URL(res.headers.get("location")).searchParams.get("code");
  r = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: store.client.client_id, code_verifier: randomBytes(32).toString("base64url") }),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "invalid_grant", "wrong PKCE verifier must fail");
  // plain PKCE is refused
  u.searchParams.set("code_challenge_method", "plain");
  const plain = await fetch(u.href, { redirect: "manual" });
  assert.equal(plain.status, 302);
  assert.equal(new URL(plain.headers.get("location")).searchParams.get("error"), "invalid_request");
  // an unregistered redirect gets an error page, never a redirect
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  const foreign = await fetch(u.href, { redirect: "manual" });
  assert.equal(foreign.status, 400);
}

// ---------- refresh rotation ----------
const refresh = async (rt) =>
  fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: store.client.client_id }),
  });
r = await refresh(store.tokens.refresh_token);
assert.equal(r.status, 200);
const rotated = await r.json();
assert.notEqual(rotated.refresh_token, store.tokens.refresh_token);
r = await refresh(store.tokens.refresh_token);
assert.equal(r.status, 400, "an old refresh token must stop working after rotation");
assert.equal((await r.json()).error, "invalid_grant");
r = await fetch(mcpUrl, {
  method: "POST",
  headers: { authorization: `Bearer ${rotated.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } }),
});
assert.equal(r.status, 200, `refreshed token should work: ${await r.clone().text()}`);

// ---------- state survives a restart, codes and tokens are hashed on disk ----------
const stateText = readFileSync(join(home, "remote", "oauth-state.json"), "utf8");
assert.ok(!stateText.includes(rotated.access_token) && !stateText.includes(rotated.refresh_token), "tokens must be stored hashed");
assert.equal(statSync(join(home, "remote", "oauth-state.json")).mode & 0o777, 0o600);

// ---------- rate limit on the passphrase ----------
{
  const verifier = randomBytes(32).toString("base64url");
  const u = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: store.client.client_id, redirect_uri: "http://localhost:53682/callback", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" })) u.searchParams.set(k, v);
  const html = await (await fetch(u.href)).text();
  const req = html.match(/name="req" value="([^"]+)"/)[1];
  const post = (pass) =>
    fetch(`${base}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ req, passphrase: pass, action: "allow" }),
      redirect: "manual",
    });
  for (let i = 0; i < 5; i++) assert.equal((await post(`wrong-${i}`)).status, 401);
  const locked = await post(passphrase);
  assert.equal(locked.status, 429, "after 5 wrong guesses even the right passphrase waits");
  assert.match(await locked.text(), /之后再试/);
  assert.doesNotMatch(await (await fetch(u.href)).text(), /name="passphrase"/, "a locked server shows no form");
}

// ---------- remote-reset signs everyone out ----------
server.kill();
await new Promise((r) => server.once("exit", r));
const reset = spawnSync(process.execPath, [entry, "remote-reset"], { env, encoding: "utf8" });
assert.equal(reset.status, 0, reset.stderr);
assert.notEqual(reset.stdout.trim(), passphrase);
const after = JSON.parse(readFileSync(join(home, "remote", "oauth-state.json"), "utf8"));
assert.equal(Object.keys(after.refresh).length, 0);
assert.equal(Object.keys(after.clients).length, 0);

console.error(`HTTP smoke test passed: OAuth sign-in, ${tools.length} tools over Streamable HTTP, refusals, rotation and reset.`);
if (process.env.SMOKE_VERBOSE) console.error(serverLog);
process.exit(0);
