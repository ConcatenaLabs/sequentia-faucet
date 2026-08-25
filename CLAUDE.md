# Working on the Sequentia faucet

One service, one page, one endpoint. Keep it that way.

## What this repo is

The testnet faucet: `server.js` sends coins from a funded node wallet, and
`public/index.html` is the page people use to ask for them. No build step, no
database, no state that survives a restart.

It lived inside `sequentia-explorer` until 2026-08-24, embedded in that repo's
`serve-public.js`. A faucet is not an explorer. Sharing a process with the site
front door was a deployment fact, never a reason to share a repository, and
while it was bolted in nobody could release, roll back or find the faucet on its
own. If a change here starts to want anything from the explorer, the change is
in the wrong repo.

## The mount contract

The site front door proxies `/faucet` to this service and strips the prefix, so
this service serves `/` and the public sees `/faucet`. Keep it that way: wallets
and the page itself post to the absolute path `/faucet`, so serving the page
anywhere else silently breaks the button.

`GET /healthz` answers `{"ok":true}` and is the only route outside that contract.

## The three rules that matter

**Nothing the caller sends may reach a shell.** Sends go through `execFile`, so
every value is one argv element and never a command line. The address is checked
against a strict bech32/blech32 regex before it is used, and the asset is looked
up in a fixed allowlist. Do not replace `execFile` with `exec`, and do not build
the argument list by string concatenation.

**The fee asset must always be named.** Sequentia has an open fee market and no
privileged asset, so the node refuses a send that does not say which asset pays
the fee. Asset sends pay in the asset being sent; plain tSEQ sends pay in tSEQ,
which the node labels `bitcoin` because it is the policy asset. A silent
fallback to a default fee asset would be a privilege, and privileges are bugs.

**Rate limiting is per address and per IP, and both must keep working.** The
service sits behind one trusted proxy, which forwards the original
`X-Forwarded-For`, so `trust proxy` is 1 and `req.ip` is the real client. Set it
wrong and every request looks like it came from 127.0.0.1, which collapses the
per-IP limit into a single global one.

## Testing a change

```
npm install
FAUCET_CLI=/bin/echo node server.js
```

Pointing `FAUCET_CLI` at `echo` exercises the whole request path, including
validation and rate limiting, without moving coins. Check that a bad address is
rejected with 400, an unknown asset with 400, and a repeat request with 429.

## Deploy

The box pulls from GitHub, always. Never edit these files on the server and never
copy them there from a workstation. `deploy/sequentia-faucet.service` is the unit;
the wallet it spends from is operator configuration and is set there, not here.

<!-- BEGIN SHARED AGENT CONVENTIONS: identical in every Sequentia repo. Change it in all of them together. -->
## Working with git and GitHub here

These rules are the same in every Sequentia repository. They are repeated in each
one because this file is the only thing an agent is guaranteed to read, whatever
machine it is working from.

**Nothing pushed to GitHub credits Claude, Anthropic, or any AI tool.** No
`Co-Authored-By: Claude` trailer, no `Claude-Session:` trailer or `claude.ai`
link, no "Generated with Claude Code" in a commit message or a pull request body,
no `claude/*` branch names or session ids, and no mention in source, comments,
docs or issue text. Agent tooling offers several of these by default; compose the
message without them rather than stripping them afterwards.

**Author every commit as**
`GracedEternalKingCabbageMan <151803062+GracedEternalKingCabbageMan@users.noreply.github.com>`.
Never a personal address.

**Every change lands through a pull request that you merge yourself, at once.**
There is no reviewer on this project; the pull request exists so the reasoning is
recorded beside the diff. Branch, push, open it, merge it, delete the branch, all
in one sitting. Pushing straight to the default branch is the rule most often
broken here, and it is the one that costs the record. A pull request stays open
only when the repository owner asks for that specific one, and that never carries
over to the next.

**Name branches `area/short-description`**: `fix/`, `doc/`, `feature/`, `test/`,
`build/`, or the component being changed. Never a tool name, a session id, or
`worktree-*`.

**Write the subject as `area: what changed`**, one line, 72 characters at the
outside and 50 where you can manage it. Put the reasoning in the body, and
explain why rather than what.

**These repositories are public and world-readable.** Never commit private keys,
seeds, `wallet.dat`, RPC credentials, `.env` files or API tokens. Read the diff
before every commit. Secrets belong on the server and in offline backups.

**A file belongs to the repository whose code it describes.** Decide which repo
owns it before writing it; if it landed in the wrong one, move it rather than
deleting it.

**Push the same day you commit.** The testnet server pulls only from GitHub, so a
branch left on one laptop is invisible to every other machine and to the box.
<!-- END SHARED AGENT CONVENTIONS -->

## Style

No em dashes in public copy. The network is "Sequentia"; the token is the "Sequence token
(SEQ)". Never write "the SEQ chain".
