---
name: krun-explain
description: Show why Krun Router selected the model for the most recent prompt.
disable-model-invocation: true
allowed-tools: Bash(node *)
---

<krun-explain>
Return the report below verbatim inside a plain text code block. Do not add analysis and do not use tools.

!`node "${CLAUDE_SKILL_DIR}/../../../../../bin/krun-explain.mjs"`
