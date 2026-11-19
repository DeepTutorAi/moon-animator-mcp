--@prelude
--@targets
--@measure
-- Follows parts of an item across frames: where each is in the world and
-- where it lands on screen from a given camera. Scrubs the real timeline,
-- then puts the timeline and camera back.
requireFile()

local instance = measurable(findItem(ARGS.item))
local settlePose = poseSettler(instance)

local parts = {}
if ARGS.parts then
	for _, name in ipairs(ARGS.parts) do
		local part = findPart(instance, name)
		if not part then
			fail(string.format("'%s' is not a part or bone of %s", tostring(name), instance:GetFullName()))
		end
		table.insert(parts, part)
	end
else
	-- Default to the ends of the limbs and the head: they carry the motion.
	local function carriesMotion(candidate)
		local name = string.lower(candidate.Name)
		return string.find(name, "hand", 1, true) or string.find(name, "foot", 1, true) or name == "head"
	end
	for _, part in ipairs(visibleParts(instance)) do
		if carriesMotion(part) then
			table.insert(parts, part)
		end
	end
	if #parts == 0 then
		for _, descendant in ipairs(instance:GetDescendants()) do
			if descendant:IsA("Bone") and carriesMotion(descendant) then
				table.insert(parts, descendant)
			end
		end
	end
	table.sort(parts, function(a, b)
		return a.Name < b.Name
	end)
	if #parts == 0 then
		table.insert(parts, referencePart(instance))
	end
	while #parts > 6 do
		table.remove(parts)
	end
end

local camera = workspace.CurrentCamera
local savedFrame, savedCFrame, savedFov = LS.SliderFrame, camera.CFrame, camera.FieldOfView
local view = ARGS.camera
local viewCFrame = CFrame.lookAt(
	Vector3.new(view.position[1], view.position[2], view.position[3]),
	Vector3.new(view.lookAt[1], view.lookAt[2], view.lookAt[3])
)

LS.PlaybackHandler:Stop()
local tracks = {}
for _, part in ipairs(parts) do
	tracks[part.Name] = {}
end

local ok, err = pcall(function()
	for index, frame in ipairs(ARGS.frames) do
		LS:SetSliderFrame(frame)
		settlePose()
		-- The file's own camera track moves the camera on every frame; put ours back.
		camera.CameraType = Enum.CameraType.Scriptable
		camera.CFrame = viewCFrame
		camera.CameraType = Enum.CameraType.Custom
		camera.FieldOfView = view.fov
		for _, part in ipairs(parts) do
			local position = worldCFrame(part).Position
			local screen = camera:WorldToViewportPoint(position)
			table.insert(tracks[part.Name], {
				LS.SliderFrame,
				round(position.X),
				round(position.Y),
				round(position.Z),
				round(screen.X),
				round(screen.Y),
				screen.Z > 0,
			})
		end
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

local order = {}
for _, part in ipairs(parts) do
	table.insert(order, part.Name)
end
local size = camera.ViewportSize
return HttpService:JSONEncode({
	fps = LS.FPS,
	viewport = { width = size.X, height = size.Y },
	parts = order,
	tracks = tracks,
})
