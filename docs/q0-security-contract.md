# Q0 qualification contract

Q0 exists only to prove that the public GitHub-hosted runner can execute the release qualification path without deploying anything.

## Fixed source identity

- Repository: `emcore-project/emcore`
- Commit: `f57337c622d533a0200e51fcdf798deae5130754`
- Tree: `cd36bfbf4dc333b8d144b847ab13e169e183eae9`
- Expected open pull requests: `0`

The workflow fails closed on any mismatch.

## Q0 permitted operations

1. Read and validate `release-request.json`.
2. Exit without using secrets while mode is `IDLE`.
3. In `QUALIFY` mode, require `EMCORE_SOURCE_TOKEN`.
4. Fetch the exact source commit from the private repository.
5. Verify exact commit and tree identity.
6. Read the source repository open-PR count and require zero.
7. Run the repository's existing `check:release-predeploy` contract with accepted gate values.
8. Emit only non-secret qualification evidence.

## Q0 prohibited operations

- No Cloudflare API access.
- No Cloudflare credential reference.
- No Wrangler deploy.
- No Supabase mutation.
- No customer-data access.
- No artifact upload containing private source.
- No pull-request or fork trigger.
- No automatic trigger from source-repository `main`.
- No paid runner or paid resource.

## Secrets

Q0 may read only:

- `EMCORE_SOURCE_TOKEN`

The token must be a fine-grained GitHub token limited to `emcore-project/emcore` with read-only Contents and Pull Requests permissions. Its value must never be committed, printed, uploaded, or pasted into ChatGPT.

Q1/Q2 require separate governance and are not implemented by Q0.
