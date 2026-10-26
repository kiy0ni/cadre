# Security policy

Cadre runs a local engine on `127.0.0.1:8765`. Requests from the computer itself need no password; requests from any
other device (Tailscale, a public tunnel…) require a session opened with the remote-access password, which is stored
only as a salted PBKDF2-SHA256 hash.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository, with steps to reproduce and the
affected version. You will get an answer as soon as possible, and a fix will be released before details are made
public.
