#!/usr/bin/env bash
set -euo pipefail
# A hosted runner's Azure HTTP mirror can stall all browser verification.
# Keep the dependency checks; bound downloads and use Ubuntu's HTTPS archive.
if command -v apt-get >/dev/null 2>&1; then
  if [ -f /etc/apt/apt-mirrors.txt ]; then
    sudo sed -i 's|http://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' /etc/apt/apt-mirrors.txt
  fi
  printf 'Acquire::Retries "2";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' | sudo tee /etc/apt/apt.conf.d/99-porchday-ci-downloads >/dev/null
fi
