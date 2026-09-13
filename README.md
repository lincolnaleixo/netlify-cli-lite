# netlify-cli-lite

Netlify sites, deploys, and environment metadata CLI

## Install

## Use

## License

MIT.
# netlify-cli-lite

A focused TypeScript CLI and client for Netlify site metadata, deploy history, deploys, and masked environment metadata.

## Install

Requires Bun. Clone this repository, run `bun install`, then run `bun run check`.

## Use

The executable is `./bin/netlify-cli-lite`. The default invocation is:

```bash
system-vault run netlify -- ./bin/netlify-cli-lite help
```

Commands: `sites`, `site <site>`, `deploys <site> [--limit N]`, `deploy <site> [--clear] --confirm`, `env <site>`, `env-set <site> <key> --context CONTEXT --confirm` (value from stdin), and `help`.

## Environment

Credentials are read only from environment variables. Inject them with your organization's secret broker; never commit a `.env` file or put secret values in arguments.

`NETLIFY_TOKEN`.

## License

MIT. See [LICENSE](LICENSE).
