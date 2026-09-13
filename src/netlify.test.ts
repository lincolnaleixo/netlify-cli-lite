import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as netlify from "./client.ts";
import { assertAllowedFlags, formatEnvMutation, parseArgs, usage } from "./cli.ts";

const site = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  name: "mortgage-recast-calculator",
  url: "https://mortgage-recast-calculator.netlify.app",
  ssl_url: "https://mortgage-recast-calculator.netlify.app",
  custom_domain: "mycalcexpert.com",
  default_domain: "mortgage-recast-calculator.netlify.app",
  domain_aliases: ["www.mycalcexpert.com"],
  state: "configured",
  account_slug: "account-slug",
  account_name: "test-account",
  build_settings: {
    repo_url: "https://github.com/example/mortgage-recast-calculator",
    repo_branch: "main",
    cmd: "bun run build",
    dir: "dist",
    provider: "github",
  },
  published_deploy: {
    id: "deploy-1",
    state: "ready",
    branch: "main",
    commit_ref: "1234567890abcdef",
    published_at: "2026-09-03T08:00:00.000Z",
  },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-09-03T08:00:00.000Z",
};

describe("Netlify client with mocked API", () => {
  test("covers paginated sites, exact resolution, deploys, deploy trigger, and env metadata", async () => {
    const previousToken = process.env.NETLIFY_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.NETLIFY_TOKEN = "fixture-token";
    const requests: { method: string; url: string }[] = [];

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      requests.push({ method, url });
      const parsed = new URL(url);

      if (parsed.pathname === "/api/v1/sites" && parsed.searchParams.get("page") === "1") {
        return new Response(JSON.stringify([site]), { status: 200 });
      }
      if (parsed.pathname === "/api/v1/sites" && parsed.searchParams.get("page") === "2") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (parsed.pathname === `/api/v1/sites/${site.id}`) {
        return new Response(JSON.stringify(site), { status: 200 });
      }
      if (parsed.pathname === `/api/v1/sites/${site.id}/deploys`) {
        return new Response(
          JSON.stringify([
            {
              id: "deploy-2",
              state: "ready",
              branch: "main",
              commit_ref: "abcdef123456",
              created_at: "2026-09-03T09:00:00.000Z",
            },
          ]),
          { status: 200 },
        );
      }
      if (parsed.pathname === `/api/v1/sites/${site.id}/builds` && method === "POST") {
        expect(JSON.parse(String(init?.body))).toEqual({ clear_cache: true });
        return new Response(JSON.stringify({ id: "build-1", deploy_id: "deploy-3", done: false }), { status: 201 });
      }
      if (parsed.pathname === `/api/v1/accounts/${site.account_slug}/env/ANALYTICS_ID` && method === "PATCH") {
        expect(parsed.searchParams.get("site_id")).toBe(site.id);
        expect(JSON.parse(String(init?.body))).toEqual({
          context: "production",
          value: "DO_NOT_PRINT_NETLIFY_VALUE",
        });
        return new Response(
          JSON.stringify({
            key: "ANALYTICS_ID",
            values: [{ context: "production", value: "DO_NOT_PRINT_NETLIFY_VALUE" }],
          }),
          { status: 201 },
        );
      }
      if (parsed.pathname === `/api/v1/accounts/${site.account_slug}/env`) {
        return new Response(
          JSON.stringify([
            {
              key: "DATABASE_URL",
              scopes: ["builds", "functions"],
              is_secret: true,
              values: [{ context: "production", value: "DO_NOT_PRINT_NETLIFY_VALUE" }],
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }) as unknown as typeof fetch;

    try {
      await expect(netlify.listSites()).resolves.toHaveLength(1);
      await expect(netlify.getSite("mycalcexpert.com")).resolves.toMatchObject({ id: site.id });
      await expect(netlify.listDeploys(site.id, 5)).resolves.toMatchObject([{ id: "deploy-2" }]);
      await expect(netlify.triggerDeploy(site.id, true)).resolves.toMatchObject({ id: "build-1" });
      const mutation = await netlify.setEnvVarValue("mycalcexpert.com", "ANALYTICS_ID", {
        context: "production",
        value: "DO_NOT_PRINT_NETLIFY_VALUE",
      });
      expect(mutation).toEqual({ key: "ANALYTICS_ID", context: "production", status: "configured" });
      expect(JSON.stringify(mutation)).not.toContain("DO_NOT_PRINT_NETLIFY_VALUE");
      await expect(netlify.listEnv("mycalcexpert.com")).resolves.toMatchObject({
        site: { id: site.id },
        vars: [{ key: "DATABASE_URL" }],
      });
      expect(requests.some((request) => request.url.includes("per_page=5"))).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousToken === undefined) delete process.env.NETLIFY_TOKEN;
      else process.env.NETLIFY_TOKEN = previousToken;
    }
  });

  test("surfaces authentication failures without echoing bearer material", async () => {
    const previousToken = process.env.NETLIFY_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.NETLIFY_TOKEN = "fixture-token";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "authorization: Bearer DO_NOT_PRINT_NETLIFY_VALUE" }), {
        status: 401,
        statusText: "Unauthorized",
      })) as unknown as typeof fetch;
    try {
      await expect(netlify.listSites()).rejects.toThrow(/Netlify API 401/);
      try {
        await netlify.listSites();
      } catch (error) {
        expect(String(error)).not.toContain("DO_NOT_PRINT_NETLIFY_VALUE");
        expect(String(error)).toContain("[redacted]");
      }
    } finally {
      globalThis.fetch = previousFetch;
      if (previousToken === undefined) delete process.env.NETLIFY_TOKEN;
      else process.env.NETLIFY_TOKEN = previousToken;
    }
  });

  test("redacts a mutation value if the API echoes it in an error", async () => {
    const previousToken = process.env.NETLIFY_TOKEN;
    const previousFetch = globalThis.fetch;
    const secretValue = "DO_NOT_PRINT_MUTATION_VALUE";
    process.env.NETLIFY_TOKEN = "fixture-token";
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/sites?") && url.includes("page=1")) {
        return new Response(JSON.stringify([site]), { status: 200 });
      }
      if (url.includes(`/accounts/${site.account_slug}/env/ANALYTICS_ID`)) {
        expect(init?.method).toBe("PATCH");
        return new Response(JSON.stringify({ message: `invalid value ${secretValue}` }), {
          status: 422,
          statusText: "Unprocessable Entity",
        });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }) as unknown as typeof fetch;
    try {
      await expect(
        netlify.setEnvVarValue("mycalcexpert.com", "ANALYTICS_ID", {
          context: "production",
          value: secretValue,
        }),
      ).rejects.toThrow(/\[redacted\]/);
      try {
        await netlify.setEnvVarValue("mycalcexpert.com", "ANALYTICS_ID", {
          context: "production",
          value: secretValue,
        });
      } catch (error) {
        expect(String(error)).not.toContain(secretValue);
      }
    } finally {
      globalThis.fetch = previousFetch;
      if (previousToken === undefined) delete process.env.NETLIFY_TOKEN;
      else process.env.NETLIFY_TOKEN = previousToken;
    }
  });

  test("creates a missing key with one contextual value after a PATCH 404", async () => {
    const previousToken = process.env.NETLIFY_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.NETLIFY_TOKEN = "fixture-token";
    const methods: string[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      methods.push(`${init?.method || "GET"} ${url}`);
      if (url.includes("/sites?") && url.includes("page=1")) {
        return new Response(JSON.stringify([site]), { status: 200 });
      }
      if (url.includes(`/accounts/${site.account_slug}/env/NEW_KEY`)) {
        return new Response(JSON.stringify({ message: "missing key" }), { status: 404, statusText: "Not Found" });
      }
      if (url.includes(`/accounts/${site.account_slug}/env?site_id=${site.id}`)) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual([
          { key: "NEW_KEY", values: [{ context: "deploy-preview", value: "DO_NOT_PRINT_NEW_VALUE" }] },
        ]);
        return new Response(JSON.stringify([{ key: "NEW_KEY" }]), { status: 201 });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }) as unknown as typeof fetch;
    try {
      const mutation = await netlify.setEnvVarValue("mycalcexpert.com", "NEW_KEY", {
        context: "deploy-preview",
        value: "DO_NOT_PRINT_NEW_VALUE",
      });
      expect(mutation).toEqual({ key: "NEW_KEY", context: "deploy-preview", status: "configured" });
      expect(methods.some((method) => method.startsWith("PATCH "))).toBe(true);
      expect(methods.some((method) => method.startsWith("POST "))).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousToken === undefined) delete process.env.NETLIFY_TOKEN;
      else process.env.NETLIFY_TOKEN = previousToken;
    }
  });

  test("sends the custom branch parameter only to the branch context", async () => {
    const previousToken = process.env.NETLIFY_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.NETLIFY_TOKEN = "fixture-token";
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/sites?") && url.includes("page=1")) {
        return new Response(JSON.stringify([site]), { status: 200 });
      }
      if (url.includes(`/accounts/${site.account_slug}/env/BRANCH_KEY`)) {
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          context: "branch",
          context_parameter: "staging",
          value: "DO_NOT_PRINT_BRANCH_VALUE",
        });
        return new Response(JSON.stringify({ key: "BRANCH_KEY" }), { status: 201 });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }) as unknown as typeof fetch;
    try {
      await expect(
        netlify.setEnvVarValue("mycalcexpert.com", "BRANCH_KEY", {
          context: "branch",
          contextParameter: "staging",
          value: "DO_NOT_PRINT_BRANCH_VALUE",
        }),
      ).resolves.toEqual({
        key: "BRANCH_KEY",
        context: "branch",
        context_parameter: "staging",
        status: "configured",
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousToken === undefined) delete process.env.NETLIFY_TOKEN;
      else process.env.NETLIFY_TOKEN = previousToken;
    }
  });

  test("validates one contextual value before a request", () => {
    expect(netlify.validateEnvKey("NEXT_PUBLIC_ANALYTICS_ID")).toBe("NEXT_PUBLIC_ANALYTICS_ID");
    expect(() => netlify.validateEnvKey("not-a-valid-key")).toThrow("contain only");
    expect(() => netlify.validateEnvKey("BAD\nKEY")).toThrow("control");
    expect(() => netlify.validateEnvValue("")).toThrow("cannot unset");
    expect(() => netlify.validateEnvValue("line\nvalue")).toThrow("control");
    expect(() => netlify.validateEnvValue("x".repeat(netlify.MAX_ENV_VALUE_BYTES + 1))).toThrow("bytes");
    expect(netlify.validateEnvContext("production")).toEqual({ context: "production" });
    expect(netlify.validateEnvContext("branch", "staging")).toEqual({
      context: "branch",
      contextParameter: "staging",
    });
    expect(() => netlify.validateEnvContext("branch")).toThrow("required");
    expect(() => netlify.validateEnvContext("production", "staging")).toThrow("only valid");
    expect(() => netlify.validateEnvContext("unknown")).toThrow("invalid");
  });

  test("fails clearly when the broker did not inject NETLIFY_TOKEN", async () => {
    const previousToken = process.env.NETLIFY_TOKEN;
    delete process.env.NETLIFY_TOKEN;
    try {
      await expect(netlify.listSites()).rejects.toThrow("system-vault run netlify");
    } finally {
      if (previousToken === undefined) delete process.env.NETLIFY_TOKEN;
      else process.env.NETLIFY_TOKEN = previousToken;
    }
  });
});

