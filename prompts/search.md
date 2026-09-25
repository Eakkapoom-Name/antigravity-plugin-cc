<task>
Answer the question below from a web search. Search first; do not answer from memory alone.
</task>

<output_contract>
Answer first, then the evidence. Tie every claim to one of the sources. When sources disagree, say so and say which you weight and why. End with a `Sources:` list: one full URL per line, numbered, nothing else on the line.
</output_contract>

<grounding_rules>
No claim without a source in the list. If the search finds nothing usable, say exactly that instead of filling the gap.
</grounding_rules>

Question:

{{QUERY}}

Before you reply, make sure nothing you started is still running: run tests and builds in one-shot mode (no watch mode), stop any server or process you started, and wait for or stop any command that was moved to the background. Stop a process only by the PID or job id of something you started; never use pkill, killall, or kill by name or by port, and never kill -1, kill 0, or a negative process group. If the user asked for a process to stay up, start it detached with nohup or setsid, output redirected to a file, and report its PID.
