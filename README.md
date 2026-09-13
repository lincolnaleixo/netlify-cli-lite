# netlify-cli-lite

A small Bun CLI for inspecting Netlify sites, deploy history, deploy status,
and masked environment-variable metadata, with guarded deploy and environment
updates.

## Install

Install [Bun](https://bun.sh/), clone this repository, and install its locked
development dependencies:

```bash
bun install --frozen-lockfile
```

Run the executable directly from the checkout:

```bash
./bin/netlify-cli-lite help
```

## Commands and options

```text
sites
site <site>
deploys <site> [--limit N]
deploy <site> [--clear] --confirm
env <site>
env-set <site> <key> --context CONTEXT [--context-parameter BRANCH] --confirm
help
```

`<site>` accepts an exact site ID, name, custom domain, or default domain; a
unique partial name/domain match is also accepted.

Read commands (`sites`, `site`, `deploys`, and `env`) accept `--json` and never
print environment-variable values. `deploys --limit N` accepts an integer from
1 through 100 and defaults to 10. `deploy --clear` requests a fresh build with
the build cache cleared. Deploys require `--confirm`.

`env-set` reads exactly one non-empty UTF-8 value from standard input. It
requires `--context` and `--confirm`; supported contexts are `all`, `dev`,
`dev-server`, `branch-deploy`, `deploy-preview`, `production`, and `branch`.
The `branch` context additionally requires `--context-parameter`, and that
option is invalid for other contexts. `env-set` also accepts `--json` and never
prints the submitted value.

Example:

```bash
printf %s 'value' | NETLIFY_TOKEN="$NETLIFY_TOKEN" ./bin/netlify-cli-lite \
  env-set example.com PUBLIC_KEY --context production --confirm
```

## Environment variables and secrets

The CLI reads `NETLIFY_TOKEN` from the process environment. Inject it through
your organization's secret manager or broker, for example with its generic
environment-injection wrapper, and do not put tokens in command arguments,
source files, logs, or `.env` files committed to a repository.

## Check

Run the typecheck and the test suite together:

```bash
bun run check
```

The check is equivalent to `bun run typecheck && bun run test`.

## License

MIT. See [LICENSE](LICENSE).
