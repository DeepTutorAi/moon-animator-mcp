--@prelude
--@targets
--@measure
-- Finds joint rotations that bring one part of a rig to a target point, by
-- posing the real rig and measuring it (pattern search, no keyframes created).
-- The animated values are written back before returning.
requireFile()

local itemObject = findItem(ARGS.item)
local instance = measurable(itemObject)

local endPart = findPart(instance, ARGS.endPart)
if not endPart then
	fail(string.format("end_part '%s' is not a part of %s", tostring(ARGS.endPart), instance:GetFullName()))
end
local reference, referenceOwner = relativePart(instance, ARGS.relativeTo, ARGS.relativeToItem)
local settlePose = poseSettler(instance, referenceOwner)
local goal = numbers(ARGS.target, 3, "target")
local goalPoint = Vector3.new(goal[1], goal[2], goal[3])

local savedFrame = LS.SliderFrame
if ARGS.frame ~= nil then
	LS.PlaybackHandler:Stop()
	LS:SetSliderFrame(ARGS.frame)
end
settlePose()

-- Each solved joint starts from its animated pose on this frame.
local joints = {}
for _, spec in ipairs(ARGS.joints) do
	local track, isRig = findTrack(itemObject, spec)
	if not isRig then
		fail("reach solving takes joints, not properties")
	end
	local isBone = Moon.objIsType(track, "BoneTrack")
	local current = track:get_prop()
	local pose = if isBone then current else current:ToObjectSpace(track.defaultValue)
	local rx, ry, rz = pose:ToEulerAnglesXYZ()
	local axes = string.lower(spec.axes or "xyz")
	local entry = {
		name = track.name,
		track = track,
		isBone = isBone,
		position = pose.Position,
		angles = { math.deg(rx), math.deg(ry), math.deg(rz) },
		free = { string.find(axes, "x", 1, true) ~= nil, string.find(axes, "y", 1, true) ~= nil, string.find(axes, "z", 1, true) ~= nil },
		min = spec.min,
		max = spec.max,
	}
	entry.start = table.clone(entry.angles)
	table.insert(joints, entry)
end

local function apply(entry)
	local a = entry.angles
	local pose = CFrame.new(entry.position) * CFrame.fromEulerAnglesXYZ(math.rad(a[1]), math.rad(a[2]), math.rad(a[3]))
	entry.track:set_prop(if entry.isBone then pose else entry.track.defaultValue * pose:Inverse())
end

-- Measures the rig as it stands; call settlePose first after changing a joint.
local function distance()
	local target = if reference then worldCFrame(reference):PointToWorldSpace(goalPoint) else goalPoint
	return (worldCFrame(endPart).Position - target).Magnitude
end

-- Distance to the target plus a small cost for leaving the starting pose, so
-- that among equally good solutions the one closest to the current pose wins.
local function cost()
	local drift = 0
	for _, entry in ipairs(joints) do
		for axis = 1, 3 do
			drift += math.abs(entry.angles[axis] - entry.start[axis])
		end
	end
	return distance() + drift * 0.0005
end

local ok, err = pcall(function()
	local best = cost()
	for _, step in ipairs({ 24, 12, 6, 3, 1.5, 0.75, 0.4 }) do
		for _ = 1, 6 do
			local improved = false
			for _, entry in ipairs(joints) do
				for axis = 1, 3 do
					if entry.free[axis] then
						local original = entry.angles[axis]
						for _, delta in ipairs({ step, -step }) do
							local candidate = original + delta
							local low = entry.min and entry.min[axis]
							local high = entry.max and entry.max[axis]
							if (low == nil or candidate >= low) and (high == nil or candidate <= high) then
								entry.angles[axis] = candidate
								apply(entry)
								settlePose()
								local value = cost()
								if value < best - 1e-5 then
									best = value
									original = candidate
									improved = true
								else
									entry.angles[axis] = original
									apply(entry)
								end
							end
						end
					end
				end
			end
			if not improved then
				break
			end
		end
	end
end)

if ok then
	settlePose()
end
local remaining = if ok then distance() else nil
local solved = {}
for _, entry in ipairs(joints) do
	table.insert(solved, {
		joint = entry.name,
		rotation = { round(entry.angles[1]), round(entry.angles[2]), round(entry.angles[3]) },
		position = { round(entry.position.X), round(entry.position.Y), round(entry.position.Z) },
	})
end

-- Put the animated values back: nothing here is a keyframe.
for _, entry in ipairs(joints) do
	entry.track.previous_value = nil
end
LS:SetSliderFrame(savedFrame)
for _, entry in ipairs(joints) do
	entry.track:_Update(LS.SliderFrame)
end
if not ok then
	error(err, 0)
end

return HttpService:JSONEncode({
	frame = if ARGS.frame ~= nil then ARGS.frame else savedFrame,
	endPart = ARGS.endPart,
	relativeTo = if reference then reference:GetFullName() else "world",
	distanceToTarget = round(remaining),
	reached = remaining <= (ARGS.tolerance or 0.05),
	joints = solved,
})
