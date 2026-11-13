#!/usr/bin/env bash
# frida/run_instrumentation.sh
#
# Launcher script for Semantic Router Frida dynamic instrumentation suite.
# Automatically detects running server process, checks host permissions,
# and attaches chosen hooks (ONNX tensor extraction, TRINITY socket monitoring, or both).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Semantic Router Host-Side Frida Instrumentation Suite ==="
echo "Target: Semantic Router Studio & Multi-Embedding Agentic System"
echo "Root:   $PROJECT_ROOT"
echo ""

# 1. Validate Frida installation
if ! command -v frida >/dev/null 2>&1; then
  echo "[-] ERROR: 'frida' CLI is not found on your PATH."
  echo "    Install Frida via pip:"
  echo "      pip install frida-tools"
  echo "    Or refer to frida/README.md for OS-specific instructions."
  exit 1
fi

# 2. Check ptrace permissions on Linux
if [[ "$(uname -s)" == "Linux" ]]; then
  if [[ -f /proc/sys/kernel/yama/ptrace_scope ]]; then
    SCOPE=$(cat /proc/sys/kernel/yama/ptrace_scope)
    if [[ "$SCOPE" != "0" ]]; then
      echo "[!] WARNING: kernel.yama.ptrace_scope is currently $SCOPE (restricted)."
      echo "    Frida may require root or ptrace permissions to attach to running Node processes."
      echo "    To enable non-root ptrace for local testing, run:"
      echo "      sudo sysctl -w kernel.yama.ptrace_scope=0"
      echo ""
    fi
  fi
fi

# 3. Discover target PID
PID=$(pgrep -f "tsx server.ts" 2>/dev/null | head -n 1 || true)
if [[ -z "$PID" ]]; then
  PID=$(pgrep -f "node server.ts" 2>/dev/null | head -n 1 || true)
fi

if [[ -z "$PID" ]]; then
  echo "[-] Could not find a running 'tsx server.ts' or 'node server.ts' process."
  echo "    Start the server in another terminal via:"
  echo "      npm run dev"
  echo "    Then rerun this script."
  exit 1
fi

echo "[+] Detected running Semantic Router server at PID: $PID"

# 4. Parse execution mode
MODE="${1:---all}"

case "$MODE" in
  --onnx)
    echo "[*] Attaching ONNX Runtime native tensor hook ($SCRIPT_DIR/onnx_hook.js)..."
    frida -p "$PID" -l "$SCRIPT_DIR/onnx_hook.js"
    ;;
  --trinity)
    echo "[*] Attaching TRINITY :7700 native socket interceptor ($SCRIPT_DIR/trinity_socket_hook.js)..."
    frida -p "$PID" -l "$SCRIPT_DIR/trinity_socket_hook.js"
    ;;
  --all|*)
    echo "[*] Attaching both ONNX Runtime tensor hook and TRINITY socket interceptor..."
    frida -p "$PID" -l "$SCRIPT_DIR/onnx_hook.js" -l "$SCRIPT_DIR/trinity_socket_hook.js"
    ;;
esac
