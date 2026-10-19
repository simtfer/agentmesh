# Release

How a version of agentmesh gets from `main` to npm, and what has to be true
before it does. The package is unscoped (`agentmesh`), so `npm publish` on a
clean version publishes it publicly under the `latest` tag.

## What a release must be able to answer

- **Does it install and run?** `npm i -g agentmesh && agentmesh list` from a
  directory with an `agentmesh.yaml`, or `npx agentmesh@<version> demo`.
- **Is the tarball complete?** `dist/` is gitignored, so the artifact is only as
  good as the build that produced it. `prepack` therefore runs
  `npm run build && npm run check:pack` on every `npm pack` / `npm publish`: the
  build makes the tarball complete from a clean clone, and the check then refuses
  to publish one whose `bin`/`exports` targets are missing or that carries
  `src/`, `test/`, `.github/` or local state. Deliberately one script, not two
  hooks — `npm publish` runs `prepublishOnly` *before* `prepack`, so a check there
  would inspect the previous build.
- **Do the docs survive the npm page?** npm renders the README out of the
  tarball with no repository context, so every link in `README.md` /
  `README.zh.md` is an absolute `github.com/simtfer/agentmesh/blob/main/…` URL.
  Relative links look right on GitHub and 404 on npmjs.com.

## Steps

```bash
# 1. the gate, locally — CI runs the same thing on Linux and Windows
npm run typecheck && npm test && npm run build && npm run demo && npm run smoke
npm run check:pack

# 2. pick the version; this writes package.json, commits and tags
npm version patch        # or minor / major

# 3. publish (prepack rebuilds dist/ and verifies the tarball)
npm login --registry=https://registry.npmjs.org      # once per machine
npm publish --registry=https://registry.npmjs.org    # unscoped → public, tag latest
#   prerelease instead: npm publish --tag next --registry=https://registry.npmjs.org

# 4. push the commit *and* the tag — the tag is what the release points at
git push --follow-tags
```

**Name the registry explicitly.** A mirror cannot accept publishes, and
`registry.npmmirror.com` — a common default in China — answers with a permission
error that reads like an auth failure rather than a mirror refusal. The login has
to target `registry.npmjs.org` too, or that registry will not know the token.

## After publishing

```bash
npm view agentmesh version dist.tarball
npx agentmesh@<version> demo            # a real install, not the working tree
```

Open `https://www.npmjs.com/package/agentmesh/<version>` and click through the
README once: broken links and a missing `dist/` are both invisible locally and
obvious there. That page is a snapshot of the tarball, so a README fix only
reaches it with the next version.

## Prereleases and mistakes

- `npm publish --tag next` publishes without moving `latest`, so
  `npm i agentmesh` keeps serving the last stable version while
  `npm i agentmesh@next` gets the candidate.
- A bad version can be unpublished within 72 hours
  (`npm unpublish agentmesh@<version>`), after which the version number is
  burned: publish the fix as the next patch and `npm deprecate` the bad one with
  a message pointing at it. Deprecating is preferred over unpublishing even
  inside the window — anyone who already installed it keeps a working copy.
- `main` is what the README links resolve against, so a doc fix that matters
  after a release can be pushed to `main` without a new version; the npm page
  text cannot.
