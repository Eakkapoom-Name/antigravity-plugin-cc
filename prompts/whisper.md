<task>
Answer the question below directly. This is a one-shot exchange with no repository attached.
</task>

<output_contract>
Answer first, in as few lines as the answer needs. When the answer rests on something you looked up on the web, end with a `Sources:` list of full URLs. When you are not sure, say so instead of filling the gap.
</output_contract>

Question:

{{PROMPT}}

Before you reply, make sure nothing you started is still running: run tests and builds in one-shot mode (no watch mode), stop any server or process you started, and wait for or stop any command that was moved to the background. Stop a process only by the PID or job id of something you started; never use pkill, killall, or kill by name or by port, and never kill -1, kill 0, or a negative process group. If the user asked for a process to stay up, start it detached with nohup or setsid, output redirected to a file, and report its PID.
