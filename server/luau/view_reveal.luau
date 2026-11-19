--@prelude
--@targets
--@measure
--@settle
-- Clears the line of sight to an item for the current view session: parts of
-- other objects that sit between the camera and the item are made invisible,
-- for this Studio client only, until the session ends. Nothing in the place
-- is changed or saved.
requireFile()
local state = _G.MoonBridgeView
if not state then
	fail("no view session is active")
end
state.deadline = os.clock() + 30

local MAX_HIDDEN = 40
local instance = measurable(findItem(ARGS.item))
local origin = workspace.CurrentCamera.CFrame.Position
-- Only scenery is hidden. Other items of the file are part of the action (an
-- opponent, a prop on the floor), so the rays pass through them.
local ignore = {}
for _, container in ipairs(LS.LayerHandler.LayerContainer.Objects) do
	local other = container.ItemObject.Path:GetItem()
	if other and other:IsDescendantOf(workspace) then
		table.insert(ignore, other)
	end
end
table.insert(ignore, instance)
local params = RaycastParams.new()
params.FilterType = Enum.RaycastFilterType.Exclude
params.IgnoreWater = true

local function hide(target)
	table.insert(state.hidden, { target = target, modifier = target.LocalTransparencyModifier })
	target.LocalTransparencyModifier = 1
end

local hidden, terrainInTheWay = {}, false
for _, part in ipairs(visibleParts(instance)) do
	local direction = part.Position - origin
	while #hidden < MAX_HIDDEN do
		params.FilterDescendantsInstances = ignore
		local hit = workspace:Raycast(origin, direction, params)
		if not hit then
			break
		end
		local blocker = hit.Instance
		if blocker:IsA("Terrain") then
			terrainInTheWay = true
			break
		end
		table.insert(ignore, blocker)
		hide(blocker)
		for _, child in ipairs(blocker:GetChildren()) do
			if child:IsA("Decal") then
				hide(child)
			end
		end
		table.insert(hidden, blocker:GetFullName())
	end
end

local settled = if #hidden > 0 then settle(ARGS.settleFrames) else true
return HttpService:JSONEncode({
	hidden = hidden,
	terrainInTheWay = terrainInTheWay,
	settled = settled,
})
