# EMCORE Release Runner

Public, release-control-only companion repository for the private `emcore-project/emcore` source repository.

## Security boundary

- No EMCORE application source is stored here.
- No customer data or generated private artifacts are stored here.
- No provider credential is committed here.
- Release execution is controlled only through `release-request.json`.
- Source is checked out from the private repository at an exact accepted Git SHA.
- Q0 qualification performs no Cloudflare access and no deployment.
- Source-repository pushes do not trigger this repository.

## Current phase

Q0 runner qualification is prepared but not activated. The current release request is fail-closed in `IDLE` mode.

Required secret for Q0, when separately authorized:

- `EMCORE_SOURCE_TOKEN`: fine-grained GitHub token restricted to `emcore-project/emcore`, read-only Contents and Pull Requests permissions.

Cloudflare credentials are not required or referenced by Q0.
