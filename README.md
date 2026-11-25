# DeepSeek Harness plugins

This repository contains independently installable DeepSeek Harness bundles.
Install a bundle with `dsh plugin --profile web add <package>` and restart that
profile.

| Plugin | npm package |
| --- | --- |
| [Atlassian](packages/integrations/dsh-atlassian) | `@lornatang/dsh-atlassian` |
| [GitHub](packages/integrations/dsh-github) | `@lornatang/dsh-github` |
| [Notion](packages/integrations/dsh-notion) | `@lornatang/dsh-notion` |
| [Frontgate](packages/access/dsh-frontgate) | `@lornatang/dsh-frontgate` |
| [Codex Security](packages/security/dsh-codex-security) | `@lornatang/dsh-codex-security` |
| [Security Audit](packages/security/dsh-security-audit) | `@lornatang/dsh-security-audit` |
| [Caveman](packages/workflow/dsh-caveman) | `@lornatang/dsh-caveman` |
| [Superpowers](packages/workflow/dsh-superpowers) | `@lornatang/dsh-superpowers` |

## Develop a plugin

Each directory under `packages/<group>/<plugin>/` contains the plugin's
`package.json`, Cordis patches, and its own npm lockfile. Run the package
commands from its directory with Node.js 22.19 or newer.

```sh
cd packages/integrations/dsh-notion
npm ci
npm run typecheck
npm test
npm pack
```

Install the resulting tarball into a test profile with
`dsh plugin --profile web add ./<filename>.tgz`. For a Caveman source build
without a matching GitHub Release, set `DSH_CAVEMAN_LEARN_BINARY` to a locally
built analyzer before testing session analysis.

## Release a plugin

1. Update the plugin's version in its `package.json` and `package-lock.json`,
   and update its changelog.
2. After the change reaches `main`, push a tag using `<plugin>-v<version>`,
   for example `dsh-notion-v0.1.12`.
3. The release workflow tests and packs that plugin, then attaches its npm
   tarball to the corresponding [GitHub Release](https://github.com/Lornatang/dsh-plugin/releases).
   Caveman releases also build all six analyzer binaries and package their
   checksums.

To enable npm publishing, authorize `Lornatang/dsh-plugin` and
`release.yml` as the trusted publisher for the npm packages, then set the
GitHub Actions repository variable `PUBLISH_TO_NPM` to `true`. Stable versions
publish to `latest`, and prereleases publish to `next`.

If a GitHub Release already exists and its version is still unpublished on npm,
run the **Release plugin** workflow on `main` with the existing release tag.
The workflow publishes the tarball attached to that release.
