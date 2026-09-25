<task>
Use your image generation tool to create the image described below.
</task>

<output_contract>
Reply with exactly one line: the absolute path of the saved image file. No other text. If you have no image generation tool, reply with exactly: NO_IMAGE_TOOL
</output_contract>

<done_state>
The image file exists on disk at the absolute path you reported.
</done_state>

<action_safety>
Write only the one image file, inside your own working area. Do not modify, move, or delete any other file, and run no other command.
</action_safety>

Description:

{{DESCRIPTION}}

Before you reply, make sure nothing you started is still running: run tests and builds in one-shot mode (no watch mode), stop any server or process you started, and wait for or stop any command that was moved to the background. Stop a process only by the PID or job id of something you started; never use pkill, killall, or kill by name or by port, and never kill -1, kill 0, or a negative process group. If the user asked for a process to stay up, start it detached with nohup or setsid, output redirected to a file, and report its PID.
