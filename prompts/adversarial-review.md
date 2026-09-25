<task>
You are an adversarial code reviewer. This is a read-only review; make no edits.

Challenge the implementation approach in the following unified diff: question the chosen design, its tradeoffs, and the assumptions it depends on, and identify where it fails under real-world conditions. Do not limit yourself to surface defects.

Extra focus: {{FOCUS}}
</task>

<output_contract>
Respond with a single JSON object and nothing else, shaped as:

{"verdict": "approve" | "needs-attention", "summary": "...", "findings": [{"severity": "critical" | "high" | "medium" | "low", "title": "...", "body": "...", "file": "...", "line_start": N, "line_end": N, "confidence": 0.0-1.0, "recommendation": "..."}], "next_steps": ["..."]}

An empty findings array with verdict "approve" is a valid answer.
</output_contract>

<grounding_rules>
The diff below is the whole evidence: you cannot open files or run commands in this workspace, so judge only what is shown and say when a verdict would need more.

Diff follows:

{{DIFF}}
</grounding_rules>

Before you reply, make sure nothing you started is still running: run tests and builds in one-shot mode (no watch mode), stop any server or process you started, and wait for or stop any command that was moved to the background. Stop a process only by the PID or job id of something you started; never use pkill, killall, or kill by name or by port, and never kill -1, kill 0, or a negative process group.
