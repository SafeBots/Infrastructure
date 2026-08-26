# terraform/main.tf — top-level provisioning entry (refactor.md Phase 2.2).
#
# Pick ONE cloud module per deployment. Each provisions an attested confidential
# Safebox instance from the NixOS image built by nixos/flake.nix:
#
#   AWS   : nix build .#ami   -> register AMI -> set aws.ami_id
#   GCP   : nix build .#gce   -> create image -> set gcp.image
#   Azure : nix build .#azure -> managed image -> set azure.image_id
#   OCI   : nix build .#oci   -> custom image  -> set oci.image_ocid
#
# refactor.md Phase 2 exit criterion: the SAME config boots as a confidential VM
# on AWS and at least one SEV-SNP cloud, reachable, container tier running.
#
# Recommendation (refactor.md open decision #2): prove Phase 3 measurement on a
# SEV-SNP cloud first (GCP/Azure), where sev-snp-measure tooling is most mature.

# Example — AWS:
# module "safebox_aws" {
#   source        = "./modules/aws"
#   ami_id        = "ami-xxxxxxxx"
#   subnet_id     = "subnet-xxxxxxxx"
# }

# Example — GCP (recommended first for Phase 3):
# module "safebox_gcp" {
#   source  = "./modules/gcp"
#   project = "my-project"
#   image   = "safebox-nixos-image"
# }
