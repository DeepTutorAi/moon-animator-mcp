"""Generates moon_set_keyframes arguments for the test dance cutscene."""
import json
import sys

K = []
SINE = {"type": "Sine", "direction": "InOut"}
QOUT = {"type": "Quad", "direction": "Out"}
QIN = {"type": "Quad", "direction": "In"}
QIO = {"type": "Quad", "direction": "InOut"}


def joint(name, frame, rot=(0, 0, 0), pos=None, ease=SINE):
    entry = {"item": "Idol", "joint": name, "frame": frame, "rotation": list(rot)}
    if pos is not None:
        entry["position"] = list(pos)
    if ease:
        entry["ease"] = ease
    K.append(entry)


def prop(item, name, frame, value, ease=None):
    entry = {"item": item, "property": name, "frame": frame, "value": value}
    if ease:
        entry["ease"] = ease
    K.append(entry)


ROOT, WAIST, HEAD = "LowerTorso", "UpperTorso", "Head"
RSH, REL, LSH, LEL = "RightUpperArm", "RightLowerArm", "LeftUpperArm", "LeftLowerArm"
RHIP, RKN, RAN = "RightUpperLeg", "RightLowerLeg", "RightFoot"
LHIP, LKN, LAN = "LeftUpperLeg", "LeftLowerLeg", "LeftFoot"
MIC = "Mic"

SING_SH, SING_EL = (55, 25, 0), (100, 0, 0)


def legs(frame, hip, knee, ankle, spread=0, ease=SINE):
    """Both legs: flexion angles plus a sideways stance spread in degrees."""
    joint(RHIP, frame, (hip, 0, spread), ease=ease)
    joint(LHIP, frame, (hip, 0, -spread), ease=ease)
    joint(RKN, frame, (knee, 0, 0), ease=ease)
    joint(LKN, frame, (knee, 0, 0), ease=ease)
    joint(RAN, frame, (ankle, 0, -spread), ease=ease)
    joint(LAN, frame, (ankle, 0, spread), ease=ease)


# --- A. Intro: head down, then look up and bring the mic to the mouth -------
joint(ROOT, 0, pos=(0, 0, 0))
joint(WAIST, 0, (-10, 0, 0))
joint(HEAD, 0, (-30, 0, 0))
joint(RSH, 0, (0, 0, 8))
joint(REL, 0, (10, 0, 0))
joint(LSH, 0, (0, 0, -8))
joint(LEL, 0, (10, 0, 0))
legs(0, 0, 0, 0)
joint(MIC, 0)

joint(WAIST, 30, (-10, 0, 0))
joint(HEAD, 30, (-30, 0, 0))
joint(RSH, 30, (0, 0, 8))
joint(REL, 30, (10, 0, 0))

joint(WAIST, 55, (0, 0, 0))
joint(HEAD, 55, (5, 0, 0))
joint(RSH, 55, SING_SH)
joint(REL, 55, SING_EL)
joint(LSH, 55, (0, 0, -15))

# --- B. Groove: sway and bounce on every beat (half a second) ---------------
for i, beat in enumerate(range(60, 181, 30)):
    side = 1 if i % 2 == 0 else -1  # +1 sways to the character's right
    last = beat == 180
    sway = 0 if last else 0.22 * side
    lean = 0 if last else 6.5 * side  # legs tilt so the feet stay planted
    joint(ROOT, beat, (0, -8 * side * (not last), -4 * side * (not last)), (sway, -0.25, 0), ease=QOUT)
    joint(WAIST, beat, (0, 10 * side * (not last), 4 * side * (not last)))
    joint(HEAD, beat, (4, 8 * side * (not last), 5 * side * (not last)))
    joint(RHIP, beat, (35, 0, -lean), ease=QOUT)
    joint(LHIP, beat, (35, 0, -lean), ease=QOUT)
    joint(RKN, beat, (-60, 0, 0), ease=QOUT)
    joint(LKN, beat, (-60, 0, 0), ease=QOUT)
    joint(RAN, beat, (25, 0, lean), ease=QOUT)
    joint(LAN, beat, (25, 0, lean), ease=QOUT)
    joint(RSH, beat, SING_SH)
    joint(REL, beat, (108, 0, 0))
    if side > 0 and not last:
        joint(LSH, beat, (0, 0, -150), ease=QOUT)  # left arm points up
        joint(LEL, beat, (0, 0, -10), ease=QOUT)
    else:
        joint(LSH, beat, (45, 0, -25), ease=QOUT)  # left arm punches forward
        joint(LEL, beat, (70, 0, 0), ease=QOUT)
    if not last:  # rise between beats
        up = beat + 15
        joint(ROOT, up, (0, 0, 0), (sway * 0.3, 0, 0), ease=QIN)
        joint(RHIP, up, (8, 0, -lean * 0.3), ease=QIN)
        joint(LHIP, up, (8, 0, -lean * 0.3), ease=QIN)
        joint(RKN, up, (-14, 0, 0), ease=QIN)
        joint(LKN, up, (-14, 0, 0), ease=QIN)
        joint(RAN, up, (6, 0, lean * 0.3), ease=QIN)
        joint(LAN, up, (6, 0, lean * 0.3), ease=QIN)
        joint(REL, up, SING_EL)

