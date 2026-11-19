--@prelude
--@targets
--@measure
-- Distance between two points on any items of the file over frames, such as a
-- fist and an opponent's head. Scrubs the real timeline, then puts it back.
requireFile()

-- A point is a part (or bone) of an item, optionally shifted by an offset in
-- that part's local space.
local function resolve(spec, label)
	local instance = measurable(findItem(spec.item))
	local part = findPart(instance, spec.part)
	if not part then
		fail(string.format("%s: '%s' is not a part or bone of %s", label, tostring(spec.part), instance:GetFullName()))
	end
	local o = if spec.offset ~= nil then numbers(spec.offset, 3, label .. ".offset") else { 0, 0, 0 }
	return { instance = instance, part = part, offset = Vector3.new(o[1], o[2], o[3]) }
end

local from = resolve(ARGS.from, "from")
local to = resolve(ARGS.to, "to")
local settlePose = poseSettler(from.instance, to.instance)

-- How far `point` is from the surface of the part's box: positive outside,
-- negative (the depth) inside. Bones have no size, so there is no surface.
local function surfaceGap(part, cframe, point)
	if not part:IsA("BasePart") then
		return nil
	end
	local p = cframe:PointToObjectSpace(point)
	local half = part.Size / 2
	local nearest = Vector3.new(
		math.clamp(p.X, -half.X, half.X),
		math.clamp(p.Y, -half.Y, half.Y),
		math.clamp(p.Z, -half.Z, half.Z)
	)
	local outside = (p - nearest).Magnitude
	if outside > 0 then
		return outside
	end
	return -math.min(half.X - math.abs(p.X), half.Y - math.abs(p.Y), half.Z - math.abs(p.Z))
end

local function measureNow()
	local a = worldCFrame(from.part):PointToWorldSpace(from.offset)
	local targetCFrame = worldCFrame(to.part)
	local b = targetCFrame:PointToWorldSpace(to.offset)
	local gap = surfaceGap(to.part, targetCFrame, a)
	local l = targetCFrame:PointToObjectSpace(a)
	return {
		LS.SliderFrame,
		round((a - b).Magnitude),
		if gap ~= nil then round(gap) else false,
		round(l.X),
		round(l.Y),
		round(l.Z),
	}
end

local camera = workspace.CurrentCamera
local samples = {}
if ARGS.frames then
	local savedFrame, savedCFrame, savedFov = LS.SliderFrame, camera.CFrame, camera.FieldOfView
	LS.PlaybackHandler:Stop()
	local ok, err = pcall(function()
		for index, frame in ipairs(ARGS.frames) do
			LS:SetSliderFrame(frame)
			settlePose()
			table.insert(samples, measureNow())
			if index % 120 == 0 then
				task.wait()
			end
		end
	end)
	LS:SetSliderFrame(savedFrame)
	camera.CameraType = Enum.CameraType.Scriptable
	camera.CFrame = savedCFrame
	camera.CameraType = Enum.CameraType.Custom
	camera.FieldOfView = savedFov
	if not ok then
		error(err, 0)
	end
else
	table.insert(samples, measureNow())
end

return HttpService:JSONEncode({
	fps = LS.FPS,
	from = from.part:GetFullName(),
	to = to.part:GetFullName(),
	toSize = if to.part:IsA("BasePart") then { round(to.part.Size.X), round(to.part.Size.Y), round(to.part.Size.Z) } else nil,
	samples = samples,
})
