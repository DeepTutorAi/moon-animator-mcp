--@prelude
--@targets
--@measure
-- Poses rig joints for the current view session without creating keyframes.
-- The session restores the animated values when it ends.
requireFile()
local state = _G.MoonBridgeView
if not state then
	fail("no view session is active")
end
state.deadline = os.clock() + 30

local itemObject = findItem(ARGS.item)
local instance = measurable(itemObject)

local plan = {}
for _, spec in ipairs(ARGS.joints) do
	local track, isRig = findTrack(itemObject, spec)
	if not isRig then
		fail("a pose preview takes joints, not properties")
	end
	table.insert(plan, { track = track, value = decodeValue(track, true, spec) })
end

for _, entry in ipairs(plan) do
	entry.track:set_prop(entry.value)
	table.insert(state.posed, entry.track)
end

local result = measure(instance, partFilter(instance, ARGS.parts), relativePart(instance, ARGS.relativeTo))
result.facing = facingOf(instance)
result.frame = LS.SliderFrame
local size = workspace.CurrentCamera.ViewportSize
result.viewport = { width = size.X, height = size.Y }
return HttpService:JSONEncode(result)
