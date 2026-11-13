# Host-Side Frida Instrumentation Kit for Semantic Router

This directory contains host-level dynamic instrumentation scripts for **Semantic Router Studio** using [Frida](https://frida.re/). These scripts attach directly to the running Node.js / V8 process at the native C/C++ layer without modifying application source code.

---

## Capabilities

| Script | Target | Hook Layer | Capabilities |
|---|---|---|---|
| `onnx_hook.js` | `onnxruntime_binding.node` / `libonnxruntime` | Native C++ (`OrtApi::Run` / N-API) | Captures raw float32 embedding tensors before JS-layer L2-normalization; sub-millisecond native timing; in-memory adversarial $\epsilon$-perturbation injection for EM-1. |
| `trinity_socket_hook.js` | `libuv` / libc socket syscalls (`send`, `recv`, `connect`) | OS Socket layer | Intercepts HTTP request/response payloads to TRINITY `:7700` (`/query`, `/context`, `/ingest`); measures kernel RTT vs application `fetch()` latency; inspects `kappa` and `tessa` confidence parameters. |
| `run_instrumentation.sh` | CLI Wrapper | Bash / `frida` CLI | Discovers server PID automatically, validates ptrace permissions, and attaches the selected scripts. |

---

## Prerequisites & Setup (Bare-Metal / Local Host)

1. **Install Frida Tools**:
   ```bash
   pip install frida-tools
   ```

2. **Linux Permissions (ptrace scope)**:
   By default, Linux kernel security restricts attaching to non-child processes. Enable non-root ptrace:
   ```bash
   sudo sysctl -w kernel.yama.ptrace_scope=0
   ```
   Or run the Frida scripts with `sudo`:
   ```bash
   sudo frida -p $(pgrep -f "tsx server.ts") -l frida/onnx_hook.js
   ```

3. **macOS Permissions**:
   On macOS, ensure Terminal or iTerm has Developer Tools privileges under `System Settings > Privacy & Security > Developer Tools`.

---

## Execution

Start the Semantic Router server in one terminal:
```bash
npm run dev
```

In another terminal:

```bash
# Attach both ONNX tensor inspector and TRINITY socket hooks:
./frida/run_instrumentation.sh

# Or attach ONNX tensor inspection only:
./frida/run_instrumentation.sh --onnx

# Or attach TRINITY socket interceptor only:
./frida/run_instrumentation.sh --trinity
```

---

## Adversarial Vector Perturbation (EM-1 Robustness Testing)

In `frida/onnx_hook.js`, modify the `CONFIG` object or invoke via Frida RPC:
```javascript
CONFIG.perturbation.enabled = true;
CONFIG.perturbation.epsilon = 0.20; // 20% directional vector perturbation
```
When enabled, the hook writes directly into the output tensor float32 memory buffer inside `onnxruntime_binding.node` before control returns to Node.js, allowing you to test if guardrails (e.g., `prompt_injection_guard`) survive native vector tampering.
