# dns-relay

A reference relying party for safebox announces. Anyone can run one: it takes the `safebox_announce` claims boxes POST to `/announce`, verifies each with `common/attestation/verifyAnnounce.js` against a `blessed-images.json` you control, keeps the first box key seen under each safebox id, and prints the DNS A record it would set (`--apply` is a stub for your DNS provider). The relay at `dns.safebots.ai` that ships in the image's `defaults.json` is the same code and the same rules; it is a convenience for people who do not want to run their own, not an authority. Nothing it accepts or refuses changes what the box is, and a box that never reaches it can still be verified by anyone who reads its announces from the Safenet transparency log.

```
node tools/dns-relay/authorize.js keygen owner.key          # owner-pubkey for Terraform
node tools/dns-relay/authorize.js sign owner.key prod-001 2  # launch-authorization (2 h) for Terraform
node tools/dns-relay/relay.js --blessed blessed-images.json --listen 0.0.0.0:8080 --zone boxes.example.net
```

## Name Claims

The relay now also accepts `name_claim` OCP claims via `POST /name-claim`. These map domain names to safebox IDs for the Safenet DNS zone. Name claims are verified with `common/attestation/verifyNameClaim.js` against a set of trusted owner keys. See `docs/DNS-ARCHITECTURE.md` for the full DNS architecture.

`blessed-images.json` is either `{ "<rootHash>": { "pcrs": { "0": hex, ... }, "measurement": hex } }` or `{ "trustedKeys": [...], "minSigners": 2, "blessings": [ ...image_blessing claims... ] }`, in which case the set is built from M-of-N auditor signatures at start. `--owners owners.json` (a JSON array of owner public keys) limits the relay to boxes whose launch authorization was signed by one of them; without it any verified box is accepted. `GET /announces/<safebox-id>` returns the accepted record or 404; the red-team scripts poll it, and they mint a throwaway owner key, so run the relay they point at with `--owners` listing only your real keys.
