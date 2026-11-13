# Credential Source: Secrets-Manager-Backed Credential Proxy

## Summary

The credential source abstraction replaces flat-file key storage with a pluggable backend that fetches credentials from the platform's secrets manager on cloud deployments. On AWS it uses Secrets Manager via the instance's IAM role. On GCP it uses Secret Manager via the attached service account. On-prem it uses HashiCorp Vault with AppRole or Kubernetes auth. The file backend (keyd-managed tmpfs keys) remains the default for dev and on-prem deployments that haven't configured Vault.

The change is backward-compatible. If `SAFEBOX_CREDENTIAL_BACKEND` is unset and the instance isn't running on a detected cloud, the file backend is used and nothing changes.

## Why

Today every key — the HMAC seed, per-tenant derived keys, operator keys, model-runner API keys — lives in a flat file on tmpfs or disk. If an attacker compromises the host, they get the credential itself. With a secrets manager backend, the host holds only a Vault token or IAM role — not the credential. The token can be revoked instantly without rotating the downstream credential. Audit trails are centralized. Rotation is automatic.

## Architecture

```
                  ┌──────────────────────────────────┐
                  │        CredentialSource           │
                  │   get(name) → cached Buffer       │
                  │   TTL-based cache + stale fallback│
                  └──────────┬───────────────────────┘
                             │
         ┌───────────────────┼───────────────────────┐
         │                   │                       │
    FileSource          CloudSource            VaultSource
    (keyd/tmpfs)     (AWS SM / GCP SM)     (AppRole / K8s)
```

### Logical credential names

Every backend uses the same logical names. The file backend maps them to paths; the cloud/vault backends map them to secret names in the manager.

| Logical name | File path | AWS SM name | GCP SM name | Vault path |
|---|---|---|---|---|
| `operator` | `/run/safebox/keys/_operator/control.hmac` | `safebox/operator` | `safebox-operator` | `secret/data/safebox/operator` |
| `tenant/<name>` | `/run/safebox/keys/<name>/instance.hmac` | `safebox/tenant/<name>` | `safebox-tenant-<name>` | `secret/data/safebox/tenant/<name>` |
| `seed` | `/run/safebox/hmac-seed` | `safebox/seed` | `safebox-seed` | `secret/data/safebox/seed` |
| `model-api` | `/etc/safebox/model-api.key` | `safebox/model-api` | `safebox-model-api` | `secret/data/safebox/model-api` |

### Caching

Every backend caches fetched values in-process with a configurable TTL (`SAFEBOX_CREDENTIAL_TTL_SEC`, default 300s). On cache miss, the backend fetches. On fetch failure, the stale cached value is returned if one exists — graceful degradation. Refresh is synchronous on first load and best-effort-async thereafter.

This means:

- **Availability**: if the secrets manager is unreachable, the process continues with cached credentials for up to TTL seconds after last successful fetch. No hard dependency on every request.
- **Latency**: zero per-request overhead. Credentials are fetched once at startup and refreshed in the background.
- **Rotation**: when a credential is rotated in the secrets manager, the new value is picked up within TTL seconds. No process restart needed.

## Files added/changed

### New files

| File | Language | What it does |
|---|---|---|
| `aws/scripts/components/system/credential-source.js` | Node.js | CredentialSource interface + FileCredentialSource, AwsCredentialSource, GcpCredentialSource, VaultCredentialSource implementations. Cache layer. Auto-detection. |
| `model-runners/_shared/credential_source.py` | Python | Same interface for model runners. FileCredentialSource, AwsCredentialSource (boto3), GcpCredentialSource (urllib), VaultCredentialSource (urllib). |
| `nixos/modules/credential-source.nix` | Nix | NixOS module: options for backend selection, per-cloud config, Vault auth, secret_id delivery. Auto-enabled on cloud. |
| `docs/CREDENTIAL-SOURCE.md` | Markdown | This document. |

### Changed files

| File | What changed |
|---|---|
| `aws/scripts/components/system/secret.js` | `loadTenantKey()` and `loadOperatorKey()` now check `USE_CREDENTIAL_SOURCE` and go through `credential-source.get()` on non-file backends. File-backend path unchanged. |
| `model-runners/_shared/safebox_auth.py` | `load_hmac_key()` tries `credential_source.get("model-api")` first on non-file backends, falls through to file read. |

## Per-cloud setup

### AWS

**Prerequisites**: the instance's IAM role must have `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:*:*:secret:safebox/*`. The `@aws-sdk/client-secrets-manager` package must be in package.json.

**Secrets to create** (AWS CLI):

```bash
# Create the HMAC seed secret (32 random bytes, base64-encoded)
aws secretsmanager create-secret \
  --name safebox/seed \
  --secret-binary fileb://<(head -c 32 /dev/urandom)

# Create per-tenant secrets as tenants are provisioned
aws secretsmanager create-secret \
  --name safebox/tenant/myapp \
  --secret-binary fileb://tenant-key.bin

# Create operator key
aws secretsmanager create-secret \
  --name safebox/operator \
  --secret-binary fileb://operator-key.bin

# Create model-api key
aws secretsmanager create-secret \
  --name safebox/model-api \
  --secret-string "$(base64 < model-api.key)"
```

**NixOS config** (auto-detected, no explicit config needed if `safebox.cloud = "aws"`):

```nix
safebox.credentialSource = {
  enable = true;         # default on AWS
  backend = "auto";      # detects AWS from DMI vendor
  aws.secretPrefix = "safebox/";  # default
};
```

### GCP

