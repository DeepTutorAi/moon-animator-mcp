--@prelude
-- Samples the camera Moon Animator produces on every frame of a range by
-- scrubbing the timeline, so LookAtPart/AttachToPart are accounted for.
requireFile()

local cameraItem
for _, container in ipairs(LS.LayerHandler.LayerContainer.Objects) do
	if container.ItemObject.Path.ItemType == "Camera" then
		cameraItem = container.ItemObject
	end
end
if not cameraItem then
	error("MOON: the open file has no Camera item", 0)
end

local lastKeyframe = LS.LayerHandler:GetLastKeyframePosition()
local from = math.clamp(math.floor(ARGS.from or 0), 0, LS.length)
local to = math.clamp(math.floor(ARGS.to or lastKeyframe), from, LS.length)

local camera = workspace.CurrentCamera
local savedFrame, savedCFrame, savedFov = LS.SliderFrame, camera.CFrame, camera.FieldOfView
LS.PlaybackHandler:Stop()

-- Look vectors keep extra digits: per-frame rotation is derived from them.
local function precise(n)
	return math.floor(n * 1e7 + 0.5) / 1e7
end

local samples = table.create(to - from + 1)
local ok, err = pcall(function()
	for frame = from, to do
		LS:SetSliderFrame(frame)
		local cframe = camera.CFrame
		local look = cframe.LookVector
		table.insert(samples, {
			frame,
			round(cframe.X),
			round(cframe.Y),
			round(cframe.Z),
			precise(look.X),
			precise(look.Y),
			precise(look.Z),
			round(camera.FieldOfView),
		})
		if (frame - from) % 240 == 239 then
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

local tracks = {}
for name, track in pairs(cameraItem.PropertyMap) do
	local frames, eases = {}, {}
	for index, keyframe in ipairs(track.TrackItems.Objects) do
		frames[index] = keyframe.frm_pos
		eases[index] = easeLabel(keyframe.EaseMap[keyframe.width])
	end
	tracks[name] = { frames = frames, eases = eases, disabled = if track.Enabled then nil else true }
end

return HttpService:JSONEncode({
	fps = LS.FPS,
	from = from,
	to = to,
	lastKeyframe = lastKeyframe,
	samples = samples,
	tracks = tracks,
})
