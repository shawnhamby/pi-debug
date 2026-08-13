# Attribution

The DAP framing, launch ordering, transport settlement, child-session handling,
and owned-process cleanup design are adapted from Oh My Pi's coding-agent DAP
implementation at `can1357/oh-my-pi@a53e4e790d3939a08708bf0d3c912d0763237a2d`.

This fork narrows that implementation to launch-owned local sessions, source
breakpoints, stepping, and state inspection. It removes attach, evaluation,
custom requests, memory operations, GDB, CodeLLDB, repository-controlled
adapter configuration, and public or remote transports.
