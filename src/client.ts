import type {
  NetlifyBuild,
  NetlifyConfig,
  NetlifyDeploy,
  NetlifyEnvContext,
  NetlifyEnvVar,
  NetlifyEnvMutation,
  NetlifySite,
} from "./types.ts";

const BASE_URL = "https://api.netlify.com/api/v1";
export const MAX_ENV_KEY_LENGTH = 128;
export const MAX_ENV_VALUE_BYTES = 64 * 1024;
export const MAX_CONTEXT_PARAMETER_LENGTH = 256;
export const NETLIFY_ENV_CONTEXTS: readonly NetlifyEnvContext[] = [
  "all",
  "dev",
  "dev-server",
  "branch-deploy",
  "deploy-preview",
  "production",
  "branch",
];
const ENV_CONTEXT_SET = new Set<string>(NETLIFY_ENV_CONTEXTS);

class NetlifyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function loadConfig(): NetlifyConfig {
  const token = process.env.NETLIFY_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "Netlify credentials not found. Run through `/home/robot/.local/bin/system-vault run netlify --`.",
    );
  }
  return { token };
}

function safeErrorDetail(value: string, secrets: readonly string[] = []): string {
  let safe = value;
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join("[redacted]");
  }
  return safe
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,}"']+/gi, "$1[redacted]")
    .replace(/(netlify[_-]?token\s*[=:]\s*)[^\s,}"']+/gi, "$1[redacted]")
    .replace(/("value"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/(\bvalue\s*[=:]\s*)[^\s,}"']+/gi, "$1[redacted]")
    .slice(0, 300);
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  secrets: readonly string[] = [],
): Promise<T> {
  const { token } = loadConfig();
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Netlify API request failed: ${safeErrorDetail(message, [token, ...secrets])}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new NetlifyApiError(
      response.status,
      `Netlify API ${response.status} ${response.statusText} on ${method} ${path}: ${safeErrorDetail(text, [token, ...secrets])}`,
    );
  }
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Netlify API returned a non-JSON response (HTTP ${response.status}).`);
  }
}

function pathPart(value: string): string {
  return encodeURIComponent(value);
}

function siteHost(site: NetlifySite): string {
  return (site.url || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function normalizeSiteArg(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!normalized) throw new Error("site cannot be empty");
  return normalized;
}

function assertNoControls(value: string, label: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} cannot contain control characters.`);
  }
}

/** Validate a shell-safe Netlify environment-variable key. */
export function validateEnvKey(value: string): string {
  const key = value.trim();
  if (!key) throw new Error("environment-variable key cannot be empty");
  if (key.length > MAX_ENV_KEY_LENGTH) {
    throw new Error(`environment-variable key cannot exceed ${MAX_ENV_KEY_LENGTH} characters`);
  }
  assertNoControls(key, "environment-variable key");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
    throw new Error("environment-variable key must start with a letter or underscore and contain only letters, numbers, and underscores");
  }
  return key;
}

/** Validate one value delivered through stdin; never include it in an error. */
export function validateEnvValue(value: string): string {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes === 0) {
    throw new Error("environment-variable value cannot be empty; this command cannot unset variables");
  }
  if (bytes > MAX_ENV_VALUE_BYTES) {
    throw new Error(`environment-variable value cannot exceed ${MAX_ENV_VALUE_BYTES} bytes`);
  }
  assertNoControls(value, "environment-variable value");
  return value;
}

/** Validate the API context and its optional custom-branch parameter. */
export function validateEnvContext(
  context: string,
  contextParameter?: string,
): { context: NetlifyEnvContext; contextParameter?: string } {
  const normalized = context.trim().toLowerCase();
  if (!ENV_CONTEXT_SET.has(normalized)) {
    throw new Error(`invalid Netlify environment context: ${context}`);
  }
  const typed = normalized as NetlifyEnvContext;
  if (typed === "branch") {
    if (!contextParameter) throw new Error("context-parameter is required when context is branch");
    const branch = contextParameter.trim();
    if (!branch) throw new Error("context-parameter cannot be empty");
    if (branch.length > MAX_CONTEXT_PARAMETER_LENGTH) {
      throw new Error(`context-parameter cannot exceed ${MAX_CONTEXT_PARAMETER_LENGTH} characters`);
    }
    assertNoControls(branch, "context-parameter");
    return { context: typed, contextParameter: branch };
  }
  if (contextParameter !== undefined) {
    throw new Error("context-parameter is only valid when context is branch");
  }
  return { context: typed };
}

// --- Sites ------------------------------------------------------------------

