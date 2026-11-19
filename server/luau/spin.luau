--@prelude
--@targets
-- Keys a joint rotation of any size (a flip, a pirouette, a twirl) as evenly
-- timed keyframes no more than 90 degrees apart, so Moon Animator's
-- shortest-path interpolation turns the intended way. One undo step.
requireEditable()

local itemObject = findItem(ARGS.item)
local track, isRig = findTrack(itemObject, { joint = ARGS.joint })
if not isRig then
	fail("a spin needs a rig joint")
end

local from, to = ARGS.fromFrame, ARGS.toFrame
if to <= from then
	fail("to_frame must be after from_frame")
end
if to > LS.length then
	fail(string.format("frame %d is beyond the timeline length %d; extend it with moon_settings first", to, LS.length))
end

local AXES = { x = Vector3.xAxis, y = Vector3.yAxis, z = Vector3.zAxis }
local axis = AXES[string.lower(ARGS.axis)]
if not axis then
	fail("axis must be x, y or z")
end

local PROFILES = {
	linear = function(t)
		return t
	end,
	["in"] = function(t)
		return t * t
	end,
	out = function(t)
		return 1 - (1 - t) * (1 - t)
	end,
	in_out = function(t)
		return t * t * (3 - 2 * t)
	end,
}
local profile = PROFILES[ARGS.easing or "linear"]
if not profile then
	fail("easing must be linear, in, out or in_out")
end

-- With the steepest profile a segment covers twice its share, so 45 degrees
-- per segment keeps every step at or below 90.
local segments = math.max(1, math.ceil(math.abs(ARGS.degrees) / 45))
if to - from < segments then
	fail(string.format("a %d degree spin needs at least %d frames", math.abs(ARGS.degrees), segments))
end

local isBone = Moon.objIsType(track, "BoneTrack")

-- The joint's pose (relative to rest) that the animation has on a frame.
local function poseAt(frame)
	local value
	if track.TrackItems.size == 0 then
		value = track.defaultValue
	elseif frame >= track.lastFrame then
		value = track.lastValue
	else
		value = track.BufferMap[frame]
	end
	if value == nil then
		value = track.defaultValue
	end
	return if isBone then value else value:ToObjectSpace(track.defaultValue)
end

local function vector(value, name)
	local v = numbers(value, 3, name)
	return Vector3.new(v[1], v[2], v[3])
end

local startPose = poseAt(from)
local startRotation = startPose.Rotation
if ARGS.startRotation then
	local r = numbers(ARGS.startRotation, 3, "start_rotation")
	startRotation = CFrame.fromEulerAnglesXYZ(math.rad(r[1]), math.rad(r[2]), math.rad(r[3]))
end
local positionFrom = if ARGS.positionFrom then vector(ARGS.positionFrom, "position_from") else startPose.Position
local positionTo = if ARGS.positionTo then vector(ARGS.positionTo, "position_to") else poseAt(to).Position
local arc = ARGS.arcHeight or 0
local localSpace = ARGS.space == "local"

local entries, report, used = {}, {}, {}
for index = 0, segments do
	local frame = from + math.floor((to - from) * index / segments + 0.5)
	if not used[frame] then
		used[frame] = true
		-- Use the time of the whole frame the key lands on, so the turn stays even.
		local t = (frame - from) / (to - from)
		local turn = CFrame.fromAxisAngle(axis, math.rad(ARGS.degrees * profile(t)))
		local rotation = if localSpace then startRotation * turn else turn * startRotation
		local position = positionFrom:Lerp(positionTo, t) + Vector3.new(0, 4 * arc * t * (1 - t), 0)
		local pose = CFrame.new(position) * rotation
		table.insert(entries, {
			track = track,
			frame = frame,
			value = if isBone then pose else track.defaultValue * pose:Inverse(),
		})
		table.insert(report, { frame = frame, degrees = round(ARGS.degrees * profile(t)) })
	end
end

-- Keyframes already between the ends would fight the spin; replace them.
local replaced = {}
for _, keyframe in ipairs(track.TrackItems.Objects) do
	if keyframe.frm_pos > from and keyframe.frm_pos < to then
		table.insert(replaced, keyframe)
	end
end

local added, updated = applyKeyframes(entries, replaced)

return HttpService:JSONEncode({
	joint = track.name,
	keyframes = report,
	added = added,
	updated = updated,
	replacedExisting = #replaced,
	keyframeCount = LS.KeyframeCount,
})
