#!/usr/bin/env bun
import * as netlify from "./client.ts";
import type { NetlifyDeploy, NetlifyEnvMutation, NetlifyEnvVar, NetlifySite } from "./types.ts";

type FlagValue = string | boolean;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, FlagValue>;
}

const BOOLEAN_FLAGS = new Set(["clear", "confirm", "json"]);
const COMMANDS = new Set(["sites", "site", "deploys", "deploy", "env", "env-set", "help"]);
const ALLOWED_FLAGS: Record<string, ReadonlySet<string>> = {
  sites: new Set(["json"]),
  site: new Set(["json"]),
  deploys: new Set(["json", "limit"]),
  deploy: new Set(["clear", "confirm", "json"]),
  env: new Set(["json"]),
  "env-set": new Set(["confirm", "context", "context-parameter", "json"]),
  help: new Set(),
};

const G = "\x1b[32m";
const Y = "\x1b[33m";
const R = "\x1b[31m";
const DIM = "\x1b[2m";
const X = "\x1b[0m";
const MASKED = "[masked]";

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

export function parseArgs(input: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, FlagValue> = {};
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index]!;
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const key = item.slice(2);
    if (!key) throw new CliError("empty flag");
    if (key in flags) throw new CliError(`duplicate flag: --${key}`);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = input[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`--${key} requires a value`);
    }
    flags[key] = value;
    index += 1;
  }
  return { positional, flags };
}

export function assertAllowedFlags(command: string, flags: Record<string, FlagValue>): void {
  const allowed = ALLOWED_FLAGS[command];
  if (!allowed) throw new CliError(`unknown command: ${command}\n\n${usage()}`);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) throw new CliError(`unknown flag for ${command}: --${key}`);
  }
}

