--@prelude
requireFile()

local hasCamera = false
for _, container in ipairs(LS.LayerHandler.LayerContainer.Objects) do
	if container.ItemObject.Path.ItemType == "Camera" then
		hasCamera = true
	end
end

return HttpService:JSONEncode({
	fps = LS.FPS,
	length = LS.length,
	lastKeyframe = LS.LayerHandler:GetLastKeyframePosition(),
	frame = LS.SliderFrame,
	hasCamera = hasCamera,
})
