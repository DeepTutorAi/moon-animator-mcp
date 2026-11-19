# Worked recipes

Numbers here come from a tested scene: a built-in R15 rig named `Idol` facing
-Z at 60 fps, holding a microphone prop on the right hand. Treat them as
starting points and check each with `moon_preview_pose` on your own rig; limb
proportions and prop grips change the result.

Rotations are `[x, y, z]` degrees, positions are studs, both relative to rest.

## Contents

- Idle to singing pose with a microphone
- Groove on the beat with planted feet
- Backflip
- Final pose and prop toss
- Four-shot camera plan with subtitles

## Idle to singing pose with a microphone

Head bowed at the start, then up with the microphone at the mouth.

| Frame | Joint | Rotation |
| --- | --- | --- |
| 0 | UpperTorso | [-10, 0, 0] |
| 0 | Head | [-30, 0, 0] |
| 0 | RightUpperArm / LeftUpperArm | [0, 0, 8] / [0, 0, -8] |
| 0 | RightLowerArm / LeftLowerArm | [10, 0, 0] |
| 55 | UpperTorso | [0, 0, 0] |
| 55 | Head | [5, 0, 0] |
| 55 | RightUpperArm | [55, 25, 0] |
| 55 | RightLowerArm | [100, 0, 0] |

The arm angles at frame 55 are a rough guess. Refine them with the solver so
the microphone sits just in front of the mouth:

```json
{
  "item": "Idol", "frame": 55,
  "end_part": "Mic_2", "relative_to": "Head", "target": [0, -0.2, -0.8],
  "joints": [
    {"joint": "RightUpperArm"},
    {"joint": "RightLowerArm", "axes": "x", "min": [0, 0, 0], "max": [150, 0, 0]}
  ]
}
```

`Mic_2` was the name of the microphone head part in that scene; read the real
part names from a `moon_preview_pose` or `moon_sample` result. In the head's
local space -Z is forward and -Y is down, so `[0, -0.2, -0.8]` is slightly
below and in front of the face.

Repeat the solve on every frame where the body has moved (every 15 frames
during a groove) and key each result. In the test this took the worst
microphone-to-mouth distance from 1.59 studs to 0.04.

## Groove on the beat with planted feet

A beat every 30 frames. On the beat the body drops and sways to one side; 15
frames later it rises. Swaying the root sideways slides the feet unless the
legs lean the other way, so hips and ankles get opposite Z.

On a beat swaying to the character's right (`side = 1`; use -1 for the left):

| Joint | Rotation | Position | Ease |
| --- | --- | --- | --- |
| LowerTorso | [0, -8, -4] | [0.22, -0.25, 0] | Quad Out |
| UpperTorso | [0, 10, 4] | | |
| Head | [4, 8, 5] | | |
| RightUpperLeg, LeftUpperLeg | [35, 0, -6.5] | | Quad Out |
| RightLowerLeg, LeftLowerLeg | [-60, 0, 0] | | Quad Out |
| RightFoot, LeftFoot | [25, 0, 6.5] | | Quad Out |

Fifteen frames later (the rise): LowerTorso rotation [0, 0, 0] and position
[0.066, 0, 0], legs [8, 0, -2], knees [-14, 0, 0], feet [6, 0, 2], all with
Quad In.

Verify with `moon_sample` over the passage: the contact report should show
both feet sliding less than about 0.1 studs.

## Backflip

Three parts: wind-up, airborne spin, landing.

**Wind-up** (reach up at 196, deep crouch at 212):

| Frame | Joint | Rotation | Position |
| --- | --- | --- | --- |
| 196 | LowerTorso | [4, 0, 0] | [0, 0.05, 0] |
| 196 | Upper arms | [60, 0, 8] right, [60, 0, -8] left | |
| 212 | LowerTorso | [-20, 0, 0] | [0, -1.0, 0] |
| 212 | Upper legs / lower legs / feet | [100, 0, 0] / [-120, 0, 0] / [40, 0, 0] | |
| 212 | Upper arms | [-60, 0, 10] right, [-60, 0, -10] left | |

