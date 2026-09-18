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
