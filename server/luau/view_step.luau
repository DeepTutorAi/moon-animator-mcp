--@settle
-- One view of a session: optionally moves the Moon timeline to a frame and/or
-- poses the edit camera, waits for the viewport to redraw, and reports the view.
local state = _G.MoonBridgeView
if not state then
	error("MOON: no view session is active", 0)
end
state.deadline = os.clock() + 30

local Moon = _G.MoonGlobal
local layerSystem = if Moon and Moon.ready then Moon.Windows.MoonAnimator.g_e.LayerSystem else nil
local fileOpen = layerSystem ~= nil and layerSystem.CurrentFile ~= nil
local camera = workspace.CurrentCamera

if ARGS.frame ~= nil then
	if not fileOpen then
		error("MOON: a frame was requested but no Moon Animator file is open", 0)
	end
	layerSystem.PlaybackHandler:Stop()
	layerSystem:SetSliderFrame(ARGS.frame)
end

local request = ARGS.camera
if request then
	local position = Vector3.new(request.position[1], request.position[2], request.position[3])
	local cframe
	if request.lookAt then
		cframe = CFrame.lookAt(position, Vector3.new(request.lookAt[1], request.lookAt[2], request.lookAt[3]))
	else
		local r = request.rotation or { 0, 0, 0 }
		cframe = CFrame.new(position) * CFrame.fromEulerAnglesXYZ(math.rad(r[1]), math.rad(r[2]), math.rad(r[3]))
	end
	camera.CameraType = Enum.CameraType.Scriptable
	camera.CFrame = cframe
	camera.CameraType = Enum.CameraType.Custom
	if request.fov then
		camera.FieldOfView = request.fov
	end
end

local settled = settle(ARGS.settleFrames)

local function round(n)
	return math.floor(n * 1000 + 0.5) / 1000
end

-- Text currently shown by Moon Animator's Subtitles effect, if any.
local subtitle
local effects = game:GetService("CoreGui"):FindFirstChild("MoonAnimatorEffects")
local label = effects and effects:FindFirstChild("Subtitles")
if label and label:IsA("TextLabel") and label.Visible and label.Text ~= "" then
	subtitle = label.Text
	if label.MaxVisibleGraphemes >= 0 then
		local cut = utf8.offset(subtitle, label.MaxVisibleGraphemes + 1)
		if cut then
			subtitle = string.sub(subtitle, 1, cut - 1)
		end
	end
	if subtitle == "" then
		subtitle = nil
	end
end

local size = camera.ViewportSize
local rx, ry, rz = camera.CFrame:ToEulerAnglesXYZ()
return game:GetService("HttpService"):JSONEncode({
	viewport = { width = size.X, height = size.Y },
	frame = if fileOpen then layerSystem.SliderFrame else nil,
	fps = if fileOpen then layerSystem.FPS else nil,
	subtitle = subtitle,
	settled = settled,
	camera = {
		position = { round(camera.CFrame.X), round(camera.CFrame.Y), round(camera.CFrame.Z) },
		rotation = { round(math.deg(rx)), round(math.deg(ry)), round(math.deg(rz)) },
		fov = round(camera.FieldOfView),
	},
})
