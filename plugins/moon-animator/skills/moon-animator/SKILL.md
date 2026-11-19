---
name: moon-animator
description: Field guide for animating in Roblox Studio through the moon-animator-mcp tools (moon_status, moon_storyboard, moon_set_keyframes, moon_spin, moon_solve_reach, moon_export and the rest). Use it whenever the user wants to create, pose, review, fix or export a Moon Animator 2 animation or cutscene, including character animation, dances, flips, held props, camera shots, subtitles and letterbox, or asks what a Moon Animator file looks like, even if they only say "animate this rig" or "make a cutscene in Studio" while the moon_* tools are available. Not for animating in other tools such as Blender or Roblox's built-in Animation Editor.
---

# Animating with Moon Animator 2 through MCP

The `moon_*` tools drive Moon Animator 2 inside Roblox Studio. They let you see
the viewport, measure the rig, and write keyframes into the user's real Moon
Animator file. This guide covers what the tool descriptions cannot: the order
to work in, how joint angles behave, and the mistakes that cost the most time.

Tool names below are the bare names. Your client shows them with a prefix
(for example `mcp__moon-animator__moon_status`).

## Before anything else

Call `moon_status`. It tells you which of these is missing:

| Requirement | If missing |
| --- | --- |
| Roblox Studio open in edit mode (not playing) | Ask the user to open the place and stop any play test. |
| MoonBridge plugin connected | The server installs this Studio plugin itself when it starts. The user restarts Roblox Studio once and allows MoonBridge to make HTTP requests to 127.0.0.1. |
| Moon Animator 2 loaded and its window open | Moon Animator 2 is a separate plugin that the user installs from the Roblox Creator Store. It is not bundled and you cannot install it for them. Ask them to install it and open it from the Plugins tab. |
| A file open | `moon_open_file` with `create: true`. |

Do not work around a missing Moon Animator with Roblox's own animation tools:
the user chose Moon Animator, and its files are where they will keep editing.

When a tool result says an update is available, pass it on: tell the user the
version and the command it names, and carry on with the task. Updating is the
user's decision, so do not run the command unless they ask.

The tools change the user's live Studio session. Captures briefly hide the
Moon Animator window and move the camera, then put both back, so tell the user
when you are about to run a long series of captures.

## The loop

Animation written blind is almost always wrong. Work in this loop and keep each
pass small enough to check:

1. **Look**: `moon_scene` for structure, `moon_storyboard` for the whole piece,
   `moon_screenshot` with `focus` for one moment.
2. **Find the pose**: `moon_preview_pose` shows a pose from several sides
   without writing anything. `moon_solve_reach` computes joint angles that put
   a hand, foot or prop on a target.
3. **Commit**: `moon_set_keyframes` (one call is one undo step) or `moon_spin`
   for large rotations.
4. **Check**: `moon_storyboard` with `focus` on the rig for poses,
   `moon_motion_trail` for timing and arcs, `moon_sample` for numbers (foot
   sliding, hand-to-face distance, jump height).
5. **Fix or `moon_undo`**, then repeat.
6. **Finish**: `moon_save`, then `moon_export` if the user wants
   KeyframeSequences to publish.

Batch keyframes: one `moon_set_keyframes` call with a whole phrase of motion is
faster and undoes cleanly. Preview before committing whenever you are unsure
which way an angle goes; a preview costs one call, a wrong batch costs three.

Ask for only what you will read. `moon_sample` and `moon_preview_pose` report
positions for the `parts` you name, `moon_scene` leaves keyframe values out
unless `values` is set, and `moon_camera_path` and `moon_motion_trail` keep
their long per-frame lists behind `samples` and `detail`. Small images
(`cell_width`, `max_width`) are enough to judge a pose.

## Setting up a scene

- `moon_insert_rig` places a built-in rig (R15, R6, ...). `position` is where
  the feet go; `facing` 0 faces -Z.
- `moon_add_items` adds things to the file. Shortcuts: `camera`, `subtitles`,
  `letterbox`, `vignette`, `screen_cover`. A rig gets a track per joint, and
  the result lists the joint names: use those exact names.
- `moon_attach_prop` joins a prop to a rig part with a Motor6D, which makes the
  prop a joint you can key like any other (toss it, twirl it). Give `source` to
  copy an existing model from the place, or `parts` to build one from
  primitives. Attach props before the rig has many keyframes when you can: if
  the rig is already in the open file, the file must be saved first and is
  reloaded, which clears Moon Animator's undo history.
- `moon_settings` sets the timeline length and fps. Frames are the unit
  everywhere; read `fps` from `moon_status` to convert to seconds. Set fps
  before animating: changing it later either changes the speed of everything
  or, with `keep_timing`, renumbers every keyframe.
- `moon_remove_items` takes an item and its keyframes out of the file (the
  instance stays in the place).
- Any rig Moon Animator accepts works: Motor6D rigs, rigs jointed with
  AnimationConstraints (newer Roblox characters), and skinned meshes with
  bones. On a bone rig, name bones where the tools ask for parts.