describe("Netlify CLI safety boundary", () => {
  test("accepts only the documented flags and rejects env-value reveal attempts", () => {
    expect(parseArgs(["deploy", "mycalcexpert.com", "--clear", "--confirm"])).toEqual({
      positional: ["deploy", "mycalcexpert.com"],
      flags: { clear: true, confirm: true },
    });
    expect(parseArgs(["deploys", "mycalcexpert.com", "--limit", "5", "--json"])).toEqual({
      positional: ["deploys", "mycalcexpert.com"],
      flags: { limit: "5", json: true },
    });
    expect(parseArgs(["env-set", "mycalcexpert.com", "ANALYTICS_ID", "--context", "production", "--confirm", "--json"])).toEqual({
      positional: ["env-set", "mycalcexpert.com", "ANALYTICS_ID"],
      flags: { context: "production", confirm: true, json: true },
    });
    expect(() => assertAllowedFlags("env", { values: true })).toThrow("unknown flag for env: --values");
    expect(() => assertAllowedFlags("env-set", { values: true })).toThrow("unknown flag for env-set: --values");
    expect(() => assertAllowedFlags("delete", {})).toThrow("unknown command");
    expect(usage()).not.toContain("--values");
    expect(usage()).not.toContain("reveal");
    expect(usage()).toContain("value from stdin");
  });

  test("rejects duplicate flags and invalid values before making a request", () => {
    expect(() => parseArgs(["sites", "--json", "--json"])).toThrow("duplicate flag");
    expect(() => parseArgs(["deploys", "mycalcexpert.com", "--limit"])).toThrow("requires a value");
    expect(() => assertAllowedFlags("deploy", { values: true })).toThrow("unknown flag");
    expect(() => parseArgs(["env-set", "site", "KEY", "--context", "production", "--context", "dev"])).toThrow(
      "duplicate flag",
    );
  });

  test("prints only a value-free env mutation receipt", () => {
    const receipt = formatEnvMutation(
      { key: "ANALYTICS_ID", context: "branch", context_parameter: "staging", status: "configured" },
      false,
    );
    expect(receipt).toContain("key=ANALYTICS_ID");
    expect(receipt).toContain("contexts=branch:staging");
    expect(receipt).toContain("status=configured");
    expect(receipt).not.toContain("value");
    const json = formatEnvMutation(
      { key: "ANALYTICS_ID", context: "production", status: "configured" },
      true,
    );
    expect(JSON.parse(json)).toEqual({ key: "ANALYTICS_ID", contexts: ["production"], status: "configured" });
  });

  test("requires confirmation for env mutation before reading stdin", () => {
    const result = Bun.spawnSync(
      [
        "bun",
        join(import.meta.dir, "cli.ts"),
        "env-set",
        "mycalcexpert.com",
        "ANALYTICS_ID",
        "--context",
        "production",
      ],
      { stdin: new Blob(["DO_NOT_PRINT_CLI_VALUE"]), stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("environment state");
    expect(result.stderr.toString()).toContain("--confirm");
    expect(result.stderr.toString()).not.toContain("DO_NOT_PRINT_CLI_VALUE");
  });

  test("masks every environment value in the safe projection", async () => {
    const { maskEnvVar } = await import("./cli.ts");
    const masked = maskEnvVar({
      key: "DATABASE_URL",
      scopes: ["builds"],
      is_secret: true,
      values: [{ context: "production", value: "DO_NOT_PRINT_NETLIFY_VALUE" }],
    });
    expect(JSON.stringify(masked)).not.toContain("DO_NOT_PRINT_NETLIFY_VALUE");
    expect(masked.values).toEqual([{ context: "production", value: "[masked]" }]);
  });
});
