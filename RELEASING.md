# Preparing Entryway releases

Changesets tracks the single private `hypercerts-entryway` package. Named pending
notes describe operator-visible behavior and feed a generated `CHANGELOG.md`.
The package remains private; this workflow prepares files only. It does not commit,
tag, publish to npm, create a GitHub Release or deploy a service.

## Record a change

Use the [writing-changesets skill](.agents/skills/writing-changesets/SKILL.md).
Write a descriptive `.changeset/<change>.md` file, or use the managed CLI and rename
its generated file before review. Runtime behavior, configuration and recovery
changes need a note; internal refactoring, tests and prose alone do not.

```sh
./scripts/changesets.sh add
./scripts/changesets.sh status
```

All npm execution stays in rootless Atmosphere in a Box tooling. The wrapper uses
the pinned checkout under `tests/.runtime/changesets-tooling` (or `SANDBOX_CHECKOUT`),
builds the dedicated tooling target and runs one disposable container. It mounts
this working tree and read-only Git metadata with explicit worktree paths, so
linked Git worktrees work without mounting home or credentials. Source
files remain writable for authoring/versioning; Git metadata is read-only and
automatic commits are disabled. Installed dependencies live in the container's
anonymous volume, not a host npm installation. Runtime CLI execution has no network;
initial clone/image/dependency preparation needs network access. No application
services are started or stopped.

The npm scripts `changeset`, `changeset:check` and `version-packages` are for the
managed container. The bundled Git changelog generator needs no GitHub token.
`main` is the comparison base; keep the local base ref current when using `--since`.

## Prepare a version when requested

Start from a reviewed release branch or worktree containing the pending notes:

```sh
./scripts/changesets.sh status
./scripts/changesets.sh version
git diff -- package.json package-lock.json CHANGELOG.md .changeset/
```

Versioning updates `package.json`, generates the changelog and consumes the notes.
The script then synchronizes root version fields in `package-lock.json` with an
offline, scripts-disabled npm lockfile update. Review both root versions and the
dependency diff before committing; unrelated dependency resolution is not expected.
Do not hand-edit the generated changelog as a substitute for a pending note.

The initial foundation note proposes a minor bump from `0.1.0` to `0.2.0`; adding
this setup does not apply that bump. Release/tag/deployment automation is outside
this workflow. Changesets' separate `git-tag` command does not publish to npm,
but creating a tag still requires an explicit release task. See the official
[configuration](https://changesets.dev/guide/config) and
[CLI reference](https://changesets.dev/guide/cli).
