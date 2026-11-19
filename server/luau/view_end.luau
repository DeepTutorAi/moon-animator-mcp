-- Ends a viewing session: brings back the Moon Animator window, its effects
-- and any previewed joints, and optionally the timeline position and camera.
local state = _G.MoonBridgeView
if not state then
	return true
end
_G.MoonBridgeView = nil
state.restore({ restoreFrame = ARGS.restoreFrame, restoreCamera = ARGS.restoreCamera })
return true
