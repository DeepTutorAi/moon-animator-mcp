"""Uses the MCP reach solver to put the microphone at the mouth on every singing frame."""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = sys.argv[1]
TARGET = [0, -0.2, -0.8]  # just in front of the mouth, in the head's local space


def call(tool, args):
    with open(OUT + "/args.json", "w") as handle:
        json.dump(args, handle)
    result = subprocess.run(
        ["node", "tools/mcp-call.mjs", tool, "@" + OUT + "/args.json"],
        cwd=ROOT, capture_output=True, text=True,
    )
    text = result.stdout
    return json.loads(text[text.index("{"):]) if "{" in text else text.strip()


def mic_error(frames):
    data = call("moon_sample", {"item": "Idol", "frames": frames, "parts": ["Mic_2"], "relative_to": "Head"})
    errors = {}
    for sample in data["samples"]:
        p = sample["parts"]["Mic_2"]
        errors[sample["frame"]] = round(sum((a - b) ** 2 for a, b in zip(p, TARGET)) ** 0.5, 3)
    return errors


check = list(range(55, 181, 5))
before = mic_error(check)

keyframes = []
for frame in (55, 60, 75, 90, 105, 120, 135, 150, 165, 180):
    solved = call("moon_solve_reach", {
        "item": "Idol", "frame": frame, "end_part": "Mic_2", "relative_to": "Head", "target": TARGET,
        "joints": [{"joint": "RightUpperArm"}, {"joint": "RightLowerArm", "axes": "x", "min": [0, 0, 0], "max": [150, 0, 0]}],
    })
    if not isinstance(solved, dict) or not solved.get("reached"):
        print("frame", frame, "not reached:", solved)
        continue
    for joint in solved["joints"]:
        keyframes.append({
            "item": "Idol", "joint": joint["joint"], "frame": frame,
            "rotation": joint["rotation"], "ease": {"type": "Sine", "direction": "InOut"},
        })

applied = call("moon_set_keyframes", {"keyframes": keyframes})
after = mic_error(check)

print("applied:", applied)
print("mic distance from mouth, before -> after (studs):")
for frame in check:
    print(f"  f{frame}: {before[frame]} -> {after[frame]}")
print("worst before", max(before.values()), "worst after", max(after.values()))
