<task>
Investigate the topic below with web research. Search widely, read the primary sources, and write the report described in the output contract.
</task>

<output_contract>
Markdown, these sections in this order, these exact headings:

## Summary
Three to five sentences.

## Key findings
One finding per bullet, each with its source inline as a full URL.

## Disagreements and thin evidence
Where sources disagree, and where the evidence is thin.

## Caveats
What was not checked, and what could change the conclusion.

## Sources
Numbered, one full URL per line.
</output_contract>

<grounding_rules>
No claim without a source in the list. Prefer primary sources (documentation, specifications, release notes, papers) over commentary. Say when a source is dated. If the topic cannot be answered from what you found, say so.
</grounding_rules>

Topic:

{{TOPIC}}

Before you reply, make sure nothing you started is still running: run tests and builds in one-shot mode (no watch mode), stop any server or process you started, and wait for or stop any command that was moved to the background. Stop a process only by the PID or job id of something you started; never use pkill, killall, or kill by name or by port, and never kill -1, kill 0, or a negative process group. If the user asked for a process to stay up, start it detached with nohup or setsid, output redirected to a file, and report its PID.
