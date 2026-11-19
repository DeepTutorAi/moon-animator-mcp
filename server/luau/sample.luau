--@prelude
--@targets
--@measure
-- Measures an item on the given frames (or as it is now): bounds, facing and
-- part positions. Scrubs the real timeline, then puts it back.
requireFile()

local instance = measurable(findItem(ARGS.item))
local wanted = partFilter(instance, ARGS.parts)
local relativeTo = relativePart(instance, ARGS.relativeTo)

local camera = workspace.CurrentCamera
local frames = {}

if ARGS.frames then
	local savedFrame, savedCFrame, savedFov = LS.SliderFrame, camera.CFrame, camera.FieldOfView
	LS.PlaybackHandler:Stop()
	local ok, err = pcall(function()
		for index, frame in ipairs(ARGS.frames) do
			LS:SetSliderFrame(frame)
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
	frames = frames,
})
