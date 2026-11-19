--@prelude
--@targets
--@measure
-- Measures an item on the given frames (or as it is now): bounds, facing and
-- part positions. Scrubs the real timeline, then puts it back.
requireFile()

local instance = measurable(findItem(ARGS.item))
-- Positions are reported for the requested parts plus the ground-contact
-- parts, which default to every part with "foot" in its name.
local partNames, contactParts = {}, {}
for _, part in ipairs(visibleParts(instance)) do
	table.insert(partNames, part.Name)
	if ARGS.autoContacts and string.find(string.lower(part.Name), "foot", 1, true) then
		table.insert(contactParts, part.Name)
	end
end
table.sort(partNames)
for _, name in ipairs(ARGS.contactParts or {}) do
	table.insert(contactParts, name)
end
local requested = table.clone(contactParts)
for _, name in ipairs(ARGS.parts or {}) do
	table.insert(requested, name)
end
local wanted = partFilter(instance, requested)
local relativeTo, relativeOwner = relativePart(instance, ARGS.relativeTo, ARGS.relativeToItem)
local settlePose = poseSettler(instance, relativeOwner)

local camera = workspace.CurrentCamera
local frames = {}

if ARGS.frames then
	local savedFrame, savedCFrame, savedFov = LS.SliderFrame, camera.CFrame, camera.FieldOfView
	LS.PlaybackHandler:Stop()
	local ok, err = pcall(function()
		for index, frame in ipairs(ARGS.frames) do
			LS:SetSliderFrame(frame)
			settlePose()
			local entry = measure(instance, wanted, relativeTo)
			entry.frame = LS.SliderFrame
			table.insert(frames, entry)
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
	local entry = measure(instance, wanted, relativeTo)
	entry.frame = LS.SliderFrame
	table.insert(frames, entry)
end

local size = camera.ViewportSize
return HttpService:JSONEncode({
	item = itemPath(findItem(ARGS.item)),
	fps = LS.FPS,
	lastKeyframe = LS.LayerHandler:GetLastKeyframePosition(),
	facing = facingOf(instance),
	viewport = { width = size.X, height = size.Y },
	partNames = partNames,
	contactParts = contactParts,
	frames = frames,
})
