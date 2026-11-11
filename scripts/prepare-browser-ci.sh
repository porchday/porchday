#!/usr/bin/env bash
set -euo pipefail
# Keep dependency verification, but do not pin every runner to a broken mirror.
# APT still verifies Ubuntu's signed repository metadata and package hashes.
if command -v apt-get >/dev/null 2>&1; then
  if [ -f /etc/apt/apt-mirrors.txt ]; then
    ubuntu_codename="$(. /etc/os-release; printf '%s' "$VERSION_CODENAME")"
    ubuntu_mirror=''
    for candidate in https://archive.ubuntu.com/ubuntu https://us.archive.ubuntu.com/ubuntu; do
      if curl --fail --silent --show-error --head --connect-timeout 5 --max-time 10 \
        "$candidate/dists/$ubuntu_codename/InRelease" >/dev/null; then
        ubuntu_mirror="$candidate"
        break
      fi
    done
    if [ -z "$ubuntu_mirror" ]; then
      echo 'No reachable official Ubuntu archive; required browser dependencies cannot be installed.' >&2
      exit 1
    fi
    printf '%s\n' "$ubuntu_mirror" | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
    echo "Browser dependency archive: $ubuntu_mirror"
  fi
  printf 'Acquire::Retries "2";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' | sudo tee /etc/apt/apt.conf.d/99-porchday-ci-downloads >/dev/null
fi
