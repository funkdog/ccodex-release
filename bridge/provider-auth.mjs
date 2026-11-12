// Codex command-auth marker for the local bridge. The bridge owns GitHub
// authentication itself; this non-secret token only enables Codex's remote
// `/models?client_version=...` refresh path.
process.stdout.write("codex-copilot-local\n");