export async function listSites(): Promise<NetlifySite[]> {
  const sites: NetlifySite[] = [];
  let page = 1;
  for (;;) {
    const query = new URLSearchParams({ per_page: "100", page: String(page) });
    const batch = await api<NetlifySite[]>("GET", `/sites?${query}`);
    if (!batch.length) break;
    sites.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return sites;
}

/**
 * Resolve a site by exact id, name, custom/default domain, or URL. A partial
 * name/domain match is accepted only when it identifies one site.
 */
export async function resolveSite(arg: string): Promise<NetlifySite> {
  const normalized = normalizeSiteArg(arg);

  // Netlify site ids are UUID-like. An exact id lookup avoids an unnecessary
  // account-wide listing when the caller already has the id.
  if (/^[a-f0-9-]{20,}$/i.test(arg.trim())) {
    try {
      return await api<NetlifySite>("GET", `/sites/${pathPart(arg.trim())}`);
    } catch {
      // Fall through to name/domain matching for a stale or non-id argument.
    }
  }

  const sites = await listSites();
  const exact = sites.find(
    (site) =>
      site.name?.toLowerCase() === normalized ||
      site.custom_domain?.toLowerCase() === normalized ||
      site.default_domain?.toLowerCase() === normalized ||
      siteHost(site) === normalized,
  );
  if (exact) return exact;

  const partial = sites.filter(
    (site) =>
      site.name?.toLowerCase().includes(normalized) ||
      site.custom_domain?.toLowerCase().includes(normalized) ||
      site.default_domain?.toLowerCase().includes(normalized),
  );
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new Error(`Multiple Netlify sites match "${arg}". Use an exact site name, domain, or id.`);
  }
  throw new Error(`No Netlify site matching "${arg}". Run \`sites\` to list them.`);
}

export async function getSite(idOrName: string): Promise<NetlifySite> {
  return resolveSite(idOrName);
}

// --- Deploys ----------------------------------------------------------------

export async function listDeploys(idOrName: string, limit = 10): Promise<NetlifyDeploy[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("deploy limit must be an integer from 1 to 100");
  }
  const site = await resolveSite(idOrName);
  const query = new URLSearchParams({ per_page: String(limit) });
  return api<NetlifyDeploy[]>("GET", `/sites/${pathPart(site.id)}/deploys?${query}`);
}

/**
 * Trigger a fresh build/deploy from the site's linked repository. This queues
 * a real publication; the CLI protects it with an explicit --confirm flag.
 */
export async function triggerDeploy(idOrName: string, clearCache = false): Promise<NetlifyBuild> {
  const site = await resolveSite(idOrName);
  return api<NetlifyBuild>(
    "POST",
    `/sites/${pathPart(site.id)}/builds`,
    clearCache ? { clear_cache: true } : {},
  );
}

// --- Environment metadata --------------------------------------------------

export async function listEnv(
  idOrName: string,
): Promise<{ site: NetlifySite; vars: NetlifyEnvVar[] }> {
  const site = await resolveSite(idOrName);
  if (!site.account_slug) {
    throw new Error(`Site "${site.name}" has no account_slug; cannot read env vars.`);
  }
  const query = new URLSearchParams({ site_id: site.id });
  const vars = await api<NetlifyEnvVar[]>(
    "GET",
    `/accounts/${pathPart(site.account_slug)}/env?${query}`,
  );
  return { site, vars };
}

export interface SetEnvValueOptions {
  /** One value from Netlify's deploy-context enum. */
  context: NetlifyEnvContext;
  /** Required only for the custom `branch` context. */
  contextParameter?: string;
  /** The value supplied from stdin by the CLI. */
  value: string;
}

/**
 * Configure or update one contextual value for one site environment key.
 *
 * Netlify's PATCH endpoint intentionally changes one context per request. The
 * value is accepted only in memory from the caller and is never included in
 * the safe mutation result or diagnostic text.
 */
export async function setEnvVarValue(
  idOrName: string,
  key: string,
  options: SetEnvValueOptions,
): Promise<NetlifyEnvMutation> {
  const validatedKey = validateEnvKey(key);
  const validatedValue = validateEnvValue(options.value);
  const validatedContext = validateEnvContext(options.context, options.contextParameter);
  const site = await resolveSite(idOrName);
  if (!site.account_slug) {
    throw new Error(`Site "${site.name}" has no account_slug; cannot set env vars.`);
  }

  const body: Record<string, string> = {
    context: validatedContext.context,
    value: validatedValue,
  };
  if (validatedContext.contextParameter !== undefined) {
    body.context_parameter = validatedContext.contextParameter;
  }

  // The API response includes contextual values. Discard it immediately and
  // return only a value-free receipt to prevent accidental downstream leaks.
  const envPath = `/accounts/${pathPart(site.account_slug)}/env/${pathPart(validatedKey)}?site_id=${pathPart(site.id)}`;
  try {
    await api<unknown>("PATCH", envPath, body, [validatedValue]);
  } catch (error) {
    // PATCH is the one-context endpoint for an existing key. Netlify returns
    // 404 when the key does not exist; in that case create exactly one new
    // site variable with the same single contextual value.
    if (!(error instanceof NetlifyApiError) || error.status !== 404) throw error;
    const createBody = [
      {
        key: validatedKey,
        values: [
          {
            context: validatedContext.context,
            ...(validatedContext.contextParameter === undefined
              ? {}
              : { context_parameter: validatedContext.contextParameter }),
            value: validatedValue,
          },
        ],
      },
    ];
    await api<unknown>(
      "POST",
      `/accounts/${pathPart(site.account_slug)}/env?site_id=${pathPart(site.id)}`,
      createBody,
      [validatedValue],
    );
  }

  return {
    key: validatedKey,
    context: validatedContext.context,
    ...(validatedContext.contextParameter === undefined
      ? {}
      : { context_parameter: validatedContext.contextParameter }),
    status: "configured",
  };
}

/** Short alias for callers that prefer the CLI's `env-set` wording. */
export const setEnvValue = setEnvVarValue;