# --- C. Wind-up: reach up, then drop into a deep crouch ---------------------
joint(ROOT, 196, (4, 0, 0), (0, 0.05, 0), ease=QIO)
legs(196, 4, -6, 2, ease=QIO)
joint(WAIST, 196, (6, 0, 0))
joint(HEAD, 196, (8, 0, 0))
joint(RSH, 196, (60, 0, 8), ease=QIO)
joint(REL, 196, (25, 0, 0), ease=QIO)
joint(LSH, 196, (60, 0, -8), ease=QIO)
joint(LEL, 196, (25, 0, 0), ease=QIO)

joint(ROOT, 212, (-20, 0, 0), (0, -1.0, 0), ease=QOUT)
legs(212, 100, -120, 40, ease=QOUT)
joint(WAIST, 212, (-12, 0, 0), ease=QOUT)
joint(HEAD, 212, (-5, 0, 0), ease=QOUT)
joint(RSH, 212, (-60, 0, 10), ease=QOUT)
joint(REL, 212, (12, 0, 0), ease=QOUT)
joint(LSH, 212, (-60, 0, -10), ease=QOUT)
joint(LEL, 212, (12, 0, 0), ease=QOUT)

# --- D. Backflip -------------------------------------------------------------
TAKEOFF, TOUCHDOWN, PEAK, DRIFT = 218, 258, 3.0, 1.5
spin = {218: 15, 224: 60, 230: 120, 236: 190, 242: 255, 248: 310, 254: 345}
for frame in range(TAKEOFF, TOUCHDOWN + 1, 2):
    t = (frame - TAKEOFF) / (TOUCHDOWN - TAKEOFF)
    height = 0.3 + 4 * PEAK * t * (1 - t)
    # Rotation between the listed frames is linear in time.
    frames = sorted(spin)
    if frame <= frames[0]:
        angle = spin[frames[0]]
    elif frame >= frames[-1]:
        angle = spin[frames[-1]] + (360 - spin[frames[-1]]) * (frame - frames[-1]) / (260 - frames[-1])
    else:
        lo = max(f for f in frames if f <= frame)
        hi = min(f for f in frames if f > frame)
        angle = spin[lo] + (spin[hi] - spin[lo]) * (frame - lo) / (hi - lo)
    joint(ROOT, frame, (angle % 360, 0, 0), (0, height, DRIFT * t), ease=None)

tuck = [  # frame, hip, knee, ankle, shoulder, elbow, head
    (218, 0, 0, -30, 170, 0, 20),
    (224, 60, -70, -10, 120, 30, 25),
    (230, 115, -125, 0, 60, 65, 15),
    (242, 115, -125, 0, 60, 65, 10),
    (248, 80, -80, 5, 100, 40, 0),
    (254, 40, -50, 10, 70, 30, -10),
]
for frame, hip, knee, ankle, shoulder, elbow, head in tuck:
    legs(frame, hip, knee, ankle, ease=None)
    joint(RSH, frame, (shoulder, 0, 8), ease=None)
    joint(LSH, frame, (shoulder, 0, -8), ease=None)
    joint(REL, frame, (elbow, 0, 0), ease=None)
    joint(LEL, frame, (elbow, 0, 0), ease=None)
    joint(HEAD, frame, (head, 0, 0), ease=None)
    joint(WAIST, frame, (-15 if 224 < frame < 248 else 0, 0, 0), ease=None)

