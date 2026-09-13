export interface NetlifyConfig {
  /** Personal access token sent as `Authorization: Bearer <token>`. */
  token: string;
}

export interface NetlifyBuildSettings {
  repo_url?: string;
  repo_path?: string;
  repo_branch?: string;
  cmd?: string;
  dir?: string;
  provider?: string;
}

export interface NetlifyDeploy {
  id: string;
  state: string;
  name?: string;
  url?: string;
  ssl_url?: string;
  deploy_url?: string;
  deploy_ssl_url?: string;
  admin_url?: string;
  branch?: string;
  commit_ref?: string;
  commit_url?: string;
  title?: string;
  context?: string;
  error_message?: string;
  created_at?: string;
  published_at?: string;
}

export interface NetlifySite {
  id: string;
  name: string;
  url: string;
  ssl_url?: string;
  admin_url?: string;
  custom_domain?: string;
  default_domain?: string;
  domain_aliases?: string[];
  state?: string;
  account_slug?: string;
  account_name?: string;
  build_settings?: NetlifyBuildSettings;
  published_deploy?: NetlifyDeploy;
  created_at?: string;
  updated_at?: string;
}

/** POST /sites/{id}/builds response (a queued build that becomes a deploy). */
export interface NetlifyBuild {
  id: string;
  deploy_id?: string;
  done?: boolean;
  error?: string | null;
  sha?: string;
  created_at?: string;
}

export interface NetlifyEnvValue {
  context: string;
  /** Present in the API response but never returned by the CLI. */
  value?: string;
  id?: string;
}

/** Deploy contexts accepted by Netlify's environment-variable API. */
export type NetlifyEnvContext =
  | "all"
  | "dev"
  | "dev-server"
  | "branch-deploy"
  | "deploy-preview"
  | "production"
  | "branch";

export interface NetlifyEnvVar {
  key: string;
  scopes?: string[];
  is_secret?: boolean;
  values?: NetlifyEnvValue[];
}

/** Safe result of a one-context environment-variable mutation. */
export interface NetlifyEnvMutation {
  key: string;
  context: NetlifyEnvContext;
  context_parameter?: string;
  status: "configured";
}
