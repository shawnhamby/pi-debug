# pi-debug

Host-controlled Debug Adapter Protocol tools for Pi.

The package exports `createDebugExtension(options)` and has no automatic Pi
entrypoint. A trusted host must authorize every launch before the adapter or
target starts. The tool supports local launch, source breakpoints, pause,
continue, stepping, threads, stack frames, scopes, variables, output, session
status, and owned termination.

Pass launch-time source breakpoints through the existing `launch` action's
`breakpoints` array. Pi sends those breakpoints after adapter initialization
and before `configurationDone`, as required by DAP; `set_breakpoint` and
`remove_breakpoint` remain available for an active session.

Admitted routes are Python through debugpy, Node/JavaScript/TypeScript through
vscode-js-debug, compiled Rust binaries through explicit toolchain lldb-dap,
Go through Delve DAP, and a
constrained Wasmtime profile over lldb-dap. Missing prerequisites fail exactly;
the package never selects another debugger family.

The Node route admits vscode-js-debug's single loopback `startDebugging`
request for the initial policy-approved target. Additional targets, child
expansion, and execution-bearing reverse configuration remain rejected. The
Wasmtime route requires guest DWARF `.debug_info`, `.debug_abbrev`, and
`.debug_line` sections before either process starts. It starts `lldb-dap` with
Wasmtime's documented macOS GDB JIT loader setting enabled through one fixed
pre-initialization command so pending guest source breakpoints resolve when the
JIT image loads. This command is package-owned and cannot be supplied or
changed by a model, repository, or launch request. See Wasmtime's official
[native debugger guidance](https://docs.wasmtime.dev/examples-debugging-native-debugger.html).
On the admitted macOS LLDB 21/22 toolchains, guest breakpoints, stack frames,
scopes, and variables work, but source stepping can re-stop on the same JIT
breakpoint. Wasmtime's portable guest-debug route requires LLDB 32 or newer, so
the Wasmtime profile does not promise reliable source stepping on this host.

Attach, remote targets, arbitrary evaluation, memory access, custom DAP
requests, debugger command arrays, GDB, CodeLLDB, public listeners, adapter
installation, and repository-controlled DAP configuration are absent.

```ts
import { createDebugExtension } from "@shawnhamby/pi-debug";

export default createDebugExtension({
  async prepareLaunch(request) {
    return hostPolicyPreparedLaunch(request);
  },
});
```