# Touchdown and absorb.
joint(ROOT, 260, (0, 0, 0), (0, 0, DRIFT), ease=QOUT)
legs(260, 30, -45, 15, spread=6, ease=QOUT)
joint(RSH, 260, (30, 0, 45), ease=QOUT)
joint(LSH, 260, (30, 0, -45), ease=QOUT)
joint(REL, 260, (20, 0, 0), ease=QOUT)
joint(LEL, 260, (20, 0, 0), ease=QOUT)
joint(HEAD, 260, (-12, 0, 0), ease=QOUT)

joint(ROOT, 268, (-12, 0, 0), (0, -0.65, DRIFT), ease=QIO)
legs(268, 80, -100, 32, spread=8, ease=QIO)
joint(WAIST, 268, (-8, 0, 0), ease=QIO)
joint(HEAD, 268, (-15, 0, 0), ease=QIO)
joint(RSH, 268, (20, 0, 55), ease=QIO)
joint(LSH, 268, (20, 0, -55), ease=QIO)

# --- E. Rise into the final pose: mic raised to the sky ----------------------
joint(ROOT, 300, (0, 0, 0), (0, -0.05, DRIFT), ease=SINE)
legs(300, 0, 0, 0, spread=12)
joint(WAIST, 300, (8, 0, -3))
joint(HEAD, 300, (15, 0, 0))
joint(RSH, 300, (0, 0, 165), ease=QOUT)
joint(REL, 300, (0, 0, 0))
joint(LSH, 300, (0, 0, -50))
joint(LEL, 300, (0, 0, -25))

# --- F. Mic toss: thrown up from the raised hand, two flips, caught ----------
T0, T1, TOSS = 306, 344, 2.6
joint(RSH, 306, (0, 0, 150), ease=QOUT)
joint(RSH, 311, (0, 0, 172), ease=SINE)
joint(RSH, 344, (0, 0, 160), ease=SINE)
joint(RSH, 354, (0, 0, 165), ease=SINE)
joint(HEAD, 325, (28, 0, 0))
joint(HEAD, 354, (15, 0, 0))
for i in range(9):
    frame = T0 + round((T1 - T0) * i / 8)
    t = i / 8
    joint(MIC, frame, (0, 0, (90 * i) % 360), (0, -TOSS * 4 * t * (1 - t), 0), ease=None)

# --- G. Camera, subtitles, letterbox ----------------------------------------
def cam(frame, position, look_at, ease=None):
    prop("camera", "CFrame", frame, {"position": position, "look_at": look_at}, ease)


cam(0, [21.2, 4.3, -4.5], [20, 4.3, 0], SINE)
cam(59, [20.6, 4.4, -3.2], [20, 4.35, 0])
cam(60, [15, 3.2, -10], [20, 2.9, 0], SINE)
cam(180, [24.5, 3.2, -10.5], [20, 2.9, 0])
cam(181, [28.5, 1.3, -3.5], [20, 3.5, 0.5])
cam(268, [27.5, 1.3, -5], [20, 3.5, 0.5])
cam(269, [18.2, 1.1, -5.0], [20, 4.2, DRIFT], SINE)
cam(360, [18.8, 1.4, -3.8], [20, 4.6, DRIFT])

prop("camera", "FieldOfView", 0, 35)
prop("camera", "FieldOfView", 59, 35)
prop("camera", "FieldOfView", 60, 50)
prop("camera", "FieldOfView", 180, 50)
prop("camera", "FieldOfView", 181, 62)
prop("camera", "FieldOfView", 268, 62)
prop("camera", "FieldOfView", 269, 48, SINE)
prop("camera", "FieldOfView", 360, 42)

prop("camera", "LookAtPart", 0, None)
prop("camera", "LookAtPart", 181, "Workspace.Idol.UpperTorso")
prop("camera", "LookAtPart", 269, None)

prop("Subtitles", "Text", 0, "")
prop("Subtitles", "Text", 8, "Are you ready?")
prop("Subtitles", "Text", 60, "Feel the beat!")
prop("Subtitles", "Text", 181, "")
prop("Subtitles", "Text", 272, "Thank you!")
prop("Subtitles", "Text", 356, "")

prop("Letterbox", "BackgroundTransparency", 0, 0)

# A later entry for the same track and frame replaces an earlier one.
unique = {}
for entry in K:
    unique[(entry["item"], entry.get("joint"), entry.get("property"), entry["frame"])] = entry
K = list(unique.values())
json.dump({"keyframes": K}, open(sys.argv[1], "w"))
print(len(K), "keyframes")
