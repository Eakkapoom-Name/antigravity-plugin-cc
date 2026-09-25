You are taking over an ongoing task from another assistant. Read this handoff brief, then reply with:

(a) your one-paragraph understanding of the goal and current state
(b) the first action you would take

Do not start working yet.

{{BRIEF}}

Before you reply, make sure nothing you started is still running: run tests and builds in one-shot mode (no watch mode), stop any server or process you started, and wait for or stop any command that was moved to the background. Stop a process only by the PID or job id of something you started; never use pkill, killall, or kill by name or by port, and never kill -1, kill 0, or a negative process group. If the user asked for a process to stay up, start it detached with nohup or setsid, output redirected to a file, and report its PID.
