<task>
Read the page at the URL below with your URL-reading tool and return its content.
</task>

<output_contract>
Return the page as markdown: keep headings, lists, tables and code blocks; drop navigation, cookie banners and footers. After the content, a `Links:` list of the outbound URLs you relied on, one per line. If the page could not be read, say exactly that and quote the error you saw; do not summarise from memory.
</output_contract>

URL:

{{URL}}

Before you reply, make sure nothing you started is still running: run tests and builds in one-shot mode (no watch mode), stop any server or process you started, and wait for or stop any command that was moved to the background. Stop a process only by the PID or job id of something you started; never use pkill, killall, or kill by name or by port, and never kill -1, kill 0, or a negative process group. If the user asked for a process to stay up, start it detached with nohup or setsid, output redirected to a file, and report its PID.
