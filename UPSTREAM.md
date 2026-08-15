# Upstream maintenance

This repository is a focused fork of the DAP implementation in
`can1357/oh-my-pi/packages/coding-agent/src/dap` and its `debug` tool.

- `origin` is the downstream release repository.
- `upstream` is a read-only reference to `can1357/oh-my-pi`.
- `NOTICE.md` records the last reviewed upstream commit.
- Upstream changes are classified and ported. The monorepo history is never
  merged wholesale.
- Preserve the host launch-authorization seam, exact adapter selection,
  minimized environment, loopback-only listeners, owned process groups,
  restricted operation schema, and hidden-details renderer.
- Preserve the fixed Wasmtime-only macOS GDB JIT loader command; never widen it
  into user- or repository-controlled LLDB initialization commands.
- Preserve the documented macOS LLDB 21/22 stepping limitation until an
  admitted LLDB 32-or-newer guest-debug route is proven end to end.
- Advance only after the downstream commit and dependency graph are verified.

Retire the fork when a maintained package exposes equivalent host-policy and
operation-narrowing seams without downstream source changes.
