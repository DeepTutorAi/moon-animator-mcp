-- Starts a viewing session: remembers the camera and timeline position and
-- optionally hides the Moon Animator window (the same as its Hide UI action)
-- and its screen effects. The session owns a restore function, which the
-- watchdog below runs if the session is never ended.
local Moon = _G.MoonGlobal
local win = if Moon and Moon.ready then Moon.Windows.MoonAnimator else nil
local layerSystem = if win then win.g_e.LayerSystem else nil
local camera = workspace.CurrentCamera
local CoreGui = game:GetService("CoreGui")
local effects = CoreGui:FindFirstChild("MoonAnimatorEffects")
-- Moon Animator's move/rotate gizmos are adornments kept in this folder.
local gizmos = CoreGui:FindFirstChild("KojoGizmos")

local stale = _G.MoonBridgeView
if stale then
	_G.MoonBridgeView = nil
	stale.restore({})
end

local state = {
	camera = { camera.CFrame:GetComponents() },
	fov = camera.FieldOfView,
	frame = if layerSystem and layerSystem.CurrentFile then layerSystem.SliderFrame else nil,
	hidUi = false,
	hidEffects = false,
	hidGizmos = false,
	posed = {},
	deadline = os.clock() + 30,
}

-- Puts back everything the session changed. `options.restoreFrame` and
-- `options.restoreCamera` also return to the remembered frame and camera.
function state.restore(options)
	local fileOpen = layerSystem ~= nil and layerSystem.CurrentFile ~= nil
	if state.hidUi then
		win:SetHidden(false)
	end
	if state.hidEffects and effects then
		effects.Enabled = true
	end
	if state.hidGizmos then
		gizmos.Parent = CoreGui
	end
	-- Previewed joints: drop the track's cached value so its animated value is written again.
	for _, track in ipairs(state.posed) do
		track.previous_value = nil
	end
	if options.restoreFrame and state.frame and fileOpen then
		layerSystem:SetSliderFrame(state.frame)
	end
	if fileOpen then
		for _, track in ipairs(state.posed) do
			track:_Update(layerSystem.SliderFrame)
		end
	end
	if options.restoreCamera then
		local current = workspace.CurrentCamera
		current.CameraType = Enum.CameraType.Scriptable
		current.CFrame = CFrame.new(table.unpack(state.camera))
		current.CameraType = Enum.CameraType.Custom
		current.FieldOfView = state.fov
	end
end

if ARGS.hideUi and win and win.Visible and win.UI.Visible then
	win:SetHidden(true)
	state.hidUi = true
end
if ARGS.hideUi and gizmos then
	gizmos.Parent = nil
	state.hidGizmos = true
end
if ARGS.hideEffects and effects and effects.Enabled then
	effects.Enabled = false
	state.hidEffects = true
end
_G.MoonBridgeView = state

task.spawn(function()
	while _G.MoonBridgeView == state do
		if os.clock() > state.deadline then
			_G.MoonBridgeView = nil
			state.restore({})
			break
		end
		task.wait(1)
	end
end)
return true
