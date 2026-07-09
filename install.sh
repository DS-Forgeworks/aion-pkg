#!/usr/bin/env bash
set -euo pipefail

# ───────────────────────────────────────────────
#  Aion — One-Line Installer
#  Usage: curl -fsSL https://dsforgeworks.com/aion/install.sh | bash
#
#  Installs Aion outreach platform on macOS or Linux.
#  No sudo needed (installs to ~/.aion and ~/node).
# ───────────────────────────────────────────────

AION_VERSION="1.0.0"
AION_REPO="https://github.com/DS-Forgeworks/aion-pkg"
NODE_VERSION="22"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${BLUE}▶${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
err()   { echo -e "${RED}✗${NC} $1"; exit 1; }

detect_os() {
  case "$(uname -s)" in
    Darwin*)  echo "macos" ;;
    Linux*)   echo "linux" ;;
    *)        echo "unknown" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)            echo "x64" ;;
  esac
}

install_node() {
  info "Installing Node.js ${NODE_VERSION}..."
  local os=$(detect_os)
  local arch=$(detect_arch)
  local url

  if [ "$os" = "macos" ]; then
    url="https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-${arch}.tar.gz"
  else
    url="https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-${arch}.tar.gz"
  fi

  local tmpdir=$(mktemp -d)
  cd "$tmpdir"
  curl -fsSL "$url" -o node.tar.gz || err "Failed to download Node.js"
  tar -xzf node.tar.gz || err "Failed to extract Node.js"

  local node_dir="$HOME/.aion-node"
  mkdir -p "$node_dir"
  cp -r "node-v22.14.0-"*/* "$node_dir/" 2>/dev/null || true
  rm -rf "$tmpdir"

  export PATH="$node_dir/bin:$PATH"
  ok "Node.js $(node --version) installed"
}

# ── Main ──
clear
cat << "EOF"
  ╔══════════════════════════════════════════╗
  ║              Aion v1.0                    ║
  ║     Intelligent Outreach Platform         ║
  ╚══════════════════════════════════════════╝
EOF
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  warn "Node.js not found. Installing..."
  install_node
else
  node_ver=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
  if [ "$node_ver" -lt 18 ] 2>/dev/null; then
    warn "Node.js $(node --version) too old. Installing Node v22..."
    install_node
  else
    ok "Node.js $(node --version) found"
  fi
fi

# Ensure npm
if ! command -v npm &>/dev/null; then
  warn "npm not found. Installing Node.js..."
  install_node
fi

# Create Aion directory
AION_HOME="$HOME/.aion"
mkdir -p "$AION_HOME/data"
mkdir -p "$AION_HOME/bin"

# Download Aion package
if [ -n "${AION_DEV_PATH:-}" ]; then
  info "Using local dev path: $AION_DEV_PATH"
  AION_SRC="$AION_DEV_PATH"
else
  info "Downloading Aion..."
  local tmp=$(mktemp -d)
  cd "$tmp"

  # Download the tarball from GitHub
  curl -fsSL "${AION_REPO}/releases/download/v${AION_VERSION}/aion-pkg.tar.gz" -o aion.tar.gz 2>/dev/null || {
    # Fallback: clone the repo
    warn "Release not found, cloning from GitHub..."
    git clone --depth 1 "$AION_REPO" aion-src 2>/dev/null || {
      # Fallback: download individual files from raw
      cd "$AION_HOME"
      for f in server.mjs; do
        curl -fsSL "${AION_REPO}/raw/main/lib/${f}" -o "lib/${f}" &
      done
      for f in index.html; do
        curl -fsSL "${AION_REPO}/raw/main/web/${f}" -o "web/${f}" &
      done
      curl -fsSL "${AION_REPO}/raw/main/bin/aion.mjs" -o "bin/aion" &
      curl -fsSL "${AION_REPO}/raw/main/package.json" -o "package.json" &
      wait
    }
  }

  if [ -f aion.tar.gz ]; then
    tar -xzf aion.tar.gz
    cp -r aion-pkg/* "$AION_HOME/"
  elif [ -d aion-src ]; then
    cp -r aion-src/* "$AION_HOME/"
  fi
  rm -rf "$tmp"
fi

# Create launcher script
cat > "$AION_HOME/bin/aion" << 'LAUNCHER'
#!/usr/bin/env bash
export PATH="$HOME/.aion-node/bin:$PATH"
exec node "$HOME/.aion/bin/aion.mjs" "$@"
LAUNCHER
chmod +x "$AION_HOME/bin/aion"

# Symlink to ~/.local/bin
mkdir -p "$HOME/.local/bin"
ln -sf "$AION_HOME/bin/aion" "$HOME/.local/bin/aion"

# Add to PATH if not present
case ":$PATH:" in
  *:"$HOME/.local/bin":*) ;;
  *)
    shell_rc=""
    case "$SHELL" in
      */zsh) shell_rc="$HOME/.zshrc" ;;
      */bash) shell_rc="$HOME/.bashrc" ;;
    esac
    if [ -n "$shell_rc" ]; then
      echo "" >> "$shell_rc"
      echo '# Aion' >> "$shell_rc"
      echo 'export PATH="$PATH:$HOME/.local/bin"' >> "$shell_rc"
      ok "Added ~/.local/bin to PATH in $shell_rc"
    fi
    ;;
esac

# Run setup wizard
ok "Installation complete!"
echo ""
echo "  🚀 Starting setup wizard..."
echo ""

exec "$AION_HOME/bin/aion" setup
