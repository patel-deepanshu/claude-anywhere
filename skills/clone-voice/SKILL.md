---
name: clone-voice
description: Record and clone the user's own voice (consent-gated, stays on this computer) so Claude Anywhere can answer calls in it. Use when the user runs /anywhere:clone-voice.
argument-hint: "[status | test | delete]"
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/run.js"*)
disable-model-invocation: true
---
Run `node "${CLAUDE_SKILL_DIR}/run.js" clone-voice $ARGUMENTS` (empty → `start`) and relay the output in 2–3 lines:
the enrollment opened in the Claude Anywhere dialog, it takes about 3 minutes, the voice stays on this computer,
and `/anywhere:clone-voice delete` removes it.