If the user deletes a rig and inserts another with the same name while the file
is open, the file's tracks still drive the old one. `moon_status` and
`moon_scene` mark such an item `stale`, and editing tools refuse it. Call
`moon_save`, then `moon_open_file` with the same file name: reopening links
every item to the instances now in the place.

## Joint rotations

Rotations are XYZ degrees relative to the rest pose, in the joint's own frame.
For a rig facing -Z:

| Axis | Positive direction |
| --- | --- |
| X | Limb swings forward and up; torso or head leans back. |
| Y | Turns left. |
| Z | Raises the right side (tilts toward the left). |

Things that follow from this and are easy to get wrong:

- **Raising an arm forward** is +X on the upper arm. **Bending an elbow or
  knee** is X on the lower arm or lower leg; a knee bends with negative X, an
  elbow with positive X. If unsure, preview one joint at 60 degrees.
- **Raising an arm out to the side** is +Z on the right upper arm and -Z on
  the left; around 165 points it at the sky. Legs spread the same way: +Z on
  the right hip, -Z on the left.
- **Y on an upper arm only twists an arm that hangs down.** To move the hand
  sideways, raise the arm with X or Z first.
- **A prop's joint axes depend on how it is gripped.** Preview a small offset
  to learn which way is "up" for that prop before keying a toss.
- **The root joint moves the whole body.** On R15 it is `LowerTorso`; its
  `position` is in studs relative to the rest pose (Y up). A crouch is a lower
  root plus bent hips, knees and ankles; lowering the root alone pushes the
  feet through the floor.
- **Rotation interpolates along the shortest path.** Two keys more than 180
  degrees apart turn the wrong way. Use `moon_spin` for anything large instead
  of spacing keys by hand.
- **Easing belongs to the keyframe it starts from** and applies toward the next
  key on that track.

`joint` accepts the full hierarchy path or any unique ending, so `"Head"` or
`"RightUpperArm"` is enough on a standard rig.

## Getting a hand or prop onto a target

Guessing shoulder and elbow angles to bring a microphone to the mouth does not
converge. Measure instead:

1. `moon_solve_reach` with `end_part` (the hand or the prop's part),
   `relative_to` (for example `Head`), `target` in that part's local space, and
   the joints allowed to move. Limit hinges: `{"joint": "RightLowerArm",
   "axes": "x", "min": [0,0,0], "max": [150,0,0]}`.
2. Pass the returned rotations to `moon_preview_pose` to see them, then to
   `moon_set_keyframes`.
3. Solve again at each frame where the contact must hold. Body motion between
   those frames moves the hand, so key the contact every 15 frames or so while
   the body is moving, then confirm with `moon_sample` using `relative_to`.

Part names for `end_part` and `parts` come from the measurements the tools
return (`moon_preview_pose` and `moon_sample` list them). A prop's part can be
named differently from its joint.

## Contact between two characters

A punch, a grab or a handshake has to land on another rig, and that rig moves.

1. **Aim at the other rig directly.** `moon_solve_reach` takes
   `relative_to_item` next to `relative_to`, so the target can be a point in
   the opponent's own part space: `"relative_to": "Head", "relative_to_item":
   "Enemy", "target": [0, 0, -0.75]` is just in front of the opponent's face
   (a part's local -Z is its front). Solve at the frame of contact, after the
   opponent's motion is keyed, because the target follows the opponent.
2. **Let the body help.** Add `UpperTorso` with limits to the joints so the
   solver can twist and lean; an arm alone reaches about two studs.
3. **Read the gap.** When the result says `reached: false`, `distanceToTarget`
   is how much closer the attacker has to stand. Move the root joint by about
   that much on that frame and solve again.
4. **Check the whole exchange** with `moon_measure` from the fist to the target
   part across the frames around contact. `distance` is between the two
   points; `gap` is from the fist's centre to the surface of the target part's
   box, negative while inside it. A good hit has a small positive gap (about
   half a hand) on the contact frame and no `inside` frames on the way in or
   out. If the fist passes through on the way, add a key between.
5. **Look** with `focus: {"item": "Hero", "with": ["Enemy"], "view": "right"}`
   so both characters are in frame.

`moon_measure` also answers spacing questions: use `LowerTorso` to
`LowerTorso` for how far apart two characters stand (`HumanoidRootPart` does
not move with the animation). The gap uses the part's bounding box, which is
larger than the visible shape for heads and other rounded meshes; trust
`fromInToSpace` (the fist in the target part's local space) for exactly where
on the part the fist is.

## Flips, spins and jumps

`moon_spin` keys a rotation of any size on one joint with keys at most 90
degrees apart, so the turn goes the way you asked.

- Backflip: `axis: "x"`, `degrees: 360` on the root joint (positive X leans
  back). Front flip: `-360`. Pirouette: `axis: "y"`.
- `position_from`, `position_to` and `arc_height` move the root during the
  spin, so one call makes the whole airborne phase.
- Frame the flip with keys you write yourself: an anticipation crouch before
  `from_frame`, and a landing crouch that recovers after `to_frame`. Tuck the
  legs during the flip with ordinary keyframes on the hips and knees.
- `moon_spin` replaces keys already between the two frames on that joint, so
  spin first and add detail around it afterwards.

## Camera and cutscene

The camera is an item like any other. Key its `CFrame` with
`{"position": [...], "look_at": [...]}` and its `FieldOfView` with a number.

- **A cut** is two CFrame keys on neighbouring frames: the last frame of one
  shot and the first frame of the next. Key `FieldOfView` on the same two
  frames or the lens change will drift across the previous shot.
- **A move** is two keys with easing on the first (`Sine` `InOut` reads as a
  dolly; `Linear` reads as mechanical).
- **Tracking**: key the camera's `LookAtPart` property with an instance path
  (for example `"Workspace.Idol.UpperTorso"`) and `null` to release. The track
  is added the first time you key it. End tracking one frame before the cut
  that follows; ending it on the cut frame leaves one stale frame.
- **Subtitles**: key `Text` on the `subtitles` item; an empty string clears it.
- **Letterbox**: key `BackgroundTransparency` 0 on the `letterbox` item to show
  the bars.

`moon_camera_path` reports the shots it detects (cuts, moves, distances), which
is the quickest way to confirm the camera does what you intended.
`moon_storyboard` without arguments picks frames from those shots.

## Checking your work

| Question | Tool |
| --- | --- |
| Does the whole piece read? | `moon_storyboard` |
| Is this pose right from the side? | `moon_screenshot` with `focus: {item, view}` |
| What do the poses in this passage look like, ignoring the cutscene camera? | `moon_storyboard` with `frames` and `focus` |
| Is the timing snappy or floaty? Are the arcs clean? | `moon_motion_trail`: dots far apart are fast, bunched dots are slow or held |
| Do the feet slide? | `moon_sample` reports slide distance per planted foot |
| Is the hand really at the face? | `moon_sample` with `parts` and `relative_to` |
| Does the fist reach the opponent, and when? | `moon_measure` between the two parts |

Look at the images you request. A storyboard that shows a limb through the
body, a prop floating off the hand, or a character facing away from the camera
is a defect to fix before reporting success, not a detail to mention.

Notes in a tool result (for example that the viewport did not redraw in time)
mean the image may be stale: capture again before trusting it.

A `focus` view hides whatever stands between its camera and the item (a wall,
a tree) for that image only, and names what it hid in the notes. The cutscene
camera view hides nothing, so use it to judge what the audience will see.

Easing shows up in `moon_scene` as a label such as `Back/Out(overshoot=2.5)`.
An ease belongs to the keyframe it starts from.

## Saving and exporting

- `moon_save` writes the file into `ServerStorage.MoonAnimator2Saves` and, like
  saving in the UI, resets Studio's undo history. Save at milestones, not after
  every edit, so `moon_undo` stays useful.
- `moon_export` runs Moon Animator's own exporter and then compares every
  exported pose with the timeline. It writes a KeyframeSequence under
  `<rig>.AnimSaves` and a camera folder under the Camera. Publishing the
  KeyframeSequence to Roblox is the user's step.
- `moon_open_file` refuses to drop unsaved changes unless told to. Ask the user
  before discarding their work. Opening the file that is already open reloads
  it from its last save.

## What these tools do not do

Playing the animation at speed, copying and pasting keyframes, Moon Animator's
Mirror, Stretch and Repeat commands, and importing an existing animation are
not available as tools. Say so and let the user do them in the Moon Animator
window; `moon_scene` then shows you the result. To repeat or shift a phrase
yourself, read it with `moon_scene` (`values: true`) and write it again at the
new frames with `moon_set_keyframes`.

Nobody has watched the motion play until the user presses Play. Storyboards
and motion trails show poses and spacing, not rhythm, so ask the user to play
the result before calling an animation finished.

## When something goes wrong

- **"not connected"**: Studio is closed, Studio has not been restarted since
  the MoonBridge plugin was installed, or its HTTP permission was declined.
  `moon_status` says which.
- **A tool reports Moon Animator is not loaded**: the user has to install or
  open Moon Animator 2. Stop and tell them; nothing else will work.
- **A capture fails because the window is minimized or changed size**: the tool
  retries once on its own. If it still fails, ask the user to leave the Studio
  window open and unminimized.
- **A joint name is rejected**: read the joint list from `moon_scene` or the
  `moon_add_items` result. Rigs differ.
- **The pose looks mirrored or twisted**: you probably have a sign wrong.
  `moon_undo`, then `moon_preview_pose` a single joint to learn its direction.

For worked examples with real numbers (a singing pose with a microphone, a
backflip, a four-shot camera plan), read `references/recipes.md`.