function flagString(flags: Record<string, FlagValue>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function hasFlag(flags: Record<string, FlagValue>, name: string): boolean {
  return flags[name] === true;
}

function required(positionals: string[], index: number, label: string): string {
  const value = positionals[index];
  if (!value) throw new CliError(`missing ${label}`);
  return value;
}

function assertArity(positionals: string[], count: number, syntax: string): void {
  if (positionals.length !== count) throw new CliError(`usage: ${syntax}`);
}

function requireConfirmation(
  flags: Record<string, FlagValue>,
  action: string,
  state = "production",
): void {
  if (!hasFlag(flags, "confirm")) {
    throw new CliError(
      `${action} changes real Netlify ${state} state; obtain explicit approval for the exact target, then add --confirm`,
    );
  }
}

export function usage(): string {
  return `Netlify site management (read-only inspection + guarded mutations)

Usage: /home/robot/.local/bin/system-vault run netlify -- bun <skill-directory>/scripts/cli.ts <command> [args]

Commands:
  sites                         List all sites (domain · repo · last deploy · state)
  site <site>                   Show one site's details
  deploys <site> [--limit N]    Recent deploys (state · branch · commit · when) [default 10]
  deploy <site> [--clear]       Trigger a fresh build/deploy (MUTATING; requires --confirm)
  env <site>                    List env-var keys + contexts (values always masked)
  env-set <site> <key>          Configure one env value from stdin (requires --context and --confirm)
  help                          Show this help

<site> = site name, custom/default domain, or site id. JSON is available on
read commands and preserves the same safe projections. Environment-variable
values are never printed. env-set accepts exactly one value from stdin and
one Netlify context per invocation; use --context-parameter only for a custom
branch context. Supported contexts: all, dev, dev-server, branch-deploy,
deploy-preview, production, branch.

Example (the value is not a command argument or output):
  printf %s 'value' | /home/robot/.local/bin/system-vault run netlify -- bun <skill-directory>/scripts/cli.ts env-set mycalcexpert.com KEY --context production --confirm

All commands require the System Vault profile:
  /home/robot/.local/bin/system-vault run netlify -- ...
`;
}

function contextLabel(mutation: NetlifyEnvMutation): string {
  return mutation.context === "branch" && mutation.context_parameter
    ? `branch:${mutation.context_parameter}`
    : mutation.context;
}

/** Render only the safe receipt fields; no API response value is included. */
export function formatEnvMutation(mutation: NetlifyEnvMutation, json: boolean): string {
  const safe = {
    key: mutation.key,
    contexts: [contextLabel(mutation)],
    status: mutation.status,
  };
  if (json) return JSON.stringify(safe, null, 2);
  return `${G}✓${X} env configured | key=${safe.key} | contexts=${safe.contexts.join(",")} | status=${safe.status}`;
}

/**
 * Read a bounded UTF-8 value from stdin. The stream is bounded before it is
 * joined, so an accidental large input cannot be accumulated without limit.
 */
export async function readStdinValue(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > netlify.MAX_ENV_VALUE_BYTES) {
        await reader.cancel();
        throw new CliError(`stdin value cannot exceed ${netlify.MAX_ENV_VALUE_BYTES} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CliError("stdin value must be valid UTF-8");
  }
  return netlify.validateEnvValue(value);
}

function date(value?: string): string {
  return value ? value.slice(0, 10) : "never";
}

function repoOf(site: NetlifySite): string {
  return site.build_settings?.repo_url || site.build_settings?.repo_path || "—";
}

function domainOf(site: NetlifySite): string {
  return site.custom_domain || site.default_domain || (site.url || "").replace(/^https?:\/\//, "");
}

function deployState(state?: string): string {
  if (state === "ready") return `${G}ready${X}`;
  if (state === "error") return `${R}error${X}`;
  if (state === "building" || state === "enqueued" || state === "new" || state === "uploading") {
    return `${Y}${state}${X}`;
  }
  return state || "?";
}

function siteSummary(site: NetlifySite): Record<string, unknown> {
  return {
    id: site.id,
    name: site.name,
    url: site.url,
    ssl_url: site.ssl_url,
    custom_domain: site.custom_domain,
    default_domain: site.default_domain,
    domain_aliases: site.domain_aliases || [],
    state: site.state,
    repository: repoOf(site),
    branch: site.build_settings?.repo_branch,
    build_command: site.build_settings?.cmd,
    publish_directory: site.build_settings?.dir,
    provider: site.build_settings?.provider,
    latest_deploy: site.published_deploy
      ? {
          id: site.published_deploy.id,
          state: site.published_deploy.state,
          branch: site.published_deploy.branch,
          commit_ref: site.published_deploy.commit_ref,
          published_at: site.published_deploy.published_at,
        }
      : null,
    created_at: site.created_at,
    updated_at: site.updated_at,
  };
}

function printSites(sites: NetlifySite[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify(sites.map(siteSummary), null, 2));
    return;
  }
  if (!sites.length) {
    console.log("No sites found");
    return;
  }
  console.log(`\n  ${sites.length} site(s)\n`);
  console.log("  Site                            | Domain                         | Last deploy | Repo");
  console.log("  --------------------------------|--------------------------------|-------------|----------------------------");
  for (const site of [...sites].sort((a, b) => a.name.localeCompare(b.name))) {
    const repo = repoOf(site).replace("https://github.com/", "gh:");
    console.log(
      `  ${site.name.padEnd(31).slice(0, 31)} | ${domainOf(site).padEnd(30).slice(0, 30)} | ${date(site.published_deploy?.published_at).padEnd(11)} | ${repo}`,
    );
  }
  console.log("");
}

function printSite(site: NetlifySite, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(siteSummary(site), null, 2));
    return;
  }
  const buildSettings = site.build_settings || {};
  console.log(`
Site: ${site.name}
─────────────────────────────────────
  id:           ${site.id}
  primary URL:  ${site.ssl_url || site.url}
  custom domain:${site.custom_domain ? ` ${site.custom_domain}` : " —"}
  aliases:      ${(site.domain_aliases || []).join(", ") || "—"}
  repo:         ${repoOf(site)}${buildSettings.repo_branch ? ` @${buildSettings.repo_branch}` : ""}
  build cmd:    ${buildSettings.cmd || "—"}
  publish dir:  ${buildSettings.dir || "—"}
  last deploy:  ${deployState(site.published_deploy?.state)}  ${date(site.published_deploy?.published_at)}  ${site.published_deploy?.commit_ref ? `(${site.published_deploy.commit_ref.slice(0, 7)})` : ""}
  admin:        ${site.admin_url || "—"}
  created:      ${date(site.created_at)}
`);
}

function deploySummary(deploy: NetlifyDeploy): Record<string, unknown> {
  return {
    id: deploy.id,
    state: deploy.state,
    branch: deploy.branch,
    commit_ref: deploy.commit_ref,
    title: deploy.title,
    context: deploy.context,
    error_message: deploy.error_message,
    created_at: deploy.created_at,
    published_at: deploy.published_at,
    url: deploy.ssl_url || deploy.url,
  };
}

function printDeploys(deploys: NetlifyDeploy[], site: string, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(deploys.map(deploySummary), null, 2));
    return;
  }
  if (!deploys.length) {
    console.log(`No deploys for ${site}`);
    return;
  }
  console.log(`\n  Deploys for ${site}\n`);
  console.log("  State     | When       | Branch        | Commit  | Title");
  console.log("  ----------|------------|---------------|---------|--------------------------------");
  for (const deploy of deploys) {
    const when = date(deploy.published_at || deploy.created_at);
    const commit = deploy.commit_ref ? deploy.commit_ref.slice(0, 7) : "—";
    const title = (deploy.title || deploy.context || "").slice(0, 40);
    console.log(
      `  ${deployState(deploy.state).padEnd(19)} | ${when.padEnd(10)} | ${(deploy.branch || "—").padEnd(13).slice(0, 13)} | ${commit.padEnd(7)} | ${title}`,
    );
    if (deploy.state === "error" && deploy.error_message) {
      console.log(`    ${R}${deploy.error_message.slice(0, 120)}${X}`);
    }
  }
  console.log("");
}

export interface MaskedEnvValue {
  context: string;
  value: typeof MASKED;
}

export interface MaskedEnvVar {
  key: string;
  scopes: string[];
  contexts: string[];
  is_secret: boolean;
  values: MaskedEnvValue[];
}

/** Project env metadata without ever returning the API's value field. */
export function maskEnvVar(variable: NetlifyEnvVar): MaskedEnvVar {
  const values = variable.values || [];
  return {
    key: variable.key,
    scopes: variable.scopes || [],
    contexts: values.map((value) => value.context),
    is_secret: variable.is_secret === true,
    values: values.map((value) => ({ context: value.context, value: MASKED })),
  };
}

function printEnv(site: NetlifySite, variables: NetlifyEnvVar[], json: boolean): void {
  const masked = [...variables].sort((a, b) => a.key.localeCompare(b.key)).map(maskEnvVar);
  if (json) {
    console.log(JSON.stringify({ site: siteSummary(site), vars: masked }, null, 2));
    return;
  }
  if (!masked.length) {
    console.log(`No env vars for ${site.name}`);
    return;
  }
  console.log(`\n  Env vars for ${site.name} (${masked.length})  ${DIM}— values always masked${X}\n`);
  for (const variable of masked) {
    const contexts = variable.contexts.join(",") || "all";
    const secret = variable.is_secret ? ", secret" : "";
    if (variable.values.length) {
      for (const value of variable.values) {
        console.log(`  ${variable.key} [${value.context}] = ${value.value}  ${DIM}(${contexts}${secret})${X}`);
      }
    } else {
      console.log(`  ${variable.key}  ${DIM}(${contexts}${secret})${X}`);
    }
  }
  console.log("");
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
    const [rawCommand, ...args] = parsed.positional;
    const command = rawCommand?.toLowerCase() || "help";
    assertAllowedFlags(command, parsed.flags);
    if (!COMMANDS.has(command)) throw new CliError(`unknown command: ${command}\n\n${usage()}`);
    if (command === "help") {
      assertArity(args, 0, "help");
      console.log(usage());
      return;
    }

    const json = hasFlag(parsed.flags, "json");
    switch (command) {
      case "sites":
        assertArity(args, 0, "sites");
        printSites(await netlify.listSites(), json);
        return;
      case "site":
        assertArity(args, 1, "site <site>");
        printSite(await netlify.getSite(required(args, 0, "site")), json);
        return;
      case "deploys": {
        assertArity(args, 1, "deploys <site> [--limit N]");
        const rawLimit = flagString(parsed.flags, "limit");
        const limit = rawLimit === undefined ? 10 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new CliError("--limit must be an integer from 1 to 100");
        }
        printDeploys(await netlify.listDeploys(required(args, 0, "site"), limit), required(args, 0, "site"), json);
        return;
      }
      case "deploy": {
        assertArity(args, 1, "deploy <site> [--clear] --confirm");
        const site = required(args, 0, "site");
        requireConfirmation(parsed.flags, `deploy ${site}`);
        const build = await netlify.triggerDeploy(site, hasFlag(parsed.flags, "clear"));
        if (json) {
          console.log(JSON.stringify({ id: build.id, deploy_id: build.deploy_id, done: build.done, sha: build.sha }, null, 2));
        } else {
          console.log(`${G}✓${X} build queued — id: ${build.id}${build.deploy_id ? `  deploy: ${build.deploy_id}` : ""}`);
          console.log(`${DIM}Watch: /home/robot/.local/bin/system-vault run netlify -- bun <skill-directory>/scripts/cli.ts deploys ${site}${X}`);
        }
        return;
      }
      case "env": {
        assertArity(args, 1, "env <site>");
        const result = await netlify.listEnv(required(args, 0, "site"));
        printEnv(result.site, result.vars, json);
        return;
      }
      case "env-set": {
        assertArity(args, 2, "env-set <site> <key> --context CONTEXT --confirm");
        const site = required(args, 0, "site");
        const key = required(args, 1, "key");
        const context = flagString(parsed.flags, "context");
        if (!context) {
          throw new CliError(
            "--context is required; choose one Netlify context (production, deploy-preview, branch-deploy, or another supported context)",
          );
        }
        const contextParameter = flagString(parsed.flags, "context-parameter");
        // Validate all argv fields before consuming stdin or making a request.
        const validatedContext = netlify.validateEnvContext(context, contextParameter);
        netlify.validateEnvKey(key);
        requireConfirmation(parsed.flags, `env-set ${site} ${key}`, "environment");
        const value = await readStdinValue();
        const mutation = await netlify.setEnvVarValue(site, key, {
          context: validatedContext.context,
          ...(validatedContext.contextParameter === undefined
            ? {}
            : { contextParameter: validatedContext.contextParameter }),
          value,
        });
        console.log(formatEnvMutation(mutation, json));
        return;
      }
      default:
        throw new CliError(`unknown command: ${command}\n\n${usage()}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}

if (import.meta.main) void main();