**Airborne** (takeoff 218, touchdown 258): one `moon_spin` on the root.

```json
{
  "item": "Idol", "joint": "LowerTorso",
  "from_frame": 218, "to_frame": 258,
  "axis": "x", "degrees": 360,
  "position_from": [0, 0.3, 0], "position_to": [0, 0, 1.5],
  "arc_height": 3
}
```

Then tuck with ordinary keyframes while the root spins:

| Frame | Hips | Knees | Feet | Upper arms X | Elbows | Head |
| --- | --- | --- | --- | --- | --- | --- |
| 218 | 0 | 0 | -30 | 170 | 0 | 20 |
| 224 | 60 | -70 | -10 | 120 | 30 | 25 |
| 230 | 115 | -125 | 0 | 60 | 65 | 15 |
| 242 | 115 | -125 | 0 | 60 | 65 | 10 |
| 248 | 80 | -80 | 5 | 100 | 40 | 0 |
| 254 | 40 | -50 | 10 | 70 | 30 | -10 |

**Landing**: touch down at 260 with soft knees (hips 30, knees -45, feet 15,
Quad Out), sink to 268 (LowerTorso [-12, 0, 0] at [0, -0.65, 1.5]; hips 80,
knees -100, feet 32), then rise.

Check it with `moon_storyboard` using `frames` every 6 frames and
`focus: {"item": "Idol", "view": "right"}`, and with `moon_motion_trail` from
196 to 262 in the `right` view: the head should trace one clean loop.

## Final pose and prop toss

Microphone raised to the sky at frame 300: RightUpperArm [0, 0, 165],
RightLowerArm [0, 0, 0], Head [15, 0, 0], legs spread 12 degrees.

The toss keys the prop's own joint (named `Mic` in that scene) from 306 to
344: position follows an arc that peaks 2.6 studs from the hand, and rotation
advances 90 degrees per key for two full turns. Key rotation at most 90
degrees apart, or use `moon_spin` on the prop joint. The hand dips before the
throw (RightUpperArm Z 150 at 306, 172 at 311) and the head tilts up to follow
the prop (Head [28, 0, 0] at 325).

Which local axis is "away from the hand" depends on the grip; in that scene it
was -Y. Preview a 1 stud offset first.

## Four-shot camera plan with subtitles

Character at [20, 0, 0]. Each cut is a pair of keys on neighbouring frames.

| Shot | Frames | Position → | Look at | FOV | Idea |
| --- | --- | --- | --- | --- | --- |
| 1 | 0–59 | [21.2, 4.3, -4.5] → [20.6, 4.4, -3.2] | [20, 4.3, 0] | 35 | Slow push-in on the face |
| 2 | 60–180 | [15, 3.2, -10] → [24.5, 3.2, -10.5] | [20, 2.9, 0] | 50 | Wide lateral move during the groove |
| 3 | 181–268 | [28.5, 1.3, -3.5] → [27.5, 1.3, -5] | tracks UpperTorso | 62 | Low side angle for the flip |
| 4 | 269–360 | [18.2, 1.1, -5] → [18.8, 1.4, -3.8] | [20, 4.2, 1.5] | 48 → 42 | Low hero angle on the final pose |

Keyframes that make this work:

- `CFrame` at the first and last frame of each shot, `Sine` `InOut` on the
  first key of a moving shot.
- `FieldOfView` at the same frames, so each cut changes lens instantly.
- `LookAtPart`: `null` at 0, `"Workspace.Idol.UpperTorso"` at 181, `null` at
  268. Tracking is released one frame before the cut at 269; releasing it on
  the cut frame leaves one frame of the new shot aimed by the old target.
- Subtitles `Text`: `""` at 0, a line at the frame it should appear, `""` at
  the frame it should disappear.
- Letterbox `BackgroundTransparency` 0 at frame 0.

Afterwards `moon_camera_path` should list four shots with cuts at 60, 181 and
269, and `moon_storyboard` should show each shot's start, middle and end.
