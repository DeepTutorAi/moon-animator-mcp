# Changelog

## 0.1.4

The Studio plugin (MoonBridge) is unchanged in this release.

### Added

- Update notice. The server looks up the latest version when it starts and,
  when a newer one exists, says so in the first tool result of the session, in
  `moon_status` (`server.latest`) and in the server log, with the command to
  update. Nothing is updated automatically. `MOON_MCP_NO_UPDATE_CHECK=1` turns
  the lookup off.
- `update` command: moves the Claude Code registration of the server to the
  latest release, keeping its scope and environment variables, and refreshes
  installed copies of the skill. `--mcp` or `--skill` limit it to one of them,
  `--check` only reports.
- `install-skill` records the release a copy came from, and `doctor` lists the
  installed skills and the latest release.

## 0.1.3

The Studio plugin (MoonBridge) is unchanged in this release.

### Fixed

- Rigs jointed with AnimationConstraints: `moon_sample`, `moon_preview_pose`,
  `moon_solve_reach` and `moon_motion_trail` measured the pose from before the
  change, so the solver and distance checks did not work. Measurements now
  wait for the engine to apply the pose.
- `LookAtPart` (and any other property an item supports but has no track for)
  can be keyed on an item added with a shortcut: `moon_set_keyframes` adds the
  track.
- `moon_open_file` with the name of the open file now reloads it from its last
  save instead of answering "already open".
- A rig deleted and replaced by another of the same name: `moon_status` and
  `moon_scene` mark the item `stale`, editing tools refuse it with the fix, and
  reopening the file links the tracks to the new rig. Closing a file in this
  state no longer fails partway inside Moon Animator.
- `focus` views hide scenery standing between the camera and the item, for
  that image only, and name it in the notes. Other items of the file are never
  hidden.
- `moon_scene` reports easing parameters, for example `Back/Out(overshoot=2.5)`.

### Added

- `moon_measure` reports the distance between two points on any items over
  frames, the gap to the surface of the target part, the closest frame and the
  frames spent inside it. Made for contact between characters.
- `moon_solve_reach`, `moon_sample` and `moon_preview_pose` take
  `relative_to_item`, so a target or a position can be given in the space of a
  part of another item, such as an opponent's head.
- `focus` and `moon_preview_pose` take `with` to keep other items in frame.
- `moon_remove_items` removes items from the file.
- `moon_settings` sets fps, optionally keeping timing in seconds.
- `moon_add_items` adds property tracks to an item that is already in the file.
- Skinned-mesh rigs: bones can be named wherever the tools take parts.
- The server installs and updates the Studio plugin when it starts, so adding
  the server to an MCP client is the only install step.
  `MOON_MCP_NO_PLUGIN_INSTALL=1` turns this off.

### Changed

- Results are compact JSON and long lists are opt-in. On a 6-second cutscene
  with 319 keyframes: `moon_scene` about 1,800 tokens (was 9,400), with values
  4,200 (was 35,000); a foot-sliding check with `moon_sample` 280 (was
  10,900); `moon_camera_path` 520 (was 4,600); `moon_motion_trail` 230 (was
  4,900); `moon_status` 250 (was 560).
- `moon_sample` and `moon_preview_pose` report positions only for the `parts`
  named. `moon_camera_path` returns path samples only with `samples`, and
  `moon_motion_trail` returns speed per interval only with `detail`.
- `moon_scene` lists each track as `{frames, ease}` with parallel lists instead
  of one object per keyframe, and values in the shape `moon_set_keyframes`
  takes.
- `moon_status` returns a shorter summary.
- Captures put the Studio selection aside so its outlines stay out of images.
- The documented install pins the release tag.

## 0.1.0

First release.