**Prerequisites**: the VM's service account must have `roles/secretmanager.secretAccessor` on the secrets. No SDK dependency — uses the metadata server + HTTPS.

**Secrets to create** (gcloud):

```bash
echo -n "$(head -c 32 /dev/urandom | base64)" | \
  gcloud secrets create safebox-seed --data-file=-

echo -n "$(base64 < operator-key.bin)" | \
  gcloud secrets create safebox-operator --data-file=-

echo -n "$(base64 < model-api.key)" | \
  gcloud secrets create safebox-model-api --data-file=-
```

**NixOS config** (auto-detected):

```nix
safebox.credentialSource = {
  enable = true;
  gcp.project = null;  # auto-detected from metadata
};
```

### HashiCorp Vault (on-prem / hybrid)

**Prerequisites**: Vault cluster accessible from the Safebox host. AppRole or Kubernetes auth enabled.

**Vault setup**:

```bash
# Enable KV v2 at secret/
vault secrets enable -path=secret kv-v2

# Create the policy
vault policy write safebox-credential - <<EOF
path "secret/data/safebox/*" {
  capabilities = ["read"]
}
EOF

# Create AppRole
vault auth enable approle
vault write auth/approle/role/safebox-credential \
  secret_id_ttl=10m \
  token_ttl=1h \
  token_max_ttl=4h \
  policies=safebox-credential

# Get role_id (not secret — goes in config)
vault read auth/approle/role/safebox-credential/role-id

# Generate a single-use secret_id (delivered by Ansible/Puppet at deploy)
vault write -f auth/approle/role/safebox-credential/secret-id
```

**Store the credentials**:

```bash
vault kv put secret/safebox/seed value="$(base64 < seed.bin)"
vault kv put secret/safebox/operator value="$(base64 < operator-key.bin)"
vault kv put secret/safebox/model-api value="$(base64 < model-api.key)"
```

**NixOS config**:

```nix
safebox.credentialSource = {
  enable = true;
  backend = "vault";
  vault = {
    addr = "https://vault.internal:8200";
    authMethod = "approle";
    roleId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";  # from vault read above
    secretIdFile = "/run/secrets/vault-secret-id";      # delivered by Ansible
    secretPathPrefix = "secret/data/safebox/";
  };
};
```

The `secretIdFile` is consumed once at first boot and deleted. After that, the process holds a renewable Vault token that self-renews at 2/3 TTL.

## Bootstrap: what's on disk?

| Deployment | What's on disk | What an attacker gets | Revocation |
|---|---|---|---|
| **File (dev/legacy)** | Raw 32-byte keys on tmpfs | The credential itself | Must rotate the key |
| **AWS** | Nothing — IAM role is the identity | IAM role (scoped to `safebox/*`) | Revoke IAM role; credential stays valid |
| **GCP** | Nothing — service account is the identity | Service account token (short-lived) | Revoke SA; credential stays valid |
| **Vault (AppRole)** | One-time `secret_id` (deleted after first use) | Vault token (renewable, revocable) | `vault token revoke`; credential stays valid |
| **Vault (K8s)** | Nothing — K8s service account JWT is the identity | Vault token (short-lived) | Pod restart invalidates JWT |

## Migration path

1. **No breaking changes.** If `SAFEBOX_CREDENTIAL_BACKEND` is unset and the host isn't on a detected cloud, the file backend is used. Existing deployments are unaffected.

2. **Cloud deployments**: set `safebox.credentialSource.enable = true` (or just deploy on a detected cloud). Create the secrets in the cloud's manager. The system component and runners auto-detect the backend and fetch from it.

3. **On-prem with Vault**: set `backend = "vault"`, configure the Vault options, deploy the `secret_id` via your provisioning tool. After first boot, the `secret_id` is consumed and deleted.

4. **Gradual rollout**: you can test by setting `SAFEBOX_CREDENTIAL_BACKEND=aws` on a single instance while others remain on `file`. The credential names and derivation are identical — the only difference is where they're stored.

## Testing

The credential source module is testable without a live secrets manager:

```bash
# Run with file backend (existing tests pass unchanged)
NODE_ENV=test node test/run.js

# Test credential source resolution
SAFEBOX_CREDENTIAL_BACKEND=file node -e "
  const cs = require('./credential-source');
  console.log('backend:', cs.source.name);
"

# Test with Vault dev server
vault server -dev &
VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=root \
  SAFEBOX_CREDENTIAL_BACKEND=vault \
  node -e "
    const cs = require('./credential-source');
    cs.get('operator').then(k => console.log('key:', k.length, 'bytes'));
  "
```

## TODO for Infrastructure team

- [ ] Add `@aws-sdk/client-secrets-manager` to `package.json` (only needed on AWS deployments; conditional require, won't break non-AWS)
- [ ] Add `boto3` to model-runner requirements (only needed on AWS; conditional import, won't break non-AWS)
- [ ] Create IAM policy for Secrets Manager access on AWS AMIs
- [ ] Create service account IAM binding for Secret Manager on GCP images
- [ ] Wire `credential-source.nix` into `nixos/flake.nix` imports
- [ ] Set up Vault AppRole and policy for on-prem test environments
- [ ] Terraform: add secrets manager resources to `aws/terraform/main.tf` and `gcp/terraform/main.tf`
- [ ] Integration test: verify credential fetch from each backend in the test pipeline
- [ ] Azure support: implement `AzureCredentialSource` using Key Vault + Managed Identity (same pattern as AWS/GCP)
- [ ] Seed migration tooling: script to read existing keyd seed from tmpfs and store it in the target secrets manager
