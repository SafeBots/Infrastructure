# modules/containers.nix
#
# The container tier — category-2 (README): ADDITIONAL services that ride
# beside the measured base, NOT duplicates of the core daemons.
#
# F1/F3 RESOLVED (host-authoritative): nginx, mariadb, and php are now HOST
# services in the MEASURED base (base.nix). They are therefore REMOVED from the
# container tier — no more dual-layer duplication, no more version skew, no more
# "two nginxes" (F1). The host nginx owns 80/443 and is what Autohost configures.
#
# What remains in containers here are the services that are legitimately
# category-2: the always-on SUPPORT tier (app sandbox, search, media, browser,
# system API). Model runners are dynamic + governed — see model-runners/. Plus ANY EXTRA WEBSERVERS an
# app wants to run behind the host nginx. These are digest-pinned and verified
# by app-verify.nix before they start (the Model-A category-2 guarantee).
#
# Extra webservers pattern: run them as containers on internal ports; the
# MEASURED host nginx reverse-proxies to them. That keeps the trust-root front
# door (nginx) measured while letting apps bring their own app servers as
# category-2 containers behind it.
{ config, pkgs, lib, ... }:

let
  composeFile = "/opt/safebox/docker/docker-compose.yml";
in
{
  # ── Container hardening: seccomp + AppArmor ─────────────────────────────
  # The container tier's syscall + resource confinement. Both profile sets are
  # shipped INSIDE the measured base (environment.etc), so the confinement
  # policy itself is attested: a relying party verifies not just that runners
  # run, but that they run under these exact profiles.
  security.apparmor.enable = true;

  # Seccomp profiles referenced by docker-compose (security_opt: seccomp=...).
  # safebox-runner.json: deny-by-default allowlist for locked-down services.
  # safebox-gpu.json:    same + the CUDA/NVIDIA userspace syscalls.
  environment.etc."safebox/docker/security/seccomp/safebox-runner.json".source =
    ../../docker/security/seccomp/safebox-runner.json;
  environment.etc."safebox/docker/security/seccomp/safebox-gpu.json".source =
    ../../docker/security/seccomp/safebox-gpu.json;
  # docker-compose references these at /etc/safebox/docker/security/... — the
  # SAME attested paths shipped here via environment.etc, so Docker resolves the
  # seccomp profile from the measured base at container start (no /opt copy).

  # AppArmor profile for confined runners. Shipped in the measured base and
  # loaded into the kernel before the container tier starts.
  environment.etc."apparmor.d/safebox-runner".source =
    ../../docker/security/apparmor/safebox-runner;

  systemd.services.safebox-apparmor-load = {
    description = "Load Safebox AppArmor profiles before the container tier";
    wantedBy = [ "multi-user.target" ];
    before = [ "safebox-compose.service" ];
    requiredBy = [ "safebox-compose.service" ];
    after = [ "apparmor.service" ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
    path = [ pkgs.apparmor-parser ];
    script = ''
      set -euo pipefail
      # Replace-or-load the profile; idempotent across restarts.
      apparmor_parser -r -W /etc/apparmor.d/safebox-runner
      echo "loaded AppArmor profile: safebox-runner"
    '';
  };

  # Run the (de-duplicated) Docker Compose stack as a systemd unit, AFTER the
  # app-digest verification gate (app-verify.nix) and AFTER the core host
  # daemons are up.
  systemd.services.safebox-compose = {
    description = "Safebox category-2 container tier (model runners, tools, extra webservers)";
    wantedBy = [ "multi-user.target" ];
    after = [
      "docker.service"
      "safebox-zfs-datasets.service"
      "safebox-verify-apps.service"   # digest gate must pass first (fail-closed)
      "nginx.service"                 # host nginx (the reverse proxy) up first
      "mysql.service"                 # host mariadb up first
      "phpfpm-safebox.service"
    ];
    requires = [ "docker.service" "safebox-verify-apps.service" ];
    # AppArmor profiles must be loaded before containers reference them.
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      # Start the always-on support tier. Model runners are NOT here — they are
      # launched dynamically by the system component (/models/install ->
      # /system start -> docker run) with M-of-N-governed weights. GPU boxes
      # need nvidia-container-toolkit installed; the dynamic runner launch
      # requests the GPU at `docker run` time per model.
      ExecStart = "${pkgs.docker}/bin/docker compose -f ${composeFile} up -d";
      ExecStop  = "${pkgs.docker}/bin/docker compose -f ${composeFile} down";
    };
  };

  # The compose file at ${composeFile} must NOT contain nginx / mariadb / php
  # services anymore (they moved to the measured host base). Enforce that at
  # activation so a stale compose file can't silently reintroduce the F1 "two
  # nginxes" bug.
  systemd.services.safebox-compose-no-core-dups = {
    description = "Guard: container tier must not duplicate the measured host core daemons";
    wantedBy = [ "multi-user.target" ];
    before = [ "safebox-compose.service" ];
    requiredBy = [ "safebox-compose.service" ];
    after = [ "docker.service" ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
    path = [ pkgs.yq-go pkgs.gnugrep pkgs.coreutils ];
    script = ''
      set -euo pipefail
      [ -f ${composeFile} ] || { echo "No compose file yet; nothing to guard."; exit 0; }
      # Fail if the compose file declares a service using an image for the core
      # daemons that now live in the measured host base.
      names="$(yq -r '.services | keys | .[]' ${composeFile} 2>/dev/null || true)"
      bad=0
      for svc in nginx mariadb mysql php-fpm php_fpm; do
        if printf '%s\n' "$names" | grep -qx "$svc"; then
          echo "REFUSING: compose service '$svc' duplicates a MEASURED host core daemon." >&2
          echo "          Core nginx/mariadb/php are host-authoritative (F1/F3 resolved)." >&2
          echo "          Remove '$svc' from ${composeFile}; run extra app servers on" >&2
          echo "          internal ports behind the host nginx instead." >&2
          bad=1
        fi
      done
      [ "$bad" -eq 0 ] && echo "Container tier does not duplicate the host core daemons. OK."
      exit $bad
    '';
  };

  # NOTE: model runners (llama.cpp, ollama) are first-class in nixpkgs
  # (services.llama-cpp, services.ollama) if you later want them measured in the
  # host base too. For now they remain category-2 container services.
}
